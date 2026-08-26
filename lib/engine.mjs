import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { handshakePath, readState, runDir, writeState } from "./session.mjs";
import { atomicJson, readJson, VERDICTS } from "./util.mjs";
import { validateHandshake } from "./evidence.mjs";
import { withLock } from "./lock.mjs";

function routeFor(state, verdict) {
  if (!VERDICTS.has(verdict)) throw new Error(`invalid verdict: ${verdict}`);
  const routes = state.template.transitions[state.currentNode] || {};
  if (!Object.hasOwn(routes, verdict)) throw new Error(`no ${verdict} transition from ${state.currentNode}`);
  return routes[verdict];
}

function budgetReasons(state, target, verdict) {
  const reasons = [];
  const limits = state.template.limits;
  const edge = `${state.currentNode}->${target ?? "END"}`;
  if ((state.edgeVisits[edge] || 0) + 1 > limits.maxEdgeVisits) reasons.push(`edge budget exhausted: ${edge}`);
  if (target !== null && (state.nodeVisits[target] || 0) + 1 > limits.maxNodeVisits) reasons.push(`node budget exhausted: ${target}`);
  if (state.totalSteps + 1 > limits.maxSteps) reasons.push("total step budget exhausted");
  if (verdict !== "PASS") {
    const repair = `${state.currentNode}:${verdict}`;
    if ((state.repairVisits[repair] || 0) + 1 > limits.maxEdgeVisits) reasons.push(`repair budget exhausted: ${repair}`);
  }
  return reasons;
}

function validateCurrentEvidence(sessionDir, state) {
  const path = handshakePath(sessionDir, state.currentNode, state.currentRun);
  if (!existsSync(path)) throw new Error(`current run is not sealed: ${state.currentNode}/run_${state.currentRun}`);
  const handshake = readJson(path);
  const errors = validateHandshake(sessionDir, handshake, state.currentNode, `run_${state.currentRun}`);
  if (errors.length) throw new Error(`current handshake is invalid: ${errors.join("; ")}`);
  return handshake;
}

function upstreamSinceLastGate(sessionDir, state) {
  const entries = [];
  for (let index = state.history.length - 2; index >= 0; index -= 1) {
    const entry = state.history[index];
    if (state.template.nodes[entry.node].kind === "gate") break;
    entries.unshift(entry);
  }
  const reasons = [];
  const verdicts = [];
  for (const entry of entries) {
    const run = Number(entry.runId.replace("run_", ""));
    const path = handshakePath(sessionDir, entry.node, run);
    if (!existsSync(path)) { reasons.push(`upstream run is unsealed: ${entry.node}/${entry.runId}`); continue; }
    const handshake = readJson(path);
    const errors = validateHandshake(sessionDir, handshake, entry.node, entry.runId);
    reasons.push(...errors.map((error) => `${entry.node}/${entry.runId}: ${error}`));
    if (handshake.verdict !== "PASS") verdicts.push(handshake.verdict);
    for (const artifact of handshake.artifacts || []) {
      const artifactPath = resolve(runDir(sessionDir, entry.node, run), artifact.path);
      if (artifact.type === "evaluation") {
        const text = readFileSync(artifactPath, "utf8");
        let evaluationVerdict = null;
        try { evaluationVerdict = JSON.parse(text).verdict; } catch { evaluationVerdict = text.match(/(?:^|\n)VERDICT:\s*(PASS|ITERATE|FAIL|BLOCKED)\b/i)?.[1]; }
        evaluationVerdict = String(evaluationVerdict || "").toUpperCase();
        if (!VERDICTS.has(evaluationVerdict)) reasons.push(`${entry.node}/${entry.runId} evaluation ${artifact.path} has no valid VERDICT`);
        else verdicts.push(evaluationVerdict);
      }
      if (artifact.type === "test-result") {
        try {
          const result = readJson(artifactPath);
          verdicts.push(result.exitCode === 0 ? "PASS" : "FAIL");
        } catch { reasons.push(`${entry.node}/${entry.runId} test result is unreadable`); }
      }
    }
  }
  const priority = ["FAIL", "BLOCKED", "ITERATE", "PASS"];
  const verdict = priority.find((candidate) => verdicts.includes(candidate)) || "PASS";
  return { reasons, verdict };
}

export function route(sessionDir, verdict) {
  const state = readState(sessionDir);
  if (state.status !== "active") throw new Error(`session is ${state.status}`);
  const target = routeFor(state, verdict);
  const reasons = budgetReasons(state, target, verdict);
  return { allowed: reasons.length === 0, from: state.currentNode, verdict, next: target, reasons };
}

export function transition(sessionDir, verdict, { manual = false } = {}) {
  return withLock(resolve(sessionDir, ".lock"), () => {
    let state = readState(sessionDir);
    if (state.status !== "active") throw new Error(`session is ${state.status}`);
    const current = state.currentNode;
    const node = state.template.nodes[current];
    if (!manual && node.kind !== "gate") {
      const handshake = validateCurrentEvidence(sessionDir, state);
      if (handshake.verdict !== verdict) throw new Error(`requested verdict ${verdict} differs from sealed verdict ${handshake.verdict}`);
    }
    if (node.kind === "gate") {
      const synthesis = upstreamSinceLastGate(sessionDir, state);
      if (synthesis.reasons.length) throw new Error(`gate rejected: ${synthesis.reasons.join("; ")}`);
      if (verdict !== synthesis.verdict) throw new Error(`gate verdict mismatch: evidence requires ${synthesis.verdict}, requested ${verdict}`);
    }
    const target = routeFor(state, verdict);
    const reasons = budgetReasons(state, target, verdict);
    if (reasons.length) throw new Error(reasons.join("; "));
    const edge = `${current}->${target ?? "END"}`;
    if (node.kind === "gate") {
      atomicJson(handshakePath(sessionDir, current, state.currentRun), {
        schemaVersion: 1,
        nodeId: current,
        kind: "gate",
        runId: `run_${state.currentRun}`,
        status: "completed",
        verdict,
        summary: `Mechanical gate routed ${verdict}`,
        artifacts: [],
        sealedAt: new Date().toISOString(),
      });
    }
    state.edgeVisits[edge] = (state.edgeVisits[edge] || 0) + 1;
    state.totalSteps += 1;
    if (verdict !== "PASS") {
      const repair = `${current}:${verdict}`;
      state.repairVisits[repair] = (state.repairVisits[repair] || 0) + 1;
    }
    if (target === null) {
      state.status = "ready-to-finalize";
      state.completedNode = current;
      state.history.push({ node: null, runId: null, enteredAt: new Date().toISOString(), reason: verdict });
    } else {
      state.currentNode = target;
      state.currentRun += 1;
      state.nodeVisits[target] = (state.nodeVisits[target] || 0) + 1;
      state.history.push({ node: target, runId: `run_${state.currentRun}`, enteredAt: new Date().toISOString(), reason: verdict });
      mkdirSync(runDir(sessionDir, target, state.currentRun), { recursive: true });
    }
    state = writeState(sessionDir, state);
    return { allowed: true, from: current, verdict, next: target, status: state.status, runId: target === null ? null : `run_${state.currentRun}` };
  });
}

export function advance(sessionDir) {
  const state = readState(sessionDir);
  const handshake = validateCurrentEvidence(sessionDir, state);
  return transition(sessionDir, handshake.verdict);
}

export function finalize(sessionDir) {
  return withLock(resolve(sessionDir, ".lock"), () => {
    const state = readState(sessionDir);
    if (state.status !== "ready-to-finalize") throw new Error("session has not reached a terminal edge");
    state.status = "completed";
    state.finalizedAt = new Date().toISOString();
    writeState(sessionDir, state);
    return { finalized: true, flow: state.flowId, steps: state.totalSteps, status: "completed" };
  });
}

export function stop(sessionDir) {
  return withLock(resolve(sessionDir, ".lock"), () => {
    const state = readState(sessionDir);
    state.status = "stopped";
    state.stoppedAt = new Date().toISOString();
    writeState(sessionDir, state);
    return { stopped: true, currentNode: state.currentNode };
  });
}

export function gotoNode(sessionDir, target) {
  return withLock(resolve(sessionDir, ".lock"), () => {
    const state = readState(sessionDir);
    if (state.status !== "active") throw new Error(`session is ${state.status}`);
    if (!state.template.nodes[target]) throw new Error(`unknown node: ${target}`);
    if ((state.nodeVisits[target] || 0) + 1 > state.template.limits.maxNodeVisits) throw new Error(`node budget exhausted: ${target}`);
    if (state.totalSteps + 1 > state.template.limits.maxSteps) throw new Error("total step budget exhausted");
    const hasExit = Object.values(state.template.transitions[target] || {}).some((destination) => {
      const edge = `${target}->${destination ?? "END"}`;
      const edgeAvailable = (state.edgeVisits[edge] || 0) < state.template.limits.maxEdgeVisits;
      const nodeAvailable = destination === null || (state.nodeVisits[destination] || 0) < state.template.limits.maxNodeVisits;
      return edgeAvailable && nodeAvailable;
    });
    if (!hasExit) throw new Error(`target has no budgeted exit: ${target}`);
    state.currentNode = target;
    state.currentRun += 1;
    state.totalSteps += 1;
    state.nodeVisits[target] = (state.nodeVisits[target] || 0) + 1;
    state.history.push({ node: target, runId: `run_${state.currentRun}`, enteredAt: new Date().toISOString(), reason: "goto" });
    mkdirSync(runDir(sessionDir, target, state.currentRun), { recursive: true });
    writeState(sessionDir, state);
    return { moved: true, node: target, runId: `run_${state.currentRun}` };
  });
}

export function validateChain(sessionDir) {
  const state = readState(sessionDir);
  const errors = [];
  for (const entry of state.history) {
    if (!entry.node) continue;
    const run = Number(entry.runId.replace("run_", ""));
    const path = handshakePath(sessionDir, entry.node, run);
    const isCurrentUnsealed = state.status === "active" && entry.node === state.currentNode && run === state.currentRun && !existsSync(path);
    if (isCurrentUnsealed) continue;
    if (!existsSync(path) && state.template.nodes[entry.node].kind !== "gate") errors.push(`missing handshake: ${entry.node}/${entry.runId}`);
    else if (existsSync(path)) errors.push(...validateHandshake(sessionDir, readJson(path), entry.node, entry.runId));
  }
  for (let index = 1; index < state.history.length; index += 1) {
    const previous = state.history[index - 1];
    const current = state.history[index];
    if (current.reason === "goto") continue;
    const expected = state.template.transitions[previous.node]?.[current.reason];
    if (expected !== current.node) errors.push(`invalid history edge: ${previous.node} --${current.reason}--> ${current.node}`);
  }
  return { valid: errors.length === 0, errors };
}

export function visualize(template, currentNode = null) {
  const lines = [`Flow: ${template.id}`];
  for (const id of Object.keys(template.nodes)) {
    const marker = id === currentNode ? ">" : " ";
    const routes = Object.entries(template.transitions[id] || {}).map(([verdict, target]) => `${verdict}:${target ?? "END"}`).join(" | ");
    lines.push(`${marker} ${id} [${template.nodes[id].kind}] -> ${routes}`);
  }
  return lines.join("\n");
}
