import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { withLock } from "../lib/lock.mjs";

test("live process lock blocks concurrent mutation", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "graphrail-lock-"));
  const path = resolve(dir, ".lock");
  writeFileSync(path, JSON.stringify({ pid: process.pid }));
  assert.throws(() => withLock(path, () => {}), /locked by pid/);
});

test("stale or corrupt lock can be reclaimed", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "graphrail-lock-"));
  const path = resolve(dir, ".lock");
  writeFileSync(path, "corrupt");
  let called = false;
  withLock(path, () => { called = true; });
  assert.equal(called, true);
});
