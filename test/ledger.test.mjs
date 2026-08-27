import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Ledger } from "../lib/ledger.mjs";
import { readJson } from "../lib/util.mjs";

function project() {
  const dir = mkdtempSync(resolve(tmpdir(), "graphrail-ledger-"));
  writeFileSync(resolve(dir, ".session-key"), "0".repeat(64));
  return dir;
}

function makeLedger(dir, name = "provenance.json") {
  return new Ledger(dir, resolve(dir, name));
}

test("ledger appends a contiguous signed chain and verifies cleanly", () => {
  const dir = project();
  const ledger = makeLedger(dir);
  ledger.append({ kind: "test", nodeId: "execute", runId: "run_1", commandHash: "a" });
  ledger.append({ kind: "test", nodeId: "execute", runId: "run_2", commandHash: "b" });
  assert.equal(ledger.tail().sequence, 2);
  assert.equal(ledger.tail().previousEventHash, ledger.entries[0].eventHash);
  assert.deepEqual(ledger.verifyChain(), { valid: true, errors: [] });
});

test("old schemaVersion=1 ledgers are rejected", () => {
  const dir = project();
  const path = resolve(dir, "legacy.json");
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, events: [] }));
  assert.throws(() => new Ledger(dir, path), /schemaVersion 1 is not supported/);
});

test("tampering with a payload breaks the chain", () => {
  const dir = project();
  const ledger = makeLedger(dir);
  ledger.append({ kind: "test", nodeId: "execute", runId: "run_1", commandHash: "a" });
  ledger.append({ kind: "test", nodeId: "execute", runId: "run_2", commandHash: "b" });
  const path = resolve(dir, "provenance.json");
  const doc = readJson(path);
  doc.entries[0].payload.commandHash = "evil";
  writeFileSync(path, JSON.stringify(doc));
  const replayed = new Ledger(dir, path);
  assert.equal(replayed.verifyChain().valid, false);
  assert.match(replayed.verifyChain().errors.join(" "), /payloadHash mismatch/);
});

test("removing a middle entry breaks the chain", () => {
  const dir = project();
  const ledger = makeLedger(dir);
  ledger.append({ kind: "test", nodeId: "execute", runId: "run_1" });
  ledger.append({ kind: "test", nodeId: "execute", runId: "run_2" });
  ledger.append({ kind: "test", nodeId: "execute", runId: "run_3" });
  const path = resolve(dir, "provenance.json");
  const doc = readJson(path);
  doc.entries.splice(1, 1); // remove the middle entry
  writeFileSync(path, JSON.stringify(doc));
  const replayed = new Ledger(dir, path);
  assert.equal(replayed.verifyChain().valid, false);
});

test("appending after tampering is rejected because the chain no longer verifies", () => {
  const dir = project();
  const ledger = makeLedger(dir);
  ledger.append({ kind: "test", nodeId: "execute", runId: "run_1" });
  const path = resolve(dir, "provenance.json");
  const doc = readJson(path);
  doc.entries[0].payload.commandHash = "evil";
  writeFileSync(path, JSON.stringify(doc));
  const tampered = new Ledger(dir, path);
  assert.equal(tampered.verifyChain().valid, false);
});

test("reordering entries breaks the chain", () => {
  const dir = project();
  const ledger = makeLedger(dir);
  ledger.append({ kind: "test", nodeId: "execute", runId: "run_1" });
  ledger.append({ kind: "test", nodeId: "execute", runId: "run_2" });
  const path = resolve(dir, "provenance.json");
  const doc = readJson(path);
  doc.entries.reverse();
  writeFileSync(path, JSON.stringify(doc));
  const replayed = new Ledger(dir, path);
  assert.equal(replayed.verifyChain().valid, false);
});

test("finalize appends a signed finalize event and writes a chain head", async () => {
  const { finalize } = await import("../lib/engine.mjs");
  const { createSession, readState } = await import("../lib/session.mjs");
  const root = project();
  const { dir } = createSession("review", "Finalize head", root);
  // Drive review to terminal edge, then finalize.
  const { bindClaudeAdapter, recordClaudeEvent } = await import("../lib/attestation.mjs");
  const { sealNode } = await import("../lib/evidence.mjs");
  const { fileHash } = await import("../lib/util.mjs");
  const csid = "00000000-0000-4000-8000-000000000001";
  bindClaudeAdapter(dir, csid);
  let seq = 0;
  const attest = (path, agentId) => {
    for (const [hook, extra] of [["SubagentStart", {}], ["PostToolUse", { toolName: "Write", artifactPath: path, artifactHash: fileHash(path) }], ["SubagentStop", {}]]) {
      recordClaudeEvent(dir, { eventId: `ev-${seq++}`, hookEventName: hook, claudeSessionId: csid, agentId, agentType: "graphrail-reviewer", ...extra });
    }
  };
  const first = resolve(root, "a.md"); writeFileSync(first, "A\nVERDICT: PASS");
  const second = resolve(root, "b.md"); writeFileSync(second, "B\nVERDICT: PASS");
  attest(first, "agent-ledger-a");
  attest(second, "agent-ledger-b");
  sealNode(dir, [
    { type: "evaluation", path: first, actor: "one", agentRunId: "agent-ledger-a" },
    { type: "evaluation", path: second, actor: "two", agentRunId: "agent-ledger-b" },
  ]);
  const { advance } = await import("../lib/engine.mjs");
  advance(dir); // -> gate
  const { transition } = await import("../lib/engine.mjs");
  transition(dir, "PASS");
  finalize(dir);
  assert.equal(readState(dir).status, "completed");
  const provenance = new Ledger(dir, resolve(dir, "provenance.json"));
  const headCheck = provenance.verifyChain();
  assert.equal(headCheck.valid, true);
  const tail = provenance.tail();
  assert.equal(tail.payload.kind, "finalize");
  const head = readJson(resolve(dir, "chain-head.json"));
  assert.equal(head.eventHash, tail.eventHash);
  assert.equal(head.schemaVersion, 2);
});
