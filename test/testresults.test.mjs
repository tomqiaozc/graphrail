import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseTestOutput, runMutationProbe, workingTreeHash } from "../lib/testresults.mjs";

const TAP_OUTPUT = [
  "TAP version 13",
  "ok 1 - adds numbers",
  "ok 2 - handles negative",
  "not ok 3 - rejects zero",
  "# tests 3",
  "# pass 2",
  "# fail 1",
].join("\n");

const JEST_JSON = JSON.stringify({
  numTotalTestSuites: 2,
  numPassedTestSuites: 2,
  numTotalTests: 5,
  numPassedTests: 4,
  numFailedTests: 1,
  numPendingTests: 1,
  numTodoTests: 0,
});

const JUNIT_XML = `<?xml version="1.0"?>
<testsuite name="suite" tests="4" failures="1" errors="1" skipped="1">
  <testcase name="a"/>
  <testcase name="b"/>
  <testcase name="c"/>
  <testcase name="d"/>
</testsuite>`;

const GRAPHRAIL_JSON = JSON.stringify({
  schemaVersion: 1,
  testsDiscovered: 6,
  testsExecuted: 6,
  testsPassed: 6,
  testsFailed: 0,
  testPlanCoverage: ["AUTH-NEG-01", "BOUNDARY-02"],
});

test("parses TAP output with summary header", () => {
  const parsed = parseTestOutput(TAP_OUTPUT);
  assert.equal(parsed.structured, true);
  assert.equal(parsed.format, "tap");
  assert.equal(parsed.testsDiscovered, 3);
  assert.equal(parsed.testsExecuted, 3);
  assert.equal(parsed.testsPassed, 2);
  assert.equal(parsed.testsFailed, 1);
});

test("parses Jest/Vitest JSON aggregate", () => {
  const parsed = parseTestOutput(JEST_JSON);
  assert.equal(parsed.structured, true);
  assert.equal(parsed.format, "jest-vitest");
  assert.equal(parsed.testsDiscovered, 5);
  assert.equal(parsed.testsExecuted, 4); // 5 - 1 pending
  assert.equal(parsed.testsPassed, 4);
  assert.equal(parsed.testsFailed, 1);
});

test("parses JUnit XML with numeric attributes", () => {
  const parsed = parseTestOutput(JUNIT_XML, { format: "junit" });
  assert.equal(parsed.structured, true);
  assert.equal(parsed.format, "junit");
  assert.equal(parsed.testsDiscovered, 4);
  assert.equal(parsed.testsExecuted, 3); // 4 - 1 skipped
  assert.equal(parsed.testsPassed, 1); // 4 - 1 skipped - 1 failure - 1 error
  assert.equal(parsed.testsFailed, 2);
});

test("parses the GraphRail JSON contract and keeps testPlanCoverage", () => {
  const parsed = parseTestOutput(GRAPHRAIL_JSON);
  assert.equal(parsed.structured, true);
  assert.equal(parsed.format, "graphrail-json");
  assert.deepEqual(parsed.testPlanCoverage, ["AUTH-NEG-01", "BOUNDARY-02"]);
});

test("unparseable output fails closed without structured stats", () => {
  const parsed = parseTestOutput("some random build output\nwarning: nothing here");
  assert.equal(parsed.structured, false);
  assert.equal(parsed.testsExecuted, undefined);
});

test("explicit graphrail-json format parses a file with only a coverage array", () => {
  const parsed = parseTestOutput(JSON.stringify({ testsDiscovered: 2, testsExecuted: 2, testsPassed: 2, testsFailed: 0, testPlanCoverage: ["X"] }), { format: "graphrail-json" });
  assert.equal(parsed.structured, true);
  assert.deepEqual(parsed.testPlanCoverage, ["X"]);
});

test("workingTreeHash is stable and ignores .git/.graphrail/node_modules", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "graphrail-tree-"));
  writeFileSync(resolve(dir, "a.txt"), "a");
  mkdirSync(resolve(dir, ".git"), { recursive: true });
  writeFileSync(resolve(dir, ".git", "HEAD"), "ref"); // .git should be ignored
  mkdirSync(resolve(dir, "node_modules", "dep"), { recursive: true });
  writeFileSync(resolve(dir, "node_modules", "dep", "index.js"), "dep");
  mkdirSync(resolve(dir, ".graphrail"), { recursive: true });
  writeFileSync(resolve(dir, ".graphrail", "state.json"), "{}");
  const first = workingTreeHash(dir);
  writeFileSync(resolve(dir, "b.txt"), "b");
  const second = workingTreeHash(dir);
  assert.notEqual(first, second, "adding a file must change the tree hash");
  writeFileSync(resolve(dir, ".git", "config"), "changed"); // ignored -> no change
  assert.equal(second, workingTreeHash(dir), "ignored dir changes must not affect hash");
});

function testProject() {
  const dir = mkdtempSync(resolve(tmpdir(), "graphrail-probe-"));
  mkdirSync(resolve(dir, "lib"), { recursive: true });
  mkdirSync(resolve(dir, "test"), { recursive: true });
  writeFileSync(resolve(dir, "lib", "calc.mjs"), "export function add(a, b) { return a + b; }\n");
  return dir;
}

test("mutation probe detects a real test suite and restores the file", () => {
  const dir = testProject();
  writeFileSync(resolve(dir, "test", "calc.test.mjs"), `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../lib/calc.mjs";\ntest("adds", () => assert.equal(add(1, 2), 3));\n`);
  const result = runMutationProbe(resolve(dir, "lib", "calc.mjs"), "node --test", dir);
  assert.equal(result.detected, true, "a real suite must turn red on mutation");
  assert.equal(result.baselineExitCode, 0);
  assert.equal(result.probeExitCode, 1);
  // File must be restored byte-for-byte.
  assert.equal(readFileSync(resolve(dir, "lib", "calc.mjs"), "utf8"), "export function add(a, b) { return a + b; }\n");
});

test("mutation probe exposes a vacuous test suite that never touches the module", () => {
  const dir = testProject();
  writeFileSync(resolve(dir, "test", "vacuous.test.mjs"), `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("always true", () => assert.equal(true, true));\n`);
  const result = runMutationProbe(resolve(dir, "lib", "calc.mjs"), "node --test", dir);
  assert.equal(result.detected, false, "a vacuous suite stays green under mutation");
  assert.equal(result.baselineExitCode, 0);
  assert.equal(result.probeExitCode, 0);
});
