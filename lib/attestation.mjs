import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { atomicJson, fileHash, readJson } from "./util.mjs";
import { readState } from "./session.mjs";
import { Ledger } from "./ledger.mjs";

const ADAPTER_PATH = "adapter.json";
const EVENTS_PATH = "adapter-events.json";
const ALLOWED_EVENTS = new Set(["SessionStart", "SessionEnd", "StopFailure", "SubagentStart", "SubagentStop", "PostToolUse"]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function signature(sessionDir, value) {
  const key = readFileSync(resolve(sessionDir, ".session-key"), "utf8");
  return createHmac("sha256", key).update(canonical(value)).digest("hex");
}

function signed(sessionDir, value) {
  return { ...value, signature: signature(sessionDir, value) };
}

function validSignature(sessionDir, value) {
  if (!value || typeof value !== "object" || typeof value.signature !== "string") return false;
  const { signature: actual, ...unsigned } = value;
  const expected = signature(sessionDir, unsigned);
  const left = Buffer.from(actual, "hex");
  const right = Buffer.from(expected, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function bindClaudeAdapter(sessionDir, claudeSessionId) {
  if (!/^[0-9a-f-]{36}$/i.test(claudeSessionId || "")) throw new Error("invalid Claude session ID");
  const state = readState(sessionDir);
  const path = resolve(sessionDir, ADAPTER_PATH);
  if (existsSync(path)) {
    const current = readJson(path);
    if (!validSignature(sessionDir, current)) throw new Error("adapter binding signature mismatch");
    if (current.claudeSessionId !== claudeSessionId) throw new Error("session is already bound to another Claude run");
    return current;
  }
  const binding = signed(sessionDir, {
    schemaVersion: 1,
    adapter: "claude-code",
    graphrailSessionId: state.id,
    claudeSessionId,
    createdAt: new Date().toISOString(),
  });
  atomicJson(path, binding);
  return binding;
}

export function readClaudeAdapter(sessionDir) {
  const path = resolve(sessionDir, ADAPTER_PATH);
  if (!existsSync(path)) throw new Error("session has no trusted Claude adapter binding");
  const binding = readJson(path);
  if (!validSignature(sessionDir, binding)) throw new Error("adapter binding signature mismatch");
  if (binding.schemaVersion !== 1 || binding.adapter !== "claude-code") throw new Error("unsupported adapter binding");
  return binding;
}

export function recordClaudeEvent(sessionDir, input) {
  if (!ALLOWED_EVENTS.has(input?.hookEventName)) throw new Error(`unsupported Claude hook event: ${input?.hookEventName}`);
  const binding = readClaudeAdapter(sessionDir);
  if (input.claudeSessionId !== binding.claudeSessionId) throw new Error("Claude hook event belongs to another session");
  const state = readState(sessionDir);
  const ledgerPath = resolve(sessionDir, EVENTS_PATH);
  const ledger = new Ledger(sessionDir, ledgerPath);
  const chainCheck = ledger.verifyChain();
  if (!chainCheck.valid) throw new Error(`adapter event chain is invalid: ${chainCheck.errors[0]}`);
  if (ledger.entries.some((entry) => entry.payload.eventId === input.eventId)) return { recorded: false, duplicate: true };
  const payload = {
    eventId: input.eventId,
    hookEventName: input.hookEventName,
    claudeSessionId: input.claudeSessionId,
    nodeId: state.currentNode,
    runId: `run_${state.currentRun}`,
    agentId: input.agentId || null,
    agentType: input.agentType || null,
    toolName: input.toolName || null,
    artifactPath: input.artifactPath || null,
    artifactHash: input.artifactHash || null,
    source: input.source || null,
    recordedAt: new Date().toISOString(),
  };
  const entry = ledger.append(payload);
  return { recorded: true, event: entry.payload };
}

export function validateAgentAttestation(sessionDir, nodeId, runId, artifact, agentType) {
  const errors = [];
  let binding;
  try { binding = readClaudeAdapter(sessionDir); } catch (error) { return [error.message]; }
  const ledgerPath = resolve(sessionDir, EVENTS_PATH);
  if (!existsSync(ledgerPath)) return ["evidence has no trusted Claude lifecycle ledger"];
  const ledger = new Ledger(sessionDir, ledgerPath);
  const chainCheck = ledger.verifyChain();
  if (!chainCheck.valid) return [`adapter event chain is invalid: ${chainCheck.errors[0]}`];
  const events = ledger.entries.map((entry) => entry.payload);
  const relevant = events.filter((event) => event.claudeSessionId === binding.claudeSessionId && event.nodeId === nodeId && event.runId === runId && event.agentId === artifact.agentRunId);
  const start = relevant.findIndex((event) => event.hookEventName === "SubagentStart");
  const write = relevant.findIndex((event) => event.hookEventName === "PostToolUse" && ["Write", "Edit"].includes(event.toolName) && event.artifactPath === artifact.sourcePath && event.artifactHash === artifact.sha256);
  const stop = relevant.findIndex((event) => event.hookEventName === "SubagentStop");
  const failure = relevant.findIndex((event) => event.hookEventName === "StopFailure");
  if (start === -1) errors.push(`agent ${artifact.agentRunId} has no trusted start event`);
  if (start !== -1 && relevant[start].agentType !== agentType) errors.push(`agent ${artifact.agentRunId} is not a trusted ${agentType}`);
  if (write === -1) errors.push(`artifact ${artifact.path} is not bound to an agent write event`);
  if (stop === -1) errors.push(`agent ${artifact.agentRunId} has no trusted completion event`);
  if (start !== -1 && write !== -1 && write < start) errors.push(`agent ${artifact.agentRunId} wrote evidence before start`);
  if (write !== -1 && stop !== -1 && stop < write) errors.push(`agent ${artifact.agentRunId} completed before writing evidence`);
  if (failure !== -1 && (stop === -1 || failure < stop)) errors.push(`agent ${artifact.agentRunId} failed before trusted completion`);
  return errors;
}

export function agentTypeForNode(node) {
  if (node.agentType) return node.agentType;
  if (node.kind === "review") return "graphrail-reviewer";
  if (node.kind === "plan" || node.kind === "work") return "graphrail-implementer";
  return null;
}

export function attestedArtifact(path, agentRunId) {
  return { path: resolve(path), sha256: fileHash(resolve(path)), agentRunId };
}
