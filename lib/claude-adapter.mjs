import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { bindClaudeAdapter, readClaudeAdapter, recordClaudeEvent } from "./attestation.mjs";
import { readState } from "./session.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const marker = "GRAPHRAIL_HOOK_EVENT:";

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function hookSettings() {
  const command = `${shellQuote(process.execPath)} ${shellQuote(resolve(packageRoot, "bin", "graphrail-hook.mjs"))}`;
  const hook = { hooks: [{ type: "command", command }] };
  return {
    hooks: {
      SessionStart: [hook],
      SessionEnd: [hook],
      StopFailure: [hook],
      SubagentStart: [hook],
      SubagentStop: [hook],
      PostToolUse: [{ matcher: "Write|Edit", hooks: hook.hooks }],
    },
  };
}

function managedAgents() {
  return {
    "graphrail-implementer": {
      description: "Implement one scoped GraphRail work node and write concrete deliverables without reviewing your own work.",
      prompt: "Act only as the implementer. Follow repository instructions, make the smallest scoped change, run focused checks, and report exact deliverable paths. Do not perform the independent review role.",
      tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      model: "sonnet",
    },
    "graphrail-reviewer": {
      description: "Independently review one GraphRail node and write the requested evidence artifact.",
      prompt: "Act only as an independent reviewer. Do not modify source files. Verify claims with focused read-only probes and write your own concise evaluation to the exact requested path using Write or Edit. End it with one GraphRail VERDICT marker.",
      tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      model: "sonnet",
    },
  };
}

function decodeHookFrame(frame) {
  if (frame?.type !== "system" || frame?.subtype !== "hook_response" || typeof frame.stdout !== "string") return null;
  const line = frame.stdout.split(/\r?\n/).find((item) => item.startsWith(marker));
  if (!line) return null;
  const event = JSON.parse(Buffer.from(line.slice(marker.length), "base64url").toString("utf8"));
  return { ...event, eventId: frame.uuid || frame.hook_id || randomUUID() };
}

export async function runClaudeAdapter(sessionDir, options = {}) {
  const state = readState(sessionDir);
  if (state.status === "completed") return { launched: false, alreadyCompleted: true, status: state.status };
  const resume = options.resume === true;
  const binding = resume ? readClaudeAdapter(sessionDir) : bindClaudeAdapter(sessionDir, options.claudeSessionId || randomUUID());
  const temporary = mkdtempSync(resolve(tmpdir(), "graphrail-claude-"));
  const settingsPath = resolve(temporary, "settings.json");
  writeFileSync(settingsPath, `${JSON.stringify(hookSettings(), null, 2)}\n`, { mode: 0o600 });
  const args = [
    "-p", options.prompt || "Use /graphrail to continue the already initialized session until it is finalized.",
    "--output-format", "stream-json",
    "--include-hook-events",
    "--verbose",
    "--settings", settingsPath,
    "--agents", JSON.stringify(managedAgents()),
    "--max-budget-usd", String(options.maxBudgetUsd || 5),
  ];
  if (resume) args.push("--resume", binding.claudeSessionId);
  else args.push("--session-id", binding.claudeSessionId);
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  if (options.permissionMode) args.push("--permission-mode", options.permissionMode);
  if (options.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");

  const executable = options.executable || process.env.GRAPHRAIL_CLAUDE_BIN || "claude";
  const child = spawn(executable, args, {
    cwd: state.projectDir,
    env: { ...process.env, GRAPHRAIL_MANAGED: "1", GRAPHRAIL_SESSION: sessionDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exitPromise = new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveExit(code ?? 1));
  });
  let result = null;
  let assistantText = "";
  let hookEvents = 0;
  const stderr = [];
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderr.push(text);
    process.stderr.write(text);
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      const event = decodeHookFrame(frame);
      if (event) {
        recordClaudeEvent(sessionDir, event);
        hookEvents += 1;
      }
      if (frame.type === "assistant") {
        assistantText = (frame.message?.content || []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
      }
      if (frame.type === "result") result = frame;
    }
    const exitCode = await exitPromise;
    const finalState = readState(sessionDir);
    const graphrailCompleted = finalState.status === "completed";
    return {
      launched: true,
      resumed: resume,
      claudeSessionId: binding.claudeSessionId,
      hookEvents,
      exitCode,
      resultSubtype: result?.subtype || null,
      isError: graphrailCompleted ? false : (result?.is_error ?? exitCode !== 0),
      costUsd: result?.total_cost_usd ?? null,
      turns: result?.num_turns ?? null,
      effort: options.effort || null,
      assistantText,
      diagnostics: stderr.join("").trim() || null,
      graphrailStatus: finalState.status,
      currentNode: finalState.currentNode,
      runId: `run_${finalState.currentRun}`,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
