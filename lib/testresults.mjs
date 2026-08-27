import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

// Zero-dependency parsers for structured test statistics. GraphRail never
// guesses a PASS from an exit code alone: it needs structured counts from a
// recognized runner format, or an explicit --result-file contract. Anything
// unparseable fails closed (structured: false) so the result cannot PASS.

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseTap(text) {
  let tests = null;
  let pass = null;
  let fail = null;
  let executed = 0;
  // Node's spec reporter emits "ℹ tests N / ℹ pass N / ℹ fail N" summary lines.
  // TAP emits "# tests N / # pass N / # fail N". Match either prefix.
  const summary = /^\s*(?:#|ℹ|i|I)\s*(tests|pass|fail)\s+(\d+)/i;
  for (const line of text.split(/\r?\n/)) {
    const summaryMatch = line.match(summary);
    if (summaryMatch) {
      const key = summaryMatch[1].toLowerCase();
      const count = Number(summaryMatch[2]);
      if (key === "tests") tests = count;
      else if (key === "pass") pass = count;
      else if (key === "fail") fail = count;
    } else if (/^\s*(?:ok|not ok)\s/.test(line)) {
      executed += 1;
    }
  }
  // Fall back to counting ok/not ok lines when a summary header is missing.
  const passCount = pass ?? 0;
  const failCount = fail ?? 0;
  if (tests === null && executed === 0) return null;
  const resolvedTests = tests ?? executed;
  if (pass === null && fail === null) {
    // Count not ok lines from the stream.
    let notOk = 0;
    for (const line of text.split(/\r?\n/)) if (/^\s*not ok\s/.test(line)) notOk += 1;
    return { testsDiscovered: resolvedTests, testsExecuted: resolvedTests, testsPassed: resolvedTests - notOk, testsFailed: notOk };
  }
  if (pass === null || fail === null) return null;
  if (pass + fail !== resolvedTests) return null;
  return { testsDiscovered: resolvedTests, testsExecuted: resolvedTests, testsPassed: pass, testsFailed: fail };
}

function parseJsonStats(text) {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  // Jest / Vitest --json aggregate shape.
  if (typeof value.numTotalTests === "number" && typeof value.numPassedTests === "number" && typeof value.numFailedTests === "number") {
    const executed = value.numTotalTests - (value.numPendingTests || 0) - (value.numTodoTests || 0);
    return { testsDiscovered: value.numTotalTests, testsExecuted: executed, testsPassed: value.numPassedTests, testsFailed: value.numFailedTests };
  }
  return null;
}

function attr(node, name) {
  const match = node.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`));
  return match ? match[1] : null;
}

function parseJunit(text) {
  const suites = [...text.matchAll(/<testsuite\b[^>]*>/g)].map((match) => match[0]);
  if (suites.length === 0) return null;
  let tests = 0;
  let failures = 0;
  let errors = 0;
  let skipped = 0;
  for (const suite of suites) {
    const suiteTests = attr(suite, "tests");
    const suiteFailures = attr(suite, "failures");
    const suiteErrors = attr(suite, "errors");
    const suiteSkipped = attr(suite, "skipped");
    if (suiteTests !== null) tests += Number(suiteTests);
    if (suiteFailures !== null) failures += Number(suiteFailures);
    if (suiteErrors !== null) errors += Number(suiteErrors);
    if (suiteSkipped !== null) skipped += Number(suiteSkipped);
  }
  if (tests === 0 && suites.length > 0 && attr(suites[0], "tests") !== null) {
    // Suite with explicit tests="0" is a real zero-case result.
    return { testsDiscovered: 0, testsExecuted: 0, testsPassed: 0, testsFailed: 0 };
  }
  // Count <testcase> elements when suites omit numeric attributes.
  const cases = (text.match(/<testcase\b/g) || []).length;
  if (cases > 0 && tests === 0) tests = cases;
  return { testsDiscovered: tests, testsExecuted: tests - skipped, testsPassed: tests - skipped - failures - errors, testsFailed: failures + errors };
}

// GraphRail's own structured result contract (--format graphrail-json).
function parseGraphRailJson(text) {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  const required = ["testsDiscovered", "testsExecuted", "testsPassed", "testsFailed"];
  if (!required.every((key) => typeof value[key] === "number")) return null;
  return { testsDiscovered: value.testsDiscovered, testsExecuted: value.testsExecuted, testsPassed: value.testsPassed, testsFailed: value.testsFailed, testPlanCoverage: Array.isArray(value.testPlanCoverage) ? value.testPlanCoverage : null };
}

export function parseTestOutput(text, { format = null } = {}) {
  if (format === "graphrail-json" || format === "json") {
    const parsed = parseGraphRailJson(text);
    return parsed ? { ...parsed, structured: true, format: "graphrail-json" } : { structured: false, format };
  }
  if (format === "junit" || format === "junit-xml") {
    const parsed = parseJunit(text);
    return parsed ? { ...parsed, structured: true, format: "junit" } : { structured: false, format };
  }
  if (format === "tap") {
    const parsed = parseTap(text);
    return parsed ? { ...parsed, structured: true, format: "tap" } : { structured: false, format };
  }
  // Auto-detect: GraphRail JSON first, then Jest/Vitest JSON, then JUnit, then TAP.
  const graphrail = parseGraphRailJson(text);
  if (graphrail) return { ...graphrail, structured: true, format: "graphrail-json" };
  const jest = parseJsonStats(text);
  if (jest) return { ...jest, structured: true, format: "jest-vitest" };
  const junit = parseJunit(text);
  if (junit) return { ...junit, structured: true, format: "junit" };
  const tap = parseTap(text);
  if (tap) return { ...tap, structured: true, format: "tap" };
  return { structured: false };
}

const IGNORED_DIRS = new Set([".git", ".graphrail", "node_modules"]);
const IGNORED_FILES = new Set([".graphrailignore", ".lock"]);

// A mutation probe proves the test suite has fault sensitivity: it mutates a
// target file, re-runs the command, and requires the suite to turn red. The
// original bytes are always restored, even on failure. This is the third tier
// of test truth (Execution validity -> Coverage relevance -> Fault sensitivity).
//
// The mutation is deliberately crude and deterministic: append a top-level throw
// to the target module. Any test that imports or exercises the module must fail,
// so a green probe means the suite never touched the file (vacuous coverage).
export function runMutationProbe(filePath, command, projectDir, { timeoutMs = 120000 } = {}) {
  if (!existsSync(filePath)) throw new Error(`probe target not found: ${filePath}`);
  const original = readFileSync(filePath);
  // When GraphRail runs inside another test runner, a nested `node --test` inherits
  // NODE_TEST_CONTEXT=child-v8 and suppresses non-zero exits. Clear it so the probe
  // sees the real exit code, and strip NODE_OPTIONS that could alter the command.
  const cleanEnv = { ...process.env };
  delete cleanEnv.NODE_TEST_CONTEXT;
  delete cleanEnv.NODE_OPTIONS;
  const spawnOptions = { cwd: projectDir, shell: true, encoding: "utf8", timeout: timeoutMs, env: cleanEnv };
  const baseline = spawnSync(command, spawnOptions);
  const baselineRed = baseline.status !== 0;
  try {
    // Keep the original bytes in memory (never create a backup file on disk, which
    // a test runner may scan or clean), write the mutated module, run, then restore.
    const mutated = `${String(original).trimEnd()}\n;throw new Error("graphrail mutation probe");\n`;
    writeFileSync(filePath, mutated);
    const probe = spawnSync(command, spawnOptions);
    const probeRed = probe.status !== 0;
    return {
      file: filePath,
      mutated: true,
      baselineExitCode: baseline.status,
      probeExitCode: probe.status,
      detected: baselineRed === false && probeRed === true,
    };
  } finally {
    writeFileSync(filePath, original);
  }
}

export function workingTreeHash(projectDir) {
  const entries = [];
  const walk = (dir) => {
    let children;
    try { children = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of children) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (IGNORED_FILES.has(entry.name)) continue;
      const abs = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) {
        const rel = relative(projectDir, abs);
        let content;
        try { content = readFileSync(abs); } catch { continue; }
        entries.push(`${rel}\t${sha256(content)}`);
      }
    }
  };
  walk(projectDir);
  entries.sort();
  return sha256(entries.join("\n"));
}
