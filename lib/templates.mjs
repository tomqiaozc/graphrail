import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE_KINDS, VERDICTS } from "./util.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);

export const BUILTIN_NAMES = ["quick", "review", "build", "verify"];
export const AGENT_TYPES = new Set(["graphrail-implementer", "graphrail-reviewer", "graphrail-test-designer"]);

function plain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inside(base, target) {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function validateTemplate(template, baseDir = process.cwd()) {
  const errors = [];
  if (!plain(template)) return ["template must be an object"];
  const topLevelFields = new Set(["schemaVersion", "id", "entry", "nodes", "transitions", "limits"]);
  for (const field of Object.keys(template)) {
    if (!topLevelFields.has(field)) errors.push(`unknown template field: ${field}`);
  }
  if (template.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (typeof template.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(template.id)) errors.push("id must be a kebab-case string");
  if (!plain(template.nodes) || Object.keys(template.nodes).length === 0) errors.push("nodes must be a non-empty object");
  if (!plain(template.transitions)) errors.push("transitions must be an object");
  if (!plain(template.limits)) errors.push("limits must be an object");
  if (errors.length) return errors;

  const nodeIds = Object.keys(template.nodes);
  if (nodeIds.some((id) => forbiddenKeys.has(id))) errors.push("node id uses a forbidden key");
  if (!nodeIds.includes(template.entry)) errors.push("entry must reference a node");
  for (const [id, node] of Object.entries(template.nodes)) {
    if (!plain(node)) { errors.push(`node ${id} must be an object`); continue; }
    const nodeFields = new Set(["kind", "prompt", "evidence", "minReviewers", "agentType", "allowZeroTests", "requiresTestPlanHash", "requireMutationProbe"]);
    for (const field of Object.keys(node)) {
      if (!nodeFields.has(field)) errors.push(`node ${id} has unknown field: ${field}`);
    }
    if (!NODE_KINDS.has(node.kind)) errors.push(`node ${id} has invalid kind`);
    if (node.agentType !== undefined && !AGENT_TYPES.has(node.agentType)) errors.push(`node ${id} has invalid agentType: ${node.agentType}`);
    if (node.allowZeroTests !== undefined && typeof node.allowZeroTests !== "boolean") errors.push(`node ${id} allowZeroTests must be a boolean`);
    if (node.requiresTestPlanHash !== undefined && typeof node.requiresTestPlanHash !== "boolean") errors.push(`node ${id} requiresTestPlanHash must be a boolean`);
    if (node.requireMutationProbe !== undefined && typeof node.requireMutationProbe !== "boolean") errors.push(`node ${id} requireMutationProbe must be a boolean`);
    if (node.prompt !== undefined) {
      if (typeof node.prompt !== "string" || isAbsolute(node.prompt)) errors.push(`node ${id} prompt must be relative`);
      else {
        const promptPath = resolve(baseDir, node.prompt);
        if (!inside(baseDir, promptPath)) errors.push(`node ${id} prompt escapes template directory`);
        else if (!existsSync(promptPath)) errors.push(`node ${id} prompt does not exist`);
        else if (!inside(realpathSync(baseDir), realpathSync(promptPath))) errors.push(`node ${id} prompt symlink escapes template directory`);
      }
    }
    if (node.evidence !== undefined && (!Array.isArray(node.evidence) || !node.evidence.every((item) => typeof item === "string"))) errors.push(`node ${id} evidence must be an array of strings`);
    if (node.minReviewers !== undefined && (!Number.isInteger(node.minReviewers) || node.minReviewers < 1)) errors.push(`node ${id} minReviewers must be a positive integer`);
  }
  let terminalEdges = 0;
  for (const [source, routes] of Object.entries(template.transitions)) {
    if (!nodeIds.includes(source)) { errors.push(`transition source ${source} is unknown`); continue; }
    if (!plain(routes)) { errors.push(`transitions for ${source} must be an object`); continue; }
    for (const [verdict, target] of Object.entries(routes)) {
      if (!VERDICTS.has(verdict)) errors.push(`transition ${source} has invalid verdict ${verdict}`);
      if (target === null) terminalEdges += 1;
      else if (!nodeIds.includes(target)) errors.push(`transition target ${target} is unknown`);
    }
  }
  if (terminalEdges === 0) errors.push("flow must contain a terminal transition");
  for (const key of ["maxEdgeVisits", "maxNodeVisits", "maxSteps"]) {
    if (!Number.isInteger(template.limits[key]) || template.limits[key] < 1) errors.push(`limits.${key} must be a positive integer`);
  }
  if (nodeIds.includes(template.entry)) {
    const seen = new Set([template.entry]);
    const queue = [template.entry];
    while (queue.length) {
      const source = queue.shift();
      for (const target of Object.values(template.transitions[source] || {})) {
        if (target !== null && !seen.has(target)) { seen.add(target); queue.push(target); }
      }
    }
    const unreachable = nodeIds.filter((id) => !seen.has(id));
    if (unreachable.length) errors.push(`unreachable nodes: ${unreachable.join(", ")}`);
  }
  return errors;
}

export function loadTemplate(nameOrPath) {
  const builtin = BUILTIN_NAMES.includes(nameOrPath);
  const path = builtin ? resolve(root, "flows", `${nameOrPath}.json`) : resolve(nameOrPath);
  if (!existsSync(path)) throw new Error(`flow not found: ${nameOrPath}`);
  const canonicalPath = realpathSync(path);
  const template = JSON.parse(readFileSync(canonicalPath, "utf8"));
  const errors = validateTemplate(template, dirname(canonicalPath));
  if (errors.length) throw new Error(`invalid flow: ${errors.join("; ")}`);
  return { template, path: canonicalPath, builtin };
}
