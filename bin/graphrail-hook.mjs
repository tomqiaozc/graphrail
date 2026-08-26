#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sha256 } from "../lib/util.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

try {
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const event = {
    hookEventName: input.hook_event_name,
    claudeSessionId: input.session_id,
    agentId: input.agent_id || null,
    agentType: input.agent_type || null,
    toolName: input.tool_name || null,
    source: input.source || null,
  };
  const candidate = input.tool_input?.file_path;
  if (candidate && existsSync(resolve(candidate))) {
    event.artifactPath = resolve(candidate);
    event.artifactHash = sha256(readFileSync(event.artifactPath));
  }
  process.stdout.write(`GRAPHRAIL_HOOK_EVENT:${Buffer.from(JSON.stringify(event)).toString("base64url")}\n`);
} catch (error) {
  process.stderr.write(`graphrail hook: ${error.message}\n`);
  process.exitCode = 1;
}
