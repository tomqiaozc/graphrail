import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { atomicJson, fileHash, readJson, sha256, VERDICTS } from "./util.mjs";
import { handshakePath, readState, runDir } from "./session.mjs";
import { agentTypeForNode, validateAgentAttestation } from "./attestation.mjs";
import { workingTreeHash } from "./testresults.mjs";
import { Ledger } from "./ledger.mjs";

function within(base, path) {
  const rel = relative(base, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// Collect every attested subagent run ID from handshakes sealed strictly before
// (nodeId, runId). Used to enforce cross-role isolation: an agent that
// implemented or designed earlier work cannot later certify the same change.
function priorAgentRunIds(sessionDir, state, nodeId, runId) {
  const ids = [];
  for (const entry of state.history) {
    if (entry.node === nodeId && entry.runId === runId) break;
    if (!entry.node) continue;
    const run = Number(entry.runId.replace("run_", ""));
    const path = handshakePath(sessionDir, entry.node, run);
    if (!existsSync(path)) continue;
    const handshake = readJson(path);
    for (const artifact of handshake.artifacts || []) {
      if (artifact.agentRunId) ids.push(artifact.agentRunId);
    }
  }
  return new Set(ids);
}

// Find the sha256 of the authoritative test-plan artifact for an execute run by
// scanning earlier sealed runs for a test-design node that produced a test-plan.
export function testPlanHashForRun(sessionDir, executeNodeId, executeRunId) {
  const state = readState(sessionDir);
  const planNodeId = Object.keys(state.template.nodes).find((id) => (state.template.nodes[id].evidence || []).includes("test-plan"));
  if (!planNodeId) return null;
  for (const entry of state.history) {
    if (entry.node === executeNodeId && entry.runId === executeRunId) break;
    if (entry.node !== planNodeId || !entry.runId) continue;
    const run = Number(entry.runId.replace("run_", ""));
    const path = handshakePath(sessionDir, entry.node, run);
    if (!existsSync(path)) continue;
    const handshake = readJson(path);
    for (const artifact of handshake.artifacts || []) {
      if (artifact.type === "test-plan") return artifact.sha256;
    }
  }
  return null;
}

export function parseArtifact(value) {
  const [type, path, actor = "", agentRunId = ""] = value.split(":");
  if (!type || !path) throw new Error(`invalid artifact: ${value}`);
  return { type, path, actor, agentRunId };
}

export function validateHandshake(sessionDir, handshake, expectedNode = null, expectedRun = null) {
  const state = readState(sessionDir);
  const errors = [];
  if (!handshake || typeof handshake !== "object") return ["handshake must be an object"];
  const nodeId = expectedNode || handshake.nodeId;
  const runId = expectedRun || handshake.runId;
  if (!state.template.nodes[nodeId]) errors.push("handshake node is unknown");
  if (handshake.nodeId !== nodeId) errors.push("handshake node does not match authoritative node");
  if (handshake.runId !== runId) errors.push("handshake run does not match authoritative run");
  if (!Array.isArray(handshake.artifacts)) errors.push("artifacts must be an array");
  if (!VERDICTS.has(handshake.verdict)) errors.push("handshake verdict is invalid");
  const runNumber = Number(String(runId).replace("run_", ""));
  const base = runDir(sessionDir, nodeId, runNumber);
  for (const artifact of handshake.artifacts || []) {
    const path = resolve(base, artifact.path || "");
    if (!within(base, path)) { errors.push(`artifact escapes run directory: ${artifact.path}`); continue; }
    if (!existsSync(path)) { errors.push(`artifact missing: ${artifact.path}`); continue; }
    if (fileHash(path) !== artifact.sha256) errors.push(`artifact hash mismatch: ${artifact.path}`);
  }
  const node = state.template.nodes[nodeId];
  if ((node?.kind === "plan" || node?.kind === "work") && handshake.status === "completed" && (handshake.artifacts || []).length === 0) {
    errors.push(`${node.kind} node requires at least one deliverable artifact`);
  }
  if (node?.kind === "review" && handshake.verdict !== "PASS") {
    errors.push("review node completion verdict must be PASS; evaluation verdicts are aggregated by the gate");
  }
  for (const required of node?.evidence || []) {
    if (!(handshake.artifacts || []).some((artifact) => artifact.type === required)) errors.push(`required evidence missing: ${required}`);
  }
  if (node?.kind === "review") {
    const evaluations = (handshake.artifacts || []).filter((artifact) => artifact.type === "evaluation");
    const actors = new Set(evaluations.map((artifact) => artifact.actor).filter(Boolean));
    const agentRuns = new Set(evaluations.map((artifact) => artifact.agentRunId).filter((value) => /^[a-zA-Z0-9_-]{8,}$/.test(value || "")));
    if (evaluations.length < (node.minReviewers || 2)) errors.push(`review requires at least ${node.minReviewers || 2} evaluations`);
    if (actors.size < (node.minReviewers || 2)) errors.push("review evaluations must come from distinct actors");
    if (agentRuns.size < (node.minReviewers || 2)) errors.push("review evaluations must include distinct subagent run IDs");
    if (new Set(evaluations.map((artifact) => artifact.sha256)).size !== evaluations.length) errors.push("review evaluations must contain distinct content");
    const agentType = agentTypeForNode(node);
    for (const artifact of evaluations) errors.push(...validateAgentAttestation(sessionDir, nodeId, runId, artifact, agentType));
    const prior = priorAgentRunIds(sessionDir, state, nodeId, runId);
    const overlapping = evaluations.map((artifact) => artifact.agentRunId).filter((id) => prior.has(id));
    if (overlapping.length) errors.push(`reviewer ${overlapping[0]} previously implemented or designed this change`);
    // Attest additional agent-authored evidence types (e.g. a test-plan produced by
    // the test designer) against the node's declared agent type.
    for (const artifact of (handshake.artifacts || [])) {
      if (artifact.type !== "evaluation" && artifact.agentRunId) {
        errors.push(...validateAgentAttestation(sessionDir, nodeId, runId, artifact, agentType));
      }
    }
  }
  if (node?.kind === "work" || node?.kind === "plan") {
    const agentType = agentTypeForNode(node);
    for (const artifact of handshake.artifacts || []) {
      if (!artifact.agentRunId) errors.push(`deliverable ${artifact.path} requires an attested agent run ID`);
      else errors.push(...validateAgentAttestation(sessionDir, nodeId, runId, artifact, agentType));
    }
  }
  if (node?.kind === "execute") {
    const prior = priorAgentRunIds(sessionDir, state, nodeId, runId);
    for (const artifact of (handshake.artifacts || []).filter((entry) => entry.type === "test-result")) {
      if (artifact.agentRunId && prior.has(artifact.agentRunId)) errors.push(`test execution cannot be attested by the test designer: ${artifact.agentRunId}`);
      try {
        const result = readJson(resolve(base, artifact.path));
        if (result.schemaVersion !== 2) errors.push(`test-execution must be schemaVersion 2: ${artifact.path}`);
        const ledger = new Ledger(sessionDir, resolve(sessionDir, "provenance.json"));
        const chainCheck = ledger.verifyChain();
        if (!chainCheck.valid) errors.push(`test provenance chain is invalid: ${chainCheck.errors[0]}`);
        const logicalHash = result.resultHash;
        const event = ledger.entries.map((entry) => entry.payload).find((payload) => payload.nodeId === nodeId && payload.runId === runId && payload.resultHash === logicalHash);
        if (!event) errors.push(`test result lacks harness provenance: ${artifact.path}`);
        else if (result.commandHash !== event.commandHash || result.runId !== runId || result.nodeId !== nodeId) errors.push(`test provenance fields mismatch: ${artifact.path}`);
        const exitCode = result.exitCode;
        const t = result;
        if (handshake.verdict === "PASS" && exitCode !== 0) errors.push(`failing test result cannot support PASS: ${artifact.path}`);
        // 0-case policy: without explicit allowZeroTests, a PASS needs executed > 0.
        const allowZero = node.allowZeroTests === true;
        if (handshake.verdict === "PASS" && !allowZero && (t.testsExecuted === null || t.testsExecuted === undefined || t.testsExecuted === 0)) {
          errors.push(`PASS requires structured testsExecuted > 0 (or allowZeroTests): ${artifact.path}`);
        }
        if (t.testsExecuted !== null && t.testsExecuted !== undefined) {
          if (t.testsPassed === null || t.testsFailed === null || t.testsPassed + t.testsFailed !== t.testsExecuted) {
            errors.push(`test statistics must satisfy passed + failed == executed: ${artifact.path}`);
          }
          if (exitCode === 0 && t.testsFailed > 0) errors.push(`exit code 0 contradicts ${t.testsFailed} failed tests: ${artifact.path}`);
          if (exitCode !== 0 && t.testsFailed === 0 && t.testsExecuted > 0) errors.push(`non-zero exit code with 0 failed tests is inconsistent: ${artifact.path}`);
        }
        if (result.testPlanHash && node.requiresTestPlanHash) {
          const authoritative = testPlanHashForRun(sessionDir, nodeId, runId);
          if (!authoritative) errors.push(`no authoritative test-plan for this run: ${artifact.path}`);
          else if (result.testPlanHash !== authoritative) errors.push(`test-plan hash does not match the authoritative test-design artifact: ${artifact.path}`);
        }
        if (result.workingTreeHash) {
          const current = workingTreeHash(state.projectDir);
          if (current !== result.workingTreeHash) errors.push(`working tree changed since test execution: ${artifact.path}`);
        }
        // Required test-plan cases must be covered by the executed result.
        if (result.testPlanCoverage && result.testPlanCoverage.length) {
          const required = requiredCasesForRun(sessionDir, nodeId, runId);
          const missing = required.filter((id) => !result.testPlanCoverage.includes(id));
          if (missing.length) errors.push(`required test-plan cases not covered: ${missing.join(", ")}`);
        }
        // Fault sensitivity: a node that requires a mutation probe must have
        // detected at least one probe mutation turning the suite red.
        if (node.requireMutationProbe === true) {
          const detected = (result.probes || []).filter((probe) => probe.detected === true);
          if (detected.length === 0) errors.push(`node requires a detected mutation probe but none was red: ${artifact.path}`);
        }
      } catch (error) { errors.push(`invalid test provenance: ${error.message}`); }
    }
  }
  return errors;
}

// Read the authoritative test-design artifact for this run and collect the
// `required: true` case IDs declared in its test-plan.
function requiredCasesForRun(sessionDir, executeNodeId, executeRunId) {
  const state = readState(sessionDir);
  const planNodeId = Object.keys(state.template.nodes).find((id) => (state.template.nodes[id].evidence || []).includes("test-plan"));
  if (!planNodeId) return [];
  for (const entry of state.history) {
    if (entry.node === executeNodeId && entry.runId === executeRunId) break;
    if (entry.node !== planNodeId || !entry.runId) continue;
    const run = Number(entry.runId.replace("run_", ""));
    const path = handshakePath(sessionDir, entry.node, run);
    if (!existsSync(path)) continue;
    const handshake = readJson(path);
    for (const artifact of handshake.artifacts || []) {
      if (artifact.type !== "test-plan") continue;
      try {
        const plan = JSON.parse(readFileSync(resolve(runDir(sessionDir, entry.node, run), artifact.path), "utf8"));
        if (Array.isArray(plan.cases)) {
          return plan.cases.filter((entry) => entry.required).map((entry) => entry.id);
        }
      } catch { /* non-JSON plans have no required-case contract */ }
    }
  }
  return [];
}

export function sealNode(sessionDir, artifacts, verdict = "PASS", summary = "Node completed") {
  if (!VERDICTS.has(verdict)) throw new Error(`invalid verdict: ${verdict}`);
  const state = readState(sessionDir);
  const nodeId = state.currentNode;
  const run = state.currentRun;
  const base = runDir(sessionDir, nodeId, run);
  mkdirSync(base, { recursive: true });
  const sealed = artifacts.map((artifact) => {
    const source = resolve(artifact.path);
    if (!existsSync(source)) throw new Error(`artifact not found: ${artifact.path}`);
    const target = resolve(base, basename(source));
    if (source !== target) writeFileSync(target, readFileSync(source));
    return { type: artifact.type, path: basename(target), sourcePath: source, actor: artifact.actor || "", agentRunId: artifact.agentRunId || "", sha256: fileHash(target) };
  });
  const handshake = {
    schemaVersion: 1,
    nodeId,
    kind: state.template.nodes[nodeId].kind,
    runId: `run_${run}`,
    status: "completed",
    verdict,
    summary,
    artifacts: sealed,
    sealedAt: new Date().toISOString(),
  };
  const errors = validateHandshake(sessionDir, handshake, nodeId, `run_${run}`);
  if (errors.length) throw new Error(`handshake rejected: ${errors.join("; ")}`);
  atomicJson(handshakePath(sessionDir, nodeId, run), handshake);
  return handshake;
}

export function recordTest(sessionDir, command, result) {
  const state = readState(sessionDir);
  const nodeId = state.currentNode;
  const runId = `run_${state.currentRun}`;
  if (state.template.nodes[nodeId].kind !== "execute") throw new Error("tests can only be recorded for execute nodes");
  const base = runDir(sessionDir, nodeId, state.currentRun);
  mkdirSync(base, { recursive: true });
  const commandHash = createCommandHash(command);
  const startedAt = result.startedAt || new Date().toISOString();
  const finishedAt = result.finishedAt || new Date().toISOString();
  const exitCode = result.exitCode ?? 1;
  const workingTreeHash = result.workingTreeHash ?? null;
  const testPlanHash = result.testPlanHash ?? null;
  const tests = result.tests || {};
  const document = {
    schemaVersion: 2,
    nodeId,
    runId,
    testPlanHash,
    command,
    commandHash,
    workingTreeHash,
    startedAt,
    finishedAt,
    exitCode,
    testsDiscovered: tests.testsDiscovered ?? null,
    testsExecuted: tests.testsExecuted ?? null,
    testsPassed: tests.testsPassed ?? null,
    testsFailed: tests.testsFailed ?? null,
    testPlanCoverage: tests.testPlanCoverage ?? null,
    testFormat: result.testFormat ?? null,
    probes: result.probes ?? null,
    recordedAt: new Date().toISOString(),
  };
  const resultPath = resolve(base, "test-execution.json");
  // resultHash is the sha256 of the serialized document with resultHash excluded.
  // It is computed before writing, so the on-disk file (after atomicJson) has a
  // different hash; provenance binds the logical result, not the serialized bytes.
  const { resultHash: _omit, ...unsignedDocument } = document;
  const resultHash = sha256(JSON.stringify(unsignedDocument));
  document.resultHash = resultHash;
  atomicJson(resultPath, document);
  const ledger = new Ledger(sessionDir, resolve(sessionDir, "provenance.json"));
  ledger.append({ kind: "test", nodeId, runId, commandHash, resultHash, recordedAt: document.recordedAt });
  return { path: resultPath, result: document };
}

function createCommandHash(command) {
  return sha256(command);
}
