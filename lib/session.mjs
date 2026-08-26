import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { atomicJson, nonce, readJson, sha256 } from "./util.mjs";
import { loadTemplate } from "./templates.mjs";

const ROOT_NAME = ".graphrail";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function stateSignature(state, key) {
  const unsigned = { ...state };
  delete unsigned.signature;
  return createHmac("sha256", key).update(canonical(unsigned)).digest("hex");
}

export function controlRoot(projectDir = process.cwd()) {
  return resolve(projectDir, ROOT_NAME);
}

export function resolveSession(projectDir = process.cwd(), explicit = null) {
  if (explicit) return resolve(explicit);
  const root = controlRoot(projectDir);
  const latestPath = resolve(root, "latest.json");
  if (!existsSync(latestPath)) throw new Error("no active GraphRail session");
  return resolve(root, readJson(latestPath).session);
}

export function createSession(flow, task, projectDir = process.cwd()) {
  const { template, path, builtin } = loadTemplate(flow);
  const root = controlRoot(projectDir);
  mkdirSync(resolve(root, "sessions"), { recursive: true });
  const id = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${nonce(4)}`;
  const dir = resolve(root, "sessions", id);
  mkdirSync(dir, { recursive: true });
  const key = nonce(32);
  writeFileSync(resolve(dir, ".session-key"), key, { mode: 0o600 });
  const state = {
    schemaVersion: 1,
    id,
    task,
    projectDir: resolve(projectDir),
    flowId: template.id,
    flowPath: builtin ? `builtin:${template.id}` : path,
    template,
    templateHash: sha256(canonical(template)),
    currentNode: template.entry,
    currentRun: 1,
    status: "active",
    history: [{ node: template.entry, runId: "run_1", enteredAt: new Date().toISOString(), reason: "init" }],
    edgeVisits: {},
    nodeVisits: { [template.entry]: 1 },
    repairVisits: {},
    totalSteps: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeState(dir, state);
  mkdirSync(runDir(dir, template.entry, 1), { recursive: true });
  atomicJson(resolve(root, "latest.json"), { session: `sessions/${id}` });
  return { dir, state: readState(dir) };
}

export function readState(dir) {
  const path = resolve(dir, "state.json");
  const state = readJson(path);
  const key = readFileSync(resolve(dir, ".session-key"), "utf8");
  if (stateSignature(state, key) !== state.signature) throw new Error("state signature mismatch");
  if (sha256(canonical(state.template)) !== state.templateHash) throw new Error("embedded template hash mismatch");
  return state;
}

export function writeState(dir, state) {
  const key = readFileSync(resolve(dir, ".session-key"), "utf8");
  const next = { ...state, updatedAt: new Date().toISOString() };
  next.signature = stateSignature(next, key);
  atomicJson(resolve(dir, "state.json"), next);
  return next;
}

export function runDir(sessionDir, node, run) {
  return resolve(sessionDir, "nodes", node, `run_${run}`);
}

export function handshakePath(sessionDir, node, run) {
  return resolve(runDir(sessionDir, node, run), "handshake.json");
}

export function listSessions(projectDir = process.cwd()) {
  const root = controlRoot(projectDir);
  const sessionsDir = resolve(root, "sessions");
  if (!existsSync(sessionsDir)) return [];
  const latest = existsSync(resolve(root, "latest.json")) ? basename(resolve(root, readJson(resolve(root, "latest.json")).session)) : null;
  return readdirSync(sessionsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().map((name) => {
    try {
      const state = readState(resolve(sessionsDir, name));
      return { id: name, flow: state.flowId, currentNode: state.currentNode, status: state.status, task: state.task, latest: name === latest };
    } catch (error) {
      return { id: name, status: "invalid", error: error.message, latest: name === latest };
    }
  });
}

export function sessionFromPath(path) {
  return dirname(dirname(dirname(resolve(path))));
}
