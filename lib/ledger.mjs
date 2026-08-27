import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { atomicJson, readJson } from "./util.mjs";

// Hash-chain ledger with per-event HMAC signatures. Every entry binds to its
// predecessor via previousEventHash, so truncation, insertion, deletion, and
// reordering are all detectable by re-running verifyChain(). A finalized session
// records a signed chain head.
//
// Threat-model boundary: this chain detects *accidental* tampering and model-text
// forgery by an ordinary orchestrator. It does NOT protect against a malicious
// process with unrestricted access to the same OS account — such a process can
// read .session-key and recompute every signature. Document that boundary, do
// not overclaim.

const SCHEMA_VERSION = 2;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function payloadHashOf(payload) {
  return sha256(canonical(payload));
}

function eventHashOf(payloadHash, previousEventHash) {
  return sha256(`${payloadHash}|${previousEventHash ?? ""}`);
}

// sessionDir provides the .session-key used for HMAC signatures.
export class Ledger {
  constructor(sessionDir, path) {
    this.sessionDir = sessionDir;
    this.path = resolve(path);
    this.key = readFileSync(resolve(sessionDir, ".session-key"), "utf8");
    this.entries = this.load();
  }

  load() {
    if (!existsSync(this.path)) return [];
    const doc = readJson(this.path);
    if (doc.schemaVersion !== SCHEMA_VERSION) throw new Error(`ledger schemaVersion ${doc.schemaVersion} is not supported (expected ${SCHEMA_VERSION})`);
    if (!Array.isArray(doc.entries)) throw new Error("ledger entries must be an array");
    return doc.entries;
  }

  sign(entry) {
    return createHmac("sha256", this.key).update(canonical(entry)).digest("hex");
  }

  // Append a payload, binding it to the current chain head. Returns the entry.
  append(payload) {
    const previous = this.entries.length ? this.entries[this.entries.length - 1] : null;
    const sequence = previous ? previous.sequence + 1 : 1;
    const previousEventHash = previous ? previous.eventHash : null;
    const payloadHash = payloadHashOf(payload);
    const eventHash = eventHashOf(payloadHash, previousEventHash);
    const unsigned = { sequence, previousEventHash, payloadHash, eventHash, payload };
    const entry = { ...unsigned, signature: this.sign(unsigned) };
    this.entries.push(entry);
    this.persist();
    return entry;
  }

  persist() {
    atomicJson(this.path, { schemaVersion: SCHEMA_VERSION, entries: this.entries });
  }

  // Replay the whole chain, checking sequence continuity, hash linkage, and
  // signatures. Returns { valid, errors }.
  verifyChain() {
    const errors = [];
    let previous = null;
    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index];
      if (typeof entry.sequence !== "number") { errors.push(`entry ${index} has no numeric sequence`); continue; }
      const expectedSequence = previous ? previous.sequence + 1 : 1;
      if (entry.sequence !== expectedSequence) errors.push(`sequence gap at ${entry.sequence}: expected ${expectedSequence}`);
      const expectedPrevious = previous ? previous.eventHash : null;
      if (entry.previousEventHash !== expectedPrevious) errors.push(`previousEventHash mismatch at ${entry.sequence}`);
      const payloadHash = payloadHashOf(entry.payload);
      if (entry.payloadHash !== payloadHash) errors.push(`payloadHash mismatch at ${entry.sequence}`);
      const eventHash = eventHashOf(entry.payloadHash, entry.previousEventHash);
      if (entry.eventHash !== eventHash) errors.push(`eventHash mismatch at ${entry.sequence}`);
      const { signature, ...unsigned } = entry;
      if (this.sign(unsigned) !== signature) errors.push(`signature mismatch at ${entry.sequence}`);
      previous = entry;
    }
    return { valid: errors.length === 0, errors };
  }

  tail() {
    return this.entries.length ? this.entries[this.entries.length - 1] : null;
  }
}
