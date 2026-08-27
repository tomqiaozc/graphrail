#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { advance, finalize, gotoNode, route, stop, transition, validateChain, visualize } from "../lib/engine.mjs";
import { parseArtifact, recordTest, sealNode, testPlanHashForRun, validateHandshake } from "../lib/evidence.mjs";
import { createSession, listSessions, readState, resolveSession, runDir } from "../lib/session.mjs";
import { loadTemplate } from "../lib/templates.mjs";
import { runClaudeAdapter } from "../lib/claude-adapter.mjs";
import { parseTestOutput, runMutationProbe, workingTreeHash } from "../lib/testresults.mjs";
import { flag, flags, json, readJson } from "../lib/util.mjs";

const args = process.argv.slice(2);
const command = args.shift();
const projectDir = resolve(flag(args, "project", process.cwd()));
const explicitSession = flag(args, "session");
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function session() { return resolveSession(projectDir, explicitSession); }

function help() {
  process.stdout.write(`GraphRail — deterministic graph harness\n\n` +
    `Commands:\n` +
    `  init --flow <name|file> --task <text> [--project <dir>]\n` +
    `  status | ls | route --verdict <V> | transition --verdict <V>\n` +
    `  seal [--node <id>] --verdict <V> --artifact <type:path:actor:agentRunId>...\n` +
    `  test --command <shell> [--result-file <path> --format <fmt>] [--allow-zero-tests] [--probe <file>] [--timeout-ms <ms>]\n` +
    `  validate [handshake.json] | advance | finalize | viz [--json]\n` +
    `  stop | goto <node> | install claude\n` +
    `  claude --flow <name|file> --task <text> --max-budget-usd <amount>\n` +
    `  claude --resume [--max-budget-usd <amount>]\n`);
}

try {
  switch (command) {
    case "init": {
      const flow = flag(args, "flow");
      const task = flag(args, "task", "");
      if (!flow) throw new Error("--flow is required");
      const created = createSession(flow, task, projectDir);
      json({ created: true, dir: created.dir, flow: created.state.flowId, currentNode: created.state.currentNode, runId: "run_1" });
      break;
    }
    case "status": {
      const sessionDir = session();
      const state = readState(sessionDir);
      json({ session: state.id, sessionDir, flow: state.flowId, task: state.task, currentNode: state.currentNode, runId: `run_${state.currentRun}`, artifactDir: runDir(sessionDir, state.currentNode, state.currentRun), trustedAdapter: existsSync(resolve(sessionDir, "adapter.json")), status: state.status, steps: state.totalSteps, limits: state.template.limits });
      break;
    }
    case "ls": json({ sessions: listSessions(projectDir) }); break;
    case "route": json(route(session(), String(flag(args, "verdict", "")).toUpperCase())); break;
    case "transition": json(transition(session(), String(flag(args, "verdict", "")).toUpperCase())); break;
    case "seal": {
      const state = readState(session());
      const requestedNode = flag(args, "node", state.currentNode);
      if (requestedNode !== state.currentNode) throw new Error(`cannot seal non-current node: ${requestedNode}`);
      const artifacts = flags(args, "artifact").map(parseArtifact);
      const verdict = String(flag(args, "verdict", "PASS")).toUpperCase();
      json(sealNode(session(), artifacts, verdict, flag(args, "summary", "Node completed")));
      break;
    }
    case "test": {
      const commandText = flag(args, "command");
      if (!commandText) throw new Error("--command is required");
      const resultFile = flag(args, "result-file");
      const format = flag(args, "format");
      const allowZeroTests = args.includes("--allow-zero-tests");
      const timeoutMs = Number(flag(args, "timeout-ms", 120000));
      const probes = flags(args, "probe");
      const startedAt = new Date().toISOString();
      const beforeHash = workingTreeHash(projectDir);
      const started = Date.now();
      const executed = spawnSync(commandText, { cwd: projectDir, shell: true, encoding: "utf8", timeout: timeoutMs });
      const afterHash = workingTreeHash(projectDir);
      const stdout = executed.stdout || "";
      const stderr = executed.stderr || "";
      const exitCode = executed.signal ? 1 : (executed.status ?? 1);
      // Structured stats: prefer an explicit result file, then parse the runner output.
      let tests = null;
      let testFormat = format || null;
      if (resultFile) {
        if (!existsSync(resultFile)) throw new Error(`result file not found: ${resultFile}`);
        const parsed = parseTestOutput(readFileSync(resultFile, "utf8"), { format });
        if (!parsed.structured) throw new Error(`unparseable test result file: ${resultFile}`);
        tests = parsed;
        testFormat = parsed.format;
      } else {
        const parsed = parseTestOutput(`${stdout}\n${stderr}`, { format });
        if (parsed.structured) { tests = parsed; testFormat = parsed.format; }
      }
      const state = readState(session());
      const node = state.template.nodes[state.currentNode];
      const allowZero = allowZeroTests || node?.allowZeroTests === true;
      const sessionDir = session();
      const testPlanHash = testPlanHashForRun(sessionDir, state.currentNode, `run_${state.currentRun}`);
      // Mutation probes prove fault sensitivity: a real mutation must turn the suite red.
      const probeResults = [];
      for (const probeTarget of probes) {
        const probeResult = runMutationProbe(probeTarget, commandText, projectDir, { timeoutMs });
        probeResults.push(probeResult);
        if (probeResult.detected !== true) {
          process.stderr.write(`graphrail: mutation probe on ${probeTarget} was NOT detected (baseline exit ${probeResult.baselineExitCode}, probe exit ${probeResult.probeExitCode})\n`);
          process.exitCode = 1;
        }
      }
      const recorded = recordTest(sessionDir, commandText, {
        exitCode,
        startedAt,
        finishedAt: new Date().toISOString(),
        stdout,
        stderr,
        workingTreeHash: beforeHash === afterHash ? beforeHash : null,
        workingTreeChanged: beforeHash !== afterHash,
        tests,
        testFormat,
        testPlanHash,
        probes: probeResults.length ? probeResults : null,
      });
      const requiresProbe = node?.requireMutationProbe === true;
      if (requiresProbe && probeResults.length === 0) {
        process.stderr.write("graphrail: node requires a mutation probe but none was supplied (--probe)\n");
        process.exitCode = 1;
      }
      const blocked = !allowZero && tests && tests.testsExecuted === 0 ? "blocked: zero tests executed" : null;
      json({ recorded: true, path: recorded.path, exitCode, tests, testFormat, probes: probeResults, workingTreeChanged: beforeHash !== afterHash, blocked });
      if (beforeHash !== afterHash) { process.stderr.write("graphrail: working tree changed during test execution\n"); process.exitCode = 1; }
      if (blocked) process.exitCode = 1;
      break;
    }
    case "validate": {
      const positional = args.find((item) => !item.startsWith("--"));
      if (!positional) json(validateChain(session()));
      else {
        const handshake = readJson(resolve(positional));
        const errors = validateHandshake(session(), handshake);
        json({ valid: errors.length === 0, errors });
      }
      break;
    }
    case "advance": json(advance(session())); break;
    case "finalize": json(finalize(session())); break;
    case "stop": json(stop(session())); break;
    case "goto": {
      const node = args.find((item) => !item.startsWith("--"));
      if (!node) throw new Error("node is required");
      json(gotoNode(session(), node));
      break;
    }
    case "viz": {
      const state = explicitSession || existsSync(resolve(projectDir, ".graphrail", "latest.json")) ? readState(session()) : null;
      const loaded = state ? { template: state.template } : loadTemplate(flag(args, "flow", "build"));
      if (args.includes("--json")) json({ flow: loaded.template.id, currentNode: state?.currentNode || null, template: loaded.template });
      else process.stdout.write(`${visualize(loaded.template, state?.currentNode)}\n`);
      break;
    }
    case "install": {
      if (args[0] !== "claude") throw new Error("supported adapter: claude");
      const target = resolve(homedir(), ".claude", "skills", "graphrail");
      mkdirSync(target, { recursive: true });
      cpSync(resolve(packageRoot, "skill", "SKILL.md"), resolve(target, "SKILL.md"));
      cpSync(resolve(packageRoot, "roles"), resolve(target, "roles"), { recursive: true, force: true });
      json({ installed: true, adapter: "claude", path: target });
      break;
    }
    case "claude": {
      const resume = args.includes("--resume");
      let sessionDir;
      let task;
      let flow;
      if (resume) {
        sessionDir = session();
        const state = readState(sessionDir);
        task = state.task;
        flow = state.flowId;
      } else {
        flow = flag(args, "flow");
        task = flag(args, "task", "");
        if (!flow) throw new Error("--flow is required");
        if (!task) throw new Error("--task is required");
        sessionDir = createSession(flow, task, projectDir).dir;
      }
      const budget = Number(flag(args, "max-budget-usd", 5));
      if (!Number.isFinite(budget) || budget <= 0) throw new Error("--max-budget-usd must be positive");
      const prompt = resume
        ? "Use /graphrail to resume the already initialized session. Continue from the authoritative current node until finalize; do not restart completed work."
        : `Use /graphrail to execute the already initialized ${flow} session for this task: ${task}. Continue until finalize; do not create another session.`;
      const result = await runClaudeAdapter(sessionDir, {
        resume,
        prompt,
        maxBudgetUsd: budget,
        model: flag(args, "model"),
        effort: flag(args, "effort"),
        permissionMode: flag(args, "permission-mode"),
        dangerouslySkipPermissions: args.includes("--dangerously-skip-permissions"),
      });
      json(result);
      if (result.isError) process.exitCode = 1;
      break;
    }
    case "help": case "--help": case "-h": case undefined: help(); break;
    default: throw new Error(`unknown command: ${command}`);
  }
} catch (error) {
  process.stderr.write(`graphrail: ${error.message}\n`);
  if (error.details) process.stderr.write(`${JSON.stringify(error.details)}\n`);
  process.exitCode = 1;
}
