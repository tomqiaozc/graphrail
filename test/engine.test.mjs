import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { advance, finalize, gotoNode, route, transition, validateChain } from "../lib/engine.mjs";
import { recordTest, sealNode, validateHandshake } from "../lib/evidence.mjs";
import { createSession, handshakePath, readState } from "../lib/session.mjs";
import { readJson } from "../lib/util.mjs";

function project() { return mkdtempSync(resolve(tmpdir(), "graphrail-engine-")); }
function artifact(dir, name, content) { const path = resolve(dir, name); writeFileSync(path, content); return path; }

test("review happy path seals independent evidence and finalizes", () => {
  const root = project();
  const { dir } = createSession("review", "Inspect change", root);
  const first = artifact(root, "first.md", "Finding A with evidence\nVERDICT: PASS");
  const second = artifact(root, "second.md", "Finding B with different evidence\nVERDICT: PASS");
  sealNode(dir, [
    { type: "evaluation", path: first, actor: "security", agentRunId: "agent-security-1" },
    { type: "evaluation", path: second, actor: "tester", agentRunId: "agent-tester-2" },
  ]);
  assert.equal(advance(dir).next, "gate");
  assert.equal(transition(dir, "PASS").status, "ready-to-finalize");
  assert.equal(existsSync(handshakePath(dir, "gate", 2)), true);
  assert.equal(finalize(dir).status, "completed");
  assert.equal(validateChain(dir).valid, true);
});

function evidenceFor(root, dir, state) {
  const node = state.template.nodes[state.currentNode];
  const artifacts = [];
  if (node.kind === "review") {
    artifacts.push(
      { type: "evaluation", path: artifact(root, `${state.currentRun}-review-a.md`, `review A for ${state.currentNode}\nVERDICT: PASS`), actor: "skeptic-owner", agentRunId: `agent-a-${state.currentRun}` },
      { type: "evaluation", path: artifact(root, `${state.currentRun}-review-b.md`, `review B for ${state.currentNode}\nVERDICT: PASS`), actor: "tester", agentRunId: `agent-b-${state.currentRun}` },
    );
  }
  if ((node.evidence || []).includes("test-plan")) {
    artifacts.push({ type: "test-plan", path: artifact(root, `${state.currentRun}-plan.md`, "test plan with negative and boundary cases"), actor: "tester" });
  }
  if (node.kind === "plan" || node.kind === "work") {
    artifacts.push({ type: "deliverable", path: artifact(root, `${state.currentRun}-${state.currentNode}.md`, `deliverable for ${state.currentNode}`), actor: "engineer" });
  }
  return artifacts;
}

function drivePassFlow(name) {
  const root = project();
  const { dir } = createSession(name, `Drive ${name}`, root);
  while (true) {
    const state = readState(dir);
    if (state.status === "ready-to-finalize") break;
    const node = state.template.nodes[state.currentNode];
    if (node.kind === "gate") advance(dir);
    else if (node.kind === "execute") {
      const recorded = recordTest(dir, "node --version", { exitCode: 0, durationMs: 1, stdout: "ok", stderr: "" });
      sealNode(dir, [{ type: "test-result", path: recorded.path, actor: "graphrail" }]);
      advance(dir);
    } else {
      sealNode(dir, evidenceFor(root, dir, state));
      advance(dir);
    }
  }
  assert.equal(finalize(dir).status, "completed");
  assert.equal(validateChain(dir).valid, true);
}

for (const name of ["quick", "review", "build", "verify"]) {
  test(`${name} built-in flow completes its full PASS path`, () => drivePassFlow(name));
}

test("review rejects self-review, duplicate actors, and duplicate content", () => {
  const root = project();
  const { dir } = createSession("review", "Inspect", root);
  const first = artifact(root, "a.md", "same\nVERDICT: PASS");
  const second = artifact(root, "b.md", "same\nVERDICT: PASS");
  assert.throws(() => sealNode(dir, [
    { type: "evaluation", path: first, actor: "one", agentRunId: "agent-same-1" },
    { type: "evaluation", path: second, actor: "one", agentRunId: "agent-same-2" },
  ]), /distinct actors|distinct content/);
});

test("artifact tampering invalidates exact run evidence", () => {
  const root = project();
  const { dir } = createSession("review", "Inspect", root);
  const first = artifact(root, "a.md", "first\nVERDICT: PASS");
  const second = artifact(root, "b.md", "second\nVERDICT: PASS");
  sealNode(dir, [
    { type: "evaluation", path: first, actor: "one", agentRunId: "agent-one-1" },
    { type: "evaluation", path: second, actor: "two", agentRunId: "agent-two-2" },
  ]);
  const sealed = handshakePath(dir, "review", 1);
  const handshake = readJson(sealed);
  writeFileSync(resolve(sealed, "..", handshake.artifacts[0].path), "tampered");
  assert.match(validateHandshake(dir, handshake, "review", "run_1").join("\n"), /hash mismatch/);
  assert.throws(() => advance(dir), /invalid/);
});

test("state tampering is detected", () => {
  const root = project();
  const { dir } = createSession("review", "Inspect", root);
  const path = resolve(dir, "state.json");
  const state = readJson(path);
  state.currentNode = "gate";
  writeFileSync(path, JSON.stringify(state));
  assert.throws(() => readState(dir), /signature mismatch/);
});

test("execute evidence requires signed command provenance", () => {
  const root = project();
  const flow = resolve(root, "execute.json");
  writeFileSync(flow, JSON.stringify({
    schemaVersion: 1, id: "execute-only", entry: "check",
    nodes: { check: { kind: "execute", evidence: ["test-result"] }, gate: { kind: "gate" } },
    transitions: { check: { PASS: "gate" }, gate: { PASS: null, FAIL: "check" } },
    limits: { maxEdgeVisits: 2, maxNodeVisits: 3, maxSteps: 5 },
  }));
  const { dir } = createSession(flow, "Check", root);
  const recorded = recordTest(dir, "node --version", { exitCode: 0, durationMs: 1, stdout: "ok", stderr: "" });
  sealNode(dir, [{ type: "test-result", path: recorded.path, actor: "graphrail" }]);
  assert.equal(advance(dir).next, "gate");
  assert.equal(transition(dir, "PASS").status, "ready-to-finalize");
});

test("stale handshake cannot authorize a later run", () => {
  const root = project();
  const { dir } = createSession("review", "Inspect", root);
  const first = artifact(root, "a.md", "first\nVERDICT: PASS");
  const second = artifact(root, "b.md", "second\nVERDICT: PASS");
  sealNode(dir, [{ type: "evaluation", path: first, actor: "one", agentRunId: "agent-one-1" }, { type: "evaluation", path: second, actor: "two", agentRunId: "agent-two-2" }]);
  gotoNode(dir, "review");
  assert.throws(() => advance(dir), /run_2|not sealed/);
});

test("gate mechanically aggregates evaluation verdicts", () => {
  const root = project();
  const { dir } = createSession("review", "Inspect", root);
  const first = artifact(root, "a.md", "Needs a repair\nVERDICT: ITERATE");
  const second = artifact(root, "b.md", "No blocking issue\nVERDICT: PASS");
  sealNode(dir, [{ type: "evaluation", path: first, actor: "one", agentRunId: "agent-one-1" }, { type: "evaluation", path: second, actor: "two", agentRunId: "agent-two-2" }], "PASS");
  advance(dir);
  assert.throws(() => transition(dir, "PASS"), /requires ITERATE/);
  assert.equal(advance(dir).next, null);
});

test("review node cannot encode the aggregate verdict in its handshake", () => {
  const root = project();
  const { dir } = createSession("review", "Inspect", root);
  const first = artifact(root, "a.md", "Issue\nVERDICT: FAIL");
  const second = artifact(root, "b.md", "Issue confirmed\nVERDICT: FAIL");
  assert.throws(() => sealNode(dir, [{ type: "evaluation", path: first, actor: "one", agentRunId: "agent-one-1" }, { type: "evaluation", path: second, actor: "two", agentRunId: "agent-two-2" }], "FAIL"), /completion verdict must be PASS/);
});

test("review rejects missing or duplicate subagent run IDs", () => {
  const root = project();
  const { dir } = createSession("review", "Inspect", root);
  const first = artifact(root, "a.md", "A\nVERDICT: PASS");
  const second = artifact(root, "b.md", "B\nVERDICT: PASS");
  assert.throws(() => sealNode(dir, [
    { type: "evaluation", path: first, actor: "one", agentRunId: "agent-shared" },
    { type: "evaluation", path: second, actor: "two", agentRunId: "agent-shared" },
  ]), /distinct subagent run IDs/);
});

test("work nodes cannot complete without a deliverable", () => {
  const root = project();
  const { dir } = createSession("quick", "Build", root);
  assert.throws(() => sealNode(dir, [], "PASS"), /deliverable artifact/);
});

test("failing test result cannot be sealed as PASS", () => {
  const root = project();
  const flow = resolve(root, "execute.json");
  writeFileSync(flow, JSON.stringify({
    schemaVersion: 1, id: "failing-check", entry: "check",
    nodes: { check: { kind: "execute", evidence: ["test-result"] } },
    transitions: { check: { PASS: null, FAIL: null } },
    limits: { maxEdgeVisits: 1, maxNodeVisits: 1, maxSteps: 1 },
  }));
  const { dir } = createSession(flow, "Check", root);
  const recorded = recordTest(dir, "false", { exitCode: 1, durationMs: 1, stdout: "", stderr: "failed" });
  assert.throws(() => sealNode(dir, [{ type: "test-result", path: recorded.path, actor: "graphrail" }], "PASS"), /cannot support PASS/);
});

test("edge, node, and total budgets are enforced", () => {
  const root = project();
  const flow = resolve(root, "loop.json");
  writeFileSync(flow, JSON.stringify({
    schemaVersion: 1, id: "bounded", entry: "work",
    nodes: { work: { kind: "work" } },
    transitions: { work: { ITERATE: "work", PASS: null } },
    limits: { maxEdgeVisits: 1, maxNodeVisits: 2, maxSteps: 2 },
  }));
  const { dir } = createSession(flow, "Loop", root);
  const first = artifact(root, "first-work.md", "first attempt");
  sealNode(dir, [{ type: "deliverable", path: first, actor: "engineer" }], "ITERATE");
  advance(dir);
  const second = artifact(root, "second-work.md", "second attempt");
  sealNode(dir, [{ type: "deliverable", path: second, actor: "engineer" }], "ITERATE");
  assert.equal(route(dir, "ITERATE").allowed, false);
  assert.throws(() => advance(dir), /budget exhausted/);
});
