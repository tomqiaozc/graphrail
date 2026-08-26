import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const ignored = new Set([".git", ".graphrail", "node_modules"]);
const textExtensions = new Set([".md", ".mjs", ".json", ".yml", ".yaml", ".sh", ""]);
const legacyWord = [111, 112, 99].map((value) => String.fromCharCode(value)).join("");
const legacyOwner = [105, 97, 109, 116, 111, 117, 99, 104, 115, 107, 121, 101, 114].map((value) => String.fromCharCode(value)).join("");

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (ignored.has(entry.name)) return [];
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

test("repository contains no legacy identity markers", () => {
  const violations = [];
  for (const path of files(root)) {
    if (!textExtensions.has(extname(path))) continue;
    const text = readFileSync(path, "utf8").toLowerCase();
    const wordPattern = new RegExp(`\\b${legacyWord}\\b`, "i");
    if (wordPattern.test(text) || text.includes(legacyOwner)) violations.push(path.slice(root.length + 1));
  }
  assert.deepEqual(violations, []);
});
