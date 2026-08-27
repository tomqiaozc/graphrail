# GraphRail

GraphRail is a zero-dependency, deterministic graph harness for evidence-backed agent workflows. Agents decide how to do work; GraphRail decides whether a workflow may advance.

> **Status: Production candidate.** The deterministic Harness, managed Claude adapter, explicit review/design gates, full-role attestation, structured test evidence with mutation-probe sensitivity, hash-chained ledgers, package installation, interruption recovery, and all four real-flow acceptance fixtures pass. The remaining boundary is documented in [VALIDATION.md](VALIDATION.md): GraphRail does not defend against a malicious process with unrestricted access to the same OS account.

## Why it exists

Long agent workflows tend to fail in repeatable ways: a worker reviews its own output, a stale artifact is mistaken for the latest result, a test report is accepted without proving which command produced it, or a repair loop consumes the entire session. GraphRail turns those lessons into executable constraints:

- every node run has an exact identity;
- reviews need independent, distinct evidence;
- review verdicts and test exit codes are mechanically aggregated at gates;
- test results are bound to the command and run that produced them;
- gates fail closed when evidence is missing or stale;
- edges, nodes, repairs, and total steps have explicit budgets;
- state is signed, atomically written, resumable, and protected by a process lock.

This is intentionally a harness, not an agent framework. Flow files cannot execute code. Model invocation, tools, and prompts remain the responsibility of an adapter such as the included Claude Code skill.

## Install

```bash
npm install -g github:tomqiaozc/graphrail
graphrail install claude
```

The bare npm package has not been published yet; the GitHub install above is the supported installation path. Node.js 18 or newer is required.

For trusted Claude review provenance, launch work through the managed adapter:

```bash
graphrail claude --flow quick --task "Add input validation" --max-budget-usd 20

# Resume the same Claude and GraphRail sessions after an API interruption.
graphrail claude --resume --max-budget-usd 20
```

The adapter initializes the GraphRail session, assigns a stable Claude session ID, records structured lifecycle hook events, and binds reviewer-written artifacts to exact subagent runs. Direct `/graphrail` use remains useful for exploration, but review gates fail closed unless trusted adapter evidence is present.

Managed runs preserve the caller's reasoning-effort setting and use dedicated Sonnet implementer, reviewer, and test-designer agents by default. Role isolation is enforced at the gates: an implementer cannot review its own change, a test designer cannot attest its own execution, and reusing one agent ID under a different actor label does not bypass the check. This intentionally favors independent review quality over minimum model cost. Use `--effort <level>` to override reasoning effort deliberately.

`--max-budget-usd` is an external safety ceiling required by Claude Code, not a GraphRail quality target. GraphRail records model cost for diagnostics but never weakens reviewers, evidence requirements, or gates to meet a cost goal.

## Built-in flows

Every flow places a mechanical gate after each evidence-producing node, so quality verdicts (FAIL/ITERATE) route back to the work node immediately instead of deferring to a final gate. Review and test-design nodes record only that the work was *completed* (their handshake is always PASS); the gate that follows is the single authority on whether the evidence supports advancing.

| Flow | Path | Best for |
|---|---|---|
| `quick` | build → review → **gate-review** → test-design → **gate-test-design** → test-execute → gate | Small, low-risk changes |
| `review` | review → gate → result | Independent inspection that terminates with PASS, ITERATE, FAIL, or BLOCKED |
| `build` | brief → build → code-review → **gate-code-review** → test-design → **gate-test-design** → test-execute → gate | Full implementation with review and verification |
| `verify` | acceptance → gate-acceptance → audit → gate-audit → e2e-user → gate-e2e | Release readiness of existing work |

Repair paths are encoded in each flow and visible with `graphrail viz --flow <name>`.

## CLI walkthrough

```bash
graphrail init --flow build --task "Add signed download links"
graphrail status
graphrail viz

# Produce files for the current node, then seal the exact run.
graphrail seal --verdict PASS --artifact plan:/tmp/brief.md:architect
graphrail advance

# Review nodes require distinct actors, distinct content, and distinct subagent runs.
graphrail seal --verdict PASS \
  --artifact evaluation:/tmp/review-a.md:security:agent_12ab34cd \
  --artifact evaluation:/tmp/review-b.md:tester:agent_56ef78ab

# Execute nodes accept only harness-recorded, structurally parsed test results.
# A PASS is rejected when testsExecuted === 0 unless the node declares allowZeroTests.
graphrail test --command "node --test"            # auto-parses TAP/Jest/JUnit
graphrail test --command "custom" --result-file result.json --format graphrail-json
graphrail test --command "node --test" --probe lib/add.mjs   # fault-sensitivity probe
graphrail seal --verdict PASS \
  --artifact test-result:.graphrail/sessions/SESSION/nodes/test-execute/run_N/test-execution.json:graphrail

# At a gate, advance revalidates the chain and mechanically aggregates evidence.
graphrail advance
graphrail finalize  # seals a signed chain head
```

Commands emit JSON to stdout. Diagnostics go to stderr. Use `--project <dir>` when the target project is not the current directory, or `--session <path>` to address a specific session.

## Custom flows

Custom flows are JSON documents with a deliberately small ABI:

```json
{
  "schemaVersion": 1,
  "id": "docs-check",
  "entry": "write",
  "nodes": {
    "write": { "kind": "work" },
    "review": {
      "kind": "review",
      "evidence": ["evaluation"],
      "minReviewers": 2,
      "prompt": "./prompts/review.md"
    },
    "gate-review": { "kind": "gate" },
    "gate": { "kind": "gate" }
  },
  "transitions": {
    "write": { "PASS": "review" },
    "review": { "PASS": "gate-review" },
    "gate-review": { "PASS": "gate", "FAIL": "write", "ITERATE": "write" },
    "gate": { "PASS": null, "FAIL": "write", "ITERATE": "review" }
  },
  "limits": {
    "maxEdgeVisits": 3,
    "maxNodeVisits": 5,
    "maxSteps": 20
  }
}
```

Supported node kinds are `plan`, `work`, `review`, `execute`, and `gate`. Review and test-design nodes always seal PASS (work completed); the gate that follows each is the single authority on quality and owns the FAIL/ITERATE edges. Optional node fields include `agentType` (implementer/reviewer/test-designer), `allowZeroTests`, `requiresTestPlanHash`, and `requireMutationProbe`. Prompt paths must remain inside the template directory. Unknown nodes, invalid verdicts, unreachable nodes, missing terminal edges, unsafe keys, and path traversal are rejected before session creation.

Templates declare contracts only. They cannot contain commands, JavaScript hooks, or executable callbacks.

## State model

Each target project receives a local `.graphrail/` directory containing session state, exact node runs, handshakes, copied artifacts, and a chained signed provenance ledger. It should not be committed. `graphrail ls` discovers sessions and `graphrail validate` checks the recorded chain.

A gate is not a ceremonial node. `graphrail advance` at a gate revalidates the nearest upstream exact-run handshakes and artifact hashes, recomputes the verdict, and follows the matching edge. If any authoritative evidence has changed, advancement stops.

Each evaluation artifact must contain `VERDICT: PASS`, `VERDICT: ITERATE`, `VERDICT: FAIL`, or `VERDICT: BLOCKED` (JSON with a `verdict` field is also accepted). Gates aggregate these markers with fail-closed precedence and reject a requested verdict that does not match the evidence. Because review and test-design nodes always seal PASS (work completed), the *nearest* gate is the single authority on quality: FAIL/ITERATE in an evaluation routes back to the build node immediately, not after the whole flow drains.

Review handshakes also require distinct attested subagent run IDs. Actor labels and model-authored IDs are not accepted as proof of independence. Each evaluation hash must match a Write/Edit event between that reviewer's trusted lifecycle start and completion; a failed subagent cannot be replaced by an evaluation authored by the orchestrator. The same binding now applies to implementer deliverables and test-design artifacts, and role isolation is enforced across nodes: an implementer cannot later review the same change, a test designer cannot attest its own execution, and reusing one agent ID under a different actor label does not bypass the check.

Test execution binds the plan, command, code tree, and result together. `graphrail test` records a `test-execution.json` with the authoritative `testPlanHash`, `commandHash`, a `workingTreeHash` captured before and after the run (a changed tree is rejected), structured counts parsed from the runner output, and optional `testPlanCoverage` and mutation `probes`. PASS requires `testsExecuted > 0` unless the node declares `allowZeroTests`; results without structured statistics cannot PASS. Test truth is layered: execution validity (structural counts), coverage relevance (required test-plan case IDs), and fault sensitivity (mutation probes that must turn the suite red).

```json
{
  "schemaVersion": 2,
  "nodeId": "test-execute",
  "runId": "run_6",
  "testPlanHash": "46c7fb0a...",
  "command": "node --test",
  "commandHash": "f90321a3...",
  "workingTreeHash": "cd9370d8...",
  "exitCode": 0,
  "testsDiscovered": 2,
  "testsExecuted": 2,
  "testsPassed": 2,
  "testsFailed": 0,
  "testPlanCoverage": ["AUTH-NEG-01"],
  "probes": [{ "file": "lib/calc.mjs", "detected": true }]
}
```

Ledgers are real hash chains: every entry carries `sequence`, `previousEventHash`, `payloadHash`, `eventHash`, and an HMAC `signature`. Appends bind to the current head; `verifyChain()` detects truncation, insertion, deletion, and reordering; a finalized session records a signed `chain-head.json`. The chain detects accidental tampering and model-text forgery by an ordinary orchestrator — it does **not** protect against a malicious process with unrestricted access to the same operating-system account, which could read `.session-key` and recompute every signature. Use OS-level isolation when that attacker is in scope.

The managed adapter raises the provenance boundary from model-authored text to Claude Code's structured hook stream. It does not claim protection from a malicious process with unrestricted access to the same operating-system account; use OS sandboxing when that is part of the threat model.

## Development

```bash
npm test
npm run test:pack
```

GraphRail is available under the MIT License.
