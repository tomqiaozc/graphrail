import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const cli = resolve(import.meta.dirname, "..", "bin", "graphrail.mjs");
function project() { return mkdtempSync(resolve(tmpdir(), "graphrail-cli-")); }
function run(args, cwd) { return JSON.parse(execFileSync("node", [cli, ...args], { cwd, encoding: "utf8" })); }

test("CLI initializes, reports status, and visualizes JSON", () => {
  const cwd = project();
  assert.equal(run(["init", "--flow", "quick", "--task", "Patch"], cwd).created, true);
  assert.equal(run(["status"], cwd).currentNode, "build");
  assert.equal(run(["status"], cwd).trustedAdapter, false);
  assert.match(run(["status"], cwd).artifactDir, /nodes\/build\/run_1$/);
  assert.equal(run(["viz", "--json"], cwd).flow, "quick");
  assert.equal(run(["ls"], cwd).sessions.length, 1);
});

test("CLI rejects sealing a non-current node", () => {
  const cwd = project();
  run(["init", "--flow", "quick", "--task", "Patch"], cwd);
  const result = spawnSync("node", [cli, "seal", "--node", "review"], { cwd, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /non-current/);
});

test("Claude adapter installs into an isolated home", () => {
  const cwd = project();
  const home = resolve(cwd, "home");
  const result = JSON.parse(execFileSync("node", [cli, "install", "claude"], { cwd, env: { ...process.env, HOME: home }, encoding: "utf8" }));
  assert.equal(result.installed, true);
});
