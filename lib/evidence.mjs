import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { atomicJson, fileHash, readJson, VERDICTS } from "./util.mjs";
import { handshakePath, readState, runDir } from "./session.mjs";
import { validateReviewAttestation } from "./attestation.mjs";

function within(base, path) {
  const rel = relative(base, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function sign(payload, key) {
  return createHmac("sha256", key).update(JSON.stringify(payload)).digest("hex");
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
    for (const artifact of evaluations) errors.push(...validateReviewAttestation(sessionDir, nodeId, runId, artifact));
  }
  if (node?.kind === "execute") {
    for (const artifact of (handshake.artifacts || []).filter((entry) => entry.type === "test-result")) {
      try {
        const result = readJson(resolve(base, artifact.path));
        const ledger = readJson(resolve(sessionDir, "provenance.json"));
        const event = ledger.events.find((entry) => entry.nodeId === nodeId && entry.runId === runId && entry.resultHash === artifact.sha256);
        if (!event) errors.push(`test result lacks harness provenance: ${artifact.path}`);
        else {
          const key = readFileSync(resolve(sessionDir, ".session-key"), "utf8");
          const { signature, ...unsigned } = event;
          if (sign(unsigned, key) !== signature) errors.push(`test provenance signature mismatch: ${artifact.path}`);
          if (result.commandHash !== event.commandHash || result.runId !== runId || result.nodeId !== nodeId) errors.push(`test provenance fields mismatch: ${artifact.path}`);
          if (handshake.verdict === "PASS" && result.exitCode !== 0) errors.push(`failing test result cannot support PASS: ${artifact.path}`);
        }
      } catch (error) { errors.push(`invalid test provenance: ${error.message}`); }
    }
  }
  return errors;
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
  const document = { schemaVersion: 1, nodeId, runId, command, commandHash, ...result, recordedAt: new Date().toISOString() };
  const resultPath = resolve(base, "test-result.json");
  atomicJson(resultPath, document);
  const resultHash = fileHash(resultPath);
  const ledgerPath = resolve(sessionDir, "provenance.json");
  const ledger = existsSync(ledgerPath) ? readJson(ledgerPath) : { schemaVersion: 1, events: [] };
  const unsigned = { nodeId, runId, commandHash, resultHash, recordedAt: document.recordedAt };
  const key = readFileSync(resolve(sessionDir, ".session-key"), "utf8");
  ledger.events.push({ ...unsigned, signature: sign(unsigned, key) });
  atomicJson(ledgerPath, ledger);
  return { path: resultPath, result: document };
}

function createCommandHash(command) {
  return sha256(command);
}

import { sha256 } from "./util.mjs";
