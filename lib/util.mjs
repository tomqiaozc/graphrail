import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const VERDICTS = new Set(["PASS", "ITERATE", "FAIL", "BLOCKED"]);
export const NODE_KINDS = new Set(["plan", "work", "review", "execute", "gate"]);

export function flag(args, name, fallback = null) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

export function flags(args, name) {
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === `--${name}` && args[index + 1] && !args[index + 1].startsWith("--")) {
      out.push(args[index + 1]);
      index += 1;
    }
  }
  return out;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function nonce(bytes = 16) {
  return randomBytes(bytes).toString("hex");
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${nonce(4)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

export function fileHash(path) {
  return sha256(readFileSync(path));
}

export function requireFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
  return path;
}

export function json(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function fail(message, details = {}) {
  const error = new Error(message);
  error.details = details;
  throw error;
}
