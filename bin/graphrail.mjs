#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { advance, finalize, gotoNode, route, stop, transition, validateChain, visualize } from "../lib/engine.mjs";
import { parseArtifact, recordTest, sealNode, validateHandshake } from "../lib/evidence.mjs";
import { createSession, listSessions, readState, resolveSession } from "../lib/session.mjs";
import { loadTemplate } from "../lib/templates.mjs";
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
    `  test --command <shell command>\n` +
    `  validate [handshake.json] | advance | finalize | viz [--json]\n` +
    `  stop | goto <node> | install claude\n`);
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
      const state = readState(session());
      json({ session: state.id, flow: state.flowId, task: state.task, currentNode: state.currentNode, runId: `run_${state.currentRun}`, status: state.status, steps: state.totalSteps, limits: state.template.limits });
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
      const started = Date.now();
      const executed = spawnSync(commandText, { cwd: projectDir, shell: true, encoding: "utf8", timeout: 120000 });
      const recorded = recordTest(session(), commandText, { exitCode: executed.status ?? 1, durationMs: Date.now() - started, stdout: executed.stdout || "", stderr: executed.stderr || "" });
      json({ recorded: true, path: recorded.path, exitCode: recorded.result.exitCode });
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
    case "help": case "--help": case "-h": case undefined: help(); break;
    default: throw new Error(`unknown command: ${command}`);
  }
} catch (error) {
  process.stderr.write(`graphrail: ${error.message}\n`);
  if (error.details) process.stderr.write(`${JSON.stringify(error.details)}\n`);
  process.exitCode = 1;
}
