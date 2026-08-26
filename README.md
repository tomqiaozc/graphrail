# GraphRail

GraphRail is a zero-dependency, deterministic graph harness for evidence-backed agent workflows. Agents decide how to do work; GraphRail decides whether a workflow may advance.

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
npm install -g graphrail
graphrail install claude
```

Node.js 18 or newer is required.

## Built-in flows

| Flow | Path | Best for |
|---|---|---|
| `quick` | build → review → test-design → test-execute → gate | Small, low-risk changes |
| `review` | review → gate | Independent inspection without implementation |
| `build` | brief → build → code-review → test-design → test-execute → gate | Full implementation with review and verification |
| `verify` | acceptance → audit → e2e-user, with a gate after each stage | Release readiness of existing work |

Repair paths are encoded in each flow and visible with `graphrail viz --flow <name>`.

## CLI walkthrough

```bash
graphrail init --flow build --task "Add signed download links"
graphrail status
graphrail viz

# Produce files for the current node, then seal the exact run.
graphrail seal --verdict PASS --artifact plan:/tmp/brief.md:architect
graphrail advance

# Review nodes require distinct actors and distinct content.
graphrail seal --verdict PASS \
  --artifact evaluation:/tmp/review-a.md:security \
  --artifact evaluation:/tmp/review-b.md:tester

# Execute nodes accept only harness-recorded test results.
graphrail test --command "npm test"
graphrail seal --verdict PASS \
  --artifact test-result:.graphrail/sessions/SESSION/nodes/test-execute/run_N/test-result.json:graphrail
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
    "gate": { "kind": "gate" }
  },
  "transitions": {
    "write": { "PASS": "review" },
    "review": { "PASS": "gate", "FAIL": "write", "ITERATE": "write" },
    "gate": { "PASS": null, "FAIL": "write", "ITERATE": "review" }
  },
  "limits": {
    "maxEdgeVisits": 3,
    "maxNodeVisits": 5,
    "maxSteps": 20
  }
}
```

Supported node kinds are `plan`, `work`, `review`, `execute`, and `gate`. Prompt paths must remain inside the template directory. Unknown nodes, invalid verdicts, unreachable nodes, missing terminal edges, unsafe keys, and path traversal are rejected before session creation.

Templates declare contracts only. They cannot contain commands, JavaScript hooks, or executable callbacks.

## State model

Each target project receives a local `.graphrail/` directory containing session state, exact node runs, handshakes, copied artifacts, and a signed provenance ledger. It should not be committed. `graphrail ls` discovers sessions and `graphrail validate` checks the recorded chain.

The final gate is not a ceremonial node. A PASS transition revalidates upstream exact-run handshakes and artifact hashes. If any authoritative evidence has changed, advancement stops.

Each evaluation artifact must contain `VERDICT: PASS`, `VERDICT: ITERATE`, `VERDICT: FAIL`, or `VERDICT: BLOCKED` (JSON with a `verdict` field is also accepted). Gates aggregate these markers with fail-closed precedence and reject a requested verdict that does not match the evidence.

## Development

```bash
npm test
npm run test:pack
```

GraphRail is available under the MIT License.
