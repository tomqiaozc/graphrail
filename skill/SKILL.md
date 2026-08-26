---
name: graphrail
description: Run implementation, review, and verification work through a deterministic evidence-backed graph. Use for /graphrail tasks, independent multi-role review, custom GraphRail flow files, and resumable gated workflows.
---

# GraphRail

Use GraphRail as the authority for workflow state and routing. Never infer the next node from this document or manually bypass a gate.

## Invocation

`/graphrail <task>` selects a built-in flow. `/graphrail --flow path/to/flow.json <task>` uses a custom template.

- small low-risk change: `quick`
- inspect without changing: `review`
- implement or fix: `build`
- validate existing work for release: `verify`

Run `graphrail ls` first. Ask before resuming an active session. Start new work with `graphrail init --flow <flow> --task <task>` and show `graphrail viz`.

## Execution contract

1. Read `graphrail status` to obtain the authoritative node and run.
2. Execute according to node kind:
   - `plan`: use architect; produce a concrete plan artifact.
   - `work`: use a fresh implementer. The implementer must not review its own work.
   - `review`: dispatch exactly two fresh, independent subagents unless the task clearly requires a third. Record each returned subagent run ID. Each subagent writes one concise evaluation artifact, ending with `VERDICT: PASS|ITERATE|FAIL|BLOCKED`.
   - `execute`: run real checks. Use `graphrail test --command <command>` so results receive provenance.
   - `gate`: do no human work. Call `graphrail advance`; it mechanically aggregates evidence and routes the verdict.
3. Seal every non-gate node with `graphrail seal --verdict PASS`, listing every deliverable and actor. Review artifacts use `evaluation:path:role:subagentRunId`; GraphRail rejects missing or duplicate subagent run IDs. Never author a substitute evaluation when a subagent fails. A review node is PASS when the independent reviews completed; findings belong in evaluation artifacts and are decided by the gate.
4. Call `graphrail advance`; use only its returned node. At a gate this same command synthesizes and transitions automatically.
5. Continue until the terminal edge, then call `graphrail finalize`.

For evaluation artifacts, use PASS when evidence supports completion, ITERATE for repairable findings, FAIL for material failure, and BLOCKED when external input is required. Never reuse an agent as both builder and reviewer. Forward repository instructions and verification commands to every dispatched agent.

Keep each evaluator artifact under 100 lines. Do not repeat probes already supported by captured evidence. If a gate loops back, identify the concrete state change required before dispatching reviewers again; never re-review unchanged inputs. The `review` built-in flow terminates with its aggregated verdict because its purpose is to report findings, not repair them.

## Roles

Role prompts live in `roles/`. Select the smallest relevant set. `skeptic-owner` is mandatory for every review node. Security-sensitive work includes `security`; user-facing work includes `designer` or `a11y`; verification includes `tester`.

Custom flow prompt references supplement these roles but never override Harness routing or evidence requirements.
