import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadTemplate, validateTemplate } from "../lib/templates.mjs";

const golden = {
  quick: ["build", "review", "gate-review", "test-design", "gate-test-design", "test-execute", "gate"],
  review: ["review", "gate"],
  build: ["brief", "build", "code-review", "gate-code-review", "test-design", "gate-test-design", "test-execute", "hotfix", "gate"],
  verify: ["acceptance", "gate-acceptance", "audit", "gate-audit", "e2e-user", "gate-e2e"],
};

test("built-in flows match their golden node order and validate", () => {
  for (const [name, nodes] of Object.entries(golden)) {
    const { template } = loadTemplate(name);
    assert.deepEqual(Object.keys(template.nodes), nodes);
    assert.deepEqual(validateTemplate(template), []);
  }
});

test("explicit review gates make FAIL and ITERATE edges reachable from evidence", () => {
  const quick = loadTemplate("quick").template;
  assert.equal(quick.transitions.review.PASS, "gate-review");
  assert.equal(quick.transitions["gate-review"].PASS, "test-design");
  assert.equal(quick.transitions["gate-review"].FAIL, "build");
  assert.equal(quick.transitions["gate-review"].ITERATE, "build");
  assert.equal(quick.transitions["gate-test-design"].PASS, "test-execute");
  assert.equal(quick.transitions["gate-test-design"].FAIL, "build");
  assert.equal(quick.transitions["gate-test-design"].ITERATE, "build");
  assert.equal(quick.transitions["test-execute"].FAIL, "build");
  assert.equal(quick.transitions["test-execute"].ITERATE, "build");
  const build = loadTemplate("build").template;
  assert.equal(build.transitions["code-review"].PASS, "gate-code-review");
  assert.equal(build.transitions["gate-code-review"].PASS, "test-design");
  assert.equal(build.transitions["gate-code-review"].FAIL, "build");
  assert.equal(build.transitions["gate-code-review"].ITERATE, "build");
});

test("custom flow loads through the same validator", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "graphrail-template-"));
  const path = resolve(dir, "custom.json");
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    id: "custom",
    entry: "work",
    nodes: { work: { kind: "work" }, gate: { kind: "gate" } },
    transitions: { work: { PASS: "gate" }, gate: { PASS: null, FAIL: "work" } },
    limits: { maxEdgeVisits: 2, maxNodeVisits: 3, maxSteps: 5 },
  }));
  assert.equal(loadTemplate(path).template.id, "custom");
});

test("validator rejects unsafe and incomplete graphs", () => {
  const base = {
    schemaVersion: 1,
    id: "bad",
    entry: "a",
    nodes: { a: { kind: "work" }, orphan: { kind: "review" } },
    transitions: { a: { PASS: "missing", MAYBE: null } },
    limits: { maxEdgeVisits: 0, maxNodeVisits: 2, maxSteps: 3 },
  };
  const errors = validateTemplate(base);
  assert.match(errors.join("\n"), /unknown|invalid verdict|unreachable|positive integer/);
});

test("prompt path cannot escape its template directory", () => {
  const template = {
    schemaVersion: 1,
    id: "unsafe-prompt",
    entry: "a",
    nodes: { a: { kind: "work", prompt: "../secret.md" } },
    transitions: { a: { PASS: null } },
    limits: { maxEdgeVisits: 1, maxNodeVisits: 1, maxSteps: 1 },
  };
  assert.match(validateTemplate(template, "/tmp/safe").join("\n"), /escapes/);
});

test("prompt reference must exist", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "graphrail-prompt-"));
  const template = {
    schemaVersion: 1,
    id: "missing-prompt",
    entry: "a",
    nodes: { a: { kind: "work", prompt: "./missing.md" } },
    transitions: { a: { PASS: null } },
    limits: { maxEdgeVisits: 1, maxNodeVisits: 1, maxSteps: 1 },
  };
  assert.match(validateTemplate(template, dir).join("\n"), /does not exist/);
});

test("executable template fields do not grant execution", () => {
  const template = {
    schemaVersion: 1,
    id: "declarative",
    entry: "a",
    nodes: { a: { kind: "work", command: "touch forbidden" } },
    transitions: { a: { PASS: null } },
    limits: { maxEdgeVisits: 1, maxNodeVisits: 1, maxSteps: 1 },
  };
  assert.match(validateTemplate(template).join("\n"), /command|unknown field/);
});
