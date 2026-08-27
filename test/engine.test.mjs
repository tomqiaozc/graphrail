import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { advance, finalize, gotoNode, route, transition, validateChain } from "../lib/engine.mjs";
import { recordTest, sealNode, validateHandshake } from "../lib/evidence.mjs";
import { createSession, handshakePath, readState } from "../lib/session.mjs";
import { bindClaudeAdapter, recordClaudeEvent } from "../lib/attestation.mjs";
import { fileHash, readJson } from "../lib/util.mjs";

function project() { return mkdtempSync(resolve(tmpdir(), "graphrail-engine-")); }
function artifact(dir, name, content) { const path = resolve(dir, name); writeFileSync(path, content); return path; }
let eventSequence = 0;
function attest(dir, artifacts, agentType) {
  const claudeSessionId = "00000000-0000-4000-8000-000000000001";
  bindClaudeAdapter(dir, claudeSessionId);
  for (const item of artifacts) {
    for (const [hookEventName, extra] of [
      ["SubagentStart", {}],
      ["PostToolUse", { toolName: "Write", artifactPath: item.path, artifactHash: fileHash(item.path) }],
      ["SubagentStop", {}],
    ]) {
      recordClaudeEvent(dir, { eventId: `event-${eventSequence += 1}`, hookEventName, claudeSessionId, agentId: item.agentRunId, agentType, ...extra });
    }
  }
  return artifacts;
}
function attestReviews(dir, artifacts) {
  return attest(dir, artifacts, "graphrail-reviewer");
}

test("review happy path seals independent evidence and finalizes", () => {
  const root = project();
  const { dir } = createSession("review", "Inspect change", root);
  const first = artifact(root, "first.md", "Finding A with evidence\nVERDICT: PASS");
  const second = artifact(root, "second.md", "Finding B with different evidence\nVERDICT: PASS");
  sealNode(dir, attestReviews(dir, [
    { type: "evaluation", path: first, actor: "security", agentRunId: "agent-security-1" },
    { type: "evaluation", path: second, actor: "tester", agentRunId: "agent-tester-2" },
  ]));
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
    const agentType = node.agentType || "graphrail-reviewer";
    artifacts.push(
      { type: "evaluation", path: artifact(root, `${state.currentRun}-review-a.md`, `review A for ${state.currentNode}\nVERDICT: PASS`), actor: "skeptic-owner", agentRunId: `agent-a-${state.currentRun}` },
      { type: "evaluation", path: artifact(root, `${state.currentRun}-review-b.md`, `review B for ${state.currentNode}\nVERDICT: PASS`), actor: "tester", agentRunId: `agent-b-${state.currentRun}` },
    );
    attest(dir, artifacts, agentType);
  }
  if ((node.evidence || []).includes("test-plan")) {
    const plan = { type: "test-plan", path: artifact(root, `${state.currentRun}-plan.md`, "test plan with negative and boundary cases"), actor: "tester", agentRunId: `agent-plan-${state.currentRun}` };
    artifacts.push(plan);
    attest(dir, [plan], "graphrail-test-designer");
  }
  if (node.kind === "plan" || node.kind === "work") {
    const deliverable = { type: "deliverable", path: artifact(root, `${state.currentRun}-${state.currentNode}.md`, `deliverable for ${state.currentNode}`), actor: "engineer", agentRunId: `agent-impl-${state.currentRun}` };
    artifacts.push(deliverable);
    attest(dir, [deliverable], "graphrail-implementer");
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
      const recorded = recordTest(dir, "node --version", { exitCode: 0, durationMs: 1, stdout: "ok", stderr: "", tests: { testsDiscovered: 3, testsExecuted: 3, testsPassed: 3, testsFailed: 0 } });
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
  sealNode(dir, attestReviews(dir, [
    { type: "evaluation", path: first, actor: "one", agentRunId: "agent-one-1" },
    { type: "evaluation", path: second, actor: "two", agentRunId: "agent-two-2" },
  ]));
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
  const recorded = recordTest(dir, "node --version", { exitCode: 0, durationMs: 1, stdout: "ok", stderr: "", tests: { testsDiscovered: 2, testsExecuted: 2, testsPassed: 2, testsFailed: 0 } });
  sealNode(dir, [{ type: "test-result", path: recorded.path, actor: "graphrail" }]);
  assert.equal(advance(dir).next, "gate");
  assert.equal(transition(dir, "PASS").status, "ready-to-finalize");
});

test("stale handshake cannot authorize a later run", () => {
  const root = project();
  const { dir } = createSession("review", "Inspect", root);
  const first = artifact(root, "a.md", "first\nVERDICT: PASS");
  const second = artifact(root, "b.md", "second\nVERDICT: PASS");
  sealNode(dir, attestReviews(dir, [{ type: "evaluation", path: first, actor: "one", agentRunId: "agent-one-1" }, { type: "evaluation", path: second, actor: "two", agentRunId: "agent-two-2" }]));
  gotoNode(dir, "review");
  assert.throws(() => advance(dir), /run_2|not sealed/);
});

test("gate mechanically aggregates evaluation verdicts", () => {
  const root = project();
  const { dir } = createSession("review", "Inspect", root);
  const first = artifact(root, "a.md", "Needs a repair\nVERDICT: ITERATE");
  const second = artifact(root, "b.md", "No blocking issue\nVERDICT: PASS");
  sealNode(dir, attestReviews(dir, [{ type: "evaluation", path: first, actor: "one", agentRunId: "agent-one-1" }, { type: "evaluation", path: second, actor: "two", agentRunId: "agent-two-2" }]), "PASS");
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

test("review rejects distinct model-authored IDs without trusted lifecycle events", () => {
  const root = project();
  const { dir } = createSession("review", "Inspect", root);
  const first = artifact(root, "a.md", "A\nVERDICT: PASS");
  const second = artifact(root, "b.md", "B\nVERDICT: PASS");
  assert.throws(() => sealNode(dir, [
    { type: "evaluation", path: first, actor: "one", agentRunId: "agent-model-one" },
    { type: "evaluation", path: second, actor: "two", agentRunId: "agent-model-two" },
  ]), /trusted Claude adapter binding/);
});

test("reviewer failure cannot be replaced by an unattested completion", () => {
  const root = project();
  const { dir } = createSession("review", "Inspect", root);
  const first = artifact(root, "a.md", "A\nVERDICT: PASS");
  const second = artifact(root, "b.md", "B\nVERDICT: PASS");
  const claudeSessionId = "00000000-0000-4000-8000-000000000001";
  bindClaudeAdapter(dir, claudeSessionId);
  for (const item of [
    { path: first, agentRunId: "agent-failed-one", failed: true },
    { path: second, agentRunId: "agent-good-two", failed: false },
  ]) {
    recordClaudeEvent(dir, { eventId: `event-${eventSequence += 1}`, hookEventName: "SubagentStart", claudeSessionId, agentId: item.agentRunId, agentType: "graphrail-reviewer" });
    recordClaudeEvent(dir, { eventId: `event-${eventSequence += 1}`, hookEventName: "PostToolUse", claudeSessionId, agentId: item.agentRunId, agentType: "graphrail-reviewer", toolName: "Write", artifactPath: item.path, artifactHash: fileHash(item.path) });
    recordClaudeEvent(dir, { eventId: `event-${eventSequence += 1}`, hookEventName: item.failed ? "StopFailure" : "SubagentStop", claudeSessionId, agentId: item.agentRunId, agentType: "graphrail-reviewer" });
  }
  assert.throws(() => sealNode(dir, [
    { type: "evaluation", path: first, actor: "one", agentRunId: "agent-failed-one" },
    { type: "evaluation", path: second, actor: "two", agentRunId: "agent-good-two" },
  ]), /no trusted completion|failed before trusted completion/);
});

test("general-purpose agents cannot satisfy independent review provenance", () => {
  const root = project();
  const { dir } = createSession("review", "Inspect", root);
  const first = artifact(root, "a.md", "A\nVERDICT: PASS");
  const second = artifact(root, "b.md", "B\nVERDICT: PASS");
  const artifacts = [
    { type: "evaluation", path: first, actor: "one", agentRunId: "agent-general-one" },
    { type: "evaluation", path: second, actor: "two", agentRunId: "agent-general-two" },
  ];
  const claudeSessionId = "00000000-0000-4000-8000-000000000001";
  bindClaudeAdapter(dir, claudeSessionId);
  for (const item of artifacts) {
    for (const [hookEventName, extra] of [
      ["SubagentStart", {}],
      ["PostToolUse", { toolName: "Write", artifactPath: item.path, artifactHash: fileHash(item.path) }],
      ["SubagentStop", {}],
    ]) {
      recordClaudeEvent(dir, { eventId: `event-${eventSequence += 1}`, hookEventName, claudeSessionId, agentId: item.agentRunId, agentType: "general-purpose", ...extra });
    }
  }
  assert.throws(() => sealNode(dir, artifacts), /not a trusted graphrail-reviewer/);
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
  const recorded = recordTest(dir, "false", { exitCode: 1, durationMs: 1, stdout: "", stderr: "failed", tests: { testsDiscovered: 1, testsExecuted: 1, testsPassed: 0, testsFailed: 1 } });
  assert.throws(() => sealNode(dir, [{ type: "test-result", path: recorded.path, actor: "graphrail" }], "PASS"), /cannot support PASS/);
});

test("execute with requiresTestPlanHash binds the authoritative test-plan artifact", () => {
  const root = project();
  const flow = resolve(root, "plan-bound.json");
  writeFileSync(flow, JSON.stringify({
    schemaVersion: 1, id: "plan-bound", entry: "design",
    nodes: {
      design: { kind: "review", evidence: ["evaluation", "test-plan"], minReviewers: 1, agentType: "graphrail-test-designer" },
      execute: { kind: "execute", evidence: ["test-result"], requiresTestPlanHash: true },
      gate: { kind: "gate" },
    },
    transitions: { design: { PASS: "execute" }, execute: { PASS: "gate" }, gate: { PASS: null } },
    limits: { maxEdgeVisits: 2, maxNodeVisits: 3, maxSteps: 5 },
  }));
  const { dir } = createSession(flow, "PlanBind", root);
  // Seal the design node: one evaluation + one test-plan.
  const plan = { type: "test-plan", path: artifact(root, "plan.md", "plan with AUTH-NEG-01\nVERDICT: PASS"), actor: "tester", agentRunId: "agent-designer-1" };
  const evalArtifact = { type: "evaluation", path: artifact(root, "eval.md", "design good\nVERDICT: PASS"), actor: "skeptic-owner", agentRunId: "agent-designer-2" };
  attest(dir, [plan], "graphrail-test-designer");
  attest(dir, [evalArtifact], "graphrail-test-designer");
  sealNode(dir, [plan, evalArtifact]);
  advance(dir); // -> execute
  // Record a test with the CORRECT testPlanHash (plan's sha256).
  const planSealed = readJson(handshakePath(dir, "design", 1));
  const planArtifact = planSealed.artifacts.find((entry) => entry.type === "test-plan");
  const good = recordTest(dir, "node --test", { exitCode: 0, tests: { testsDiscovered: 2, testsExecuted: 2, testsPassed: 2, testsFailed: 0 }, testPlanHash: planArtifact.sha256 });
  sealNode(dir, [{ type: "test-result", path: good.path, actor: "graphrail" }]);
  assert.equal(advance(dir).next, "gate");
  // A wrong testPlanHash must be rejected.
  const { dir: dir2 } = createSession(flow, "PlanBind2", root);
  const plan2 = { type: "test-plan", path: artifact(root, "plan2.md", "plan B\nVERDICT: PASS"), actor: "tester", agentRunId: "agent-designer-3" };
  const eval2 = { type: "evaluation", path: artifact(root, "eval2.md", "good\nVERDICT: PASS"), actor: "skeptic-owner", agentRunId: "agent-designer-4" };
  attest(dir2, [plan2], "graphrail-test-designer");
  attest(dir2, [eval2], "graphrail-test-designer");
  sealNode(dir2, [plan2, eval2]);
  advance(dir2);
  const bad = recordTest(dir2, "node --test", { exitCode: 0, tests: { testsDiscovered: 2, testsExecuted: 2, testsPassed: 2, testsFailed: 0 }, testPlanHash: "deadbeef" });
  assert.throws(() => sealNode(dir2, [{ type: "test-result", path: bad.path, actor: "graphrail" }]), /authoritative test-plan|does not match/);
});

test("execute reports testPlanCoverage and missing required cases are rejected", () => {
  const root = project();
  const flow = resolve(root, "coverage.json");
  writeFileSync(flow, JSON.stringify({
    schemaVersion: 1, id: "coverage", entry: "design",
    nodes: {
      design: { kind: "review", evidence: ["evaluation", "test-plan"], minReviewers: 1, agentType: "graphrail-test-designer" },
      execute: { kind: "execute", evidence: ["test-result"] },
      gate: { kind: "gate" },
    },
    transitions: { design: { PASS: "execute" }, execute: { PASS: "gate" }, gate: { PASS: null } },
    limits: { maxEdgeVisits: 2, maxNodeVisits: 3, maxSteps: 5 },
  }));
  // The test-plan declares a required case AUTH-NEG-01.
  const plan = { type: "test-plan", path: artifact(root, "plan.json", JSON.stringify({ cases: [{ id: "AUTH-NEG-01", requirement: "Reject non-Bearer auth", type: "negative", required: true }] })), actor: "tester", agentRunId: "agent-design-1" };
  const evalArtifact = { type: "evaluation", path: artifact(root, "eval.md", "good\nVERDICT: PASS"), actor: "skeptic-owner", agentRunId: "agent-design-2" };
  const { dir } = createSession(flow, "Coverage", root);
  attest(dir, [plan], "graphrail-test-designer");
  attest(dir, [evalArtifact], "graphrail-test-designer");
  sealNode(dir, [plan, evalArtifact]);
  advance(dir); // -> execute
  // Coverage omits the required case -> seal rejected.
  const missing = recordTest(dir, "node --test", { exitCode: 0, tests: { testsDiscovered: 1, testsExecuted: 1, testsPassed: 1, testsFailed: 0, testPlanCoverage: ["OTHER-01"] } });
  assert.throws(() => sealNode(dir, [{ type: "test-result", path: missing.path, actor: "graphrail" }]), /required test-plan cases not covered/);
  // With the required case covered -> seal passes.
  const covered = recordTest(dir, "node --test", { exitCode: 0, tests: { testsDiscovered: 1, testsExecuted: 1, testsPassed: 1, testsFailed: 0, testPlanCoverage: ["AUTH-NEG-01"] } });
  sealNode(dir, [{ type: "test-result", path: covered.path, actor: "graphrail" }]);
  assert.equal(advance(dir).next, "gate");
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
  const first = { type: "deliverable", path: artifact(root, "first-work.md", "first attempt"), actor: "engineer", agentRunId: "agent-loop-a" };
  attest(dir, [first], "graphrail-implementer");
  sealNode(dir, [first], "ITERATE");
  advance(dir);
  const second = { type: "deliverable", path: artifact(root, "second-work.md", "second attempt"), actor: "engineer", agentRunId: "agent-loop-b" };
  attest(dir, [second], "graphrail-implementer");
  sealNode(dir, [second], "ITERATE");
  assert.equal(route(dir, "ITERATE").allowed, false);
  assert.throws(() => advance(dir), /budget exhausted/);
});

test("implementer cannot review the same change it implemented", () => {
  const root = project();
  const { dir } = createSession("quick", "Isolation", root);
  const deliverable = { type: "deliverable", path: artifact(root, "impl.md", "implementation"), actor: "engineer", agentRunId: "agent-shared-impl" };
  attest(dir, [deliverable], "graphrail-implementer");
  sealNode(dir, [deliverable]);
  advance(dir); // -> review
  const evaluations = [
    { type: "evaluation", path: artifact(root, "rev-a.md", "A\nVERDICT: PASS"), actor: "skeptic-owner", agentRunId: "agent-shared-impl" },
    { type: "evaluation", path: artifact(root, "rev-b.md", "B\nVERDICT: PASS"), actor: "tester", agentRunId: "agent-rev-b" },
  ];
  attestReviews(dir, evaluations.filter((entry) => entry.agentRunId === "agent-rev-b"));
  // The implementer run has no reviewer lifecycle events; only the second is attested.
  attest(dir, [{ path: artifact(root, "impl-again.md", "never used"), agentRunId: "agent-shared-impl" }], "graphrail-implementer");
  assert.throws(() => sealNode(dir, evaluations), /previously implemented or designed/);
});

test("same agent ID cannot bypass role isolation by changing actor label", () => {
  const root = project();
  const { dir } = createSession("quick", "Isolation", root);
  const deliverable = { type: "deliverable", path: artifact(root, "impl.md", "implementation"), actor: "engineer", agentRunId: "agent-impl-one" };
  attest(dir, [deliverable], "graphrail-implementer");
  sealNode(dir, [deliverable]);
  advance(dir); // -> review
  const evaluations = [
    { type: "evaluation", path: artifact(root, "rev-a.md", "A\nVERDICT: PASS"), actor: "changed-label", agentRunId: "agent-impl-one" },
    { type: "evaluation", path: artifact(root, "rev-b.md", "B\nVERDICT: PASS"), actor: "tester", agentRunId: "agent-rev-two" },
  ];
  attestReviews(dir, evaluations.filter((entry) => entry.agentRunId === "agent-rev-two"));
  assert.throws(() => sealNode(dir, evaluations), /previously implemented or designed/);
});

test("work deliverables require an attested implementer with a bound Write/Edit event", () => {
  const root = project();
  const { dir } = createSession("quick", "Binding", root);
  // No adapter binding at all: deliverable attestation fails closed.
  const deliverable = { type: "deliverable", path: artifact(root, "impl.md", "implementation"), actor: "engineer", agentRunId: "agent-impl-no-events" };
  assert.throws(() => sealNode(dir, [deliverable]), /no trusted Claude adapter binding/);
  // Adapter bound but no lifecycle events recorded: attestation fails closed.
  const { dir: dir2 } = createSession("quick", "Binding2", root);
  bindClaudeAdapter(dir2, "00000000-0000-4000-8000-000000000001");
  const deliverable2 = { type: "deliverable", path: artifact(root, "impl2.md", "implementation"), actor: "engineer", agentRunId: "agent-impl-no-events" };
  assert.throws(() => sealNode(dir2, [deliverable2]), /no trusted Claude lifecycle ledger/);
});

test("test-design uses the test-designer agent type, not a generic reviewer", () => {
  const root = project();
  const { dir } = createSession("quick", "TestDesignRole", root);
  // Advance build -> review -> gate-review -> test-design through a crafted review pass.
  const deliverable = { type: "deliverable", path: artifact(root, "impl.md", "implementation"), actor: "engineer", agentRunId: "agent-impl-a" };
  attest(dir, [deliverable], "graphrail-implementer");
  sealNode(dir, [deliverable]);
  advance(dir);
  const reviews = [
    { type: "evaluation", path: artifact(root, "rev-a.md", "A\nVERDICT: PASS"), actor: "skeptic-owner", agentRunId: "agent-rev-a" },
    { type: "evaluation", path: artifact(root, "rev-b.md", "B\nVERDICT: PASS"), actor: "tester", agentRunId: "agent-rev-b" },
  ];
  attestReviews(dir, reviews);
  sealNode(dir, reviews);
  advance(dir); // -> gate-review
  advance(dir); // -> test-design
  const plan = { type: "test-plan", path: artifact(root, "plan.md", "plan\nVERDICT: PASS"), actor: "tester", agentRunId: "agent-designer" };
  // Attest the plan as a generic reviewer: must be rejected because test-design requires graphrail-test-designer.
  attest(dir, [plan], "graphrail-reviewer");
  assert.throws(() => sealNode(dir, [plan]), /not a trusted graphrail-test-designer/);
});
