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

Run `graphrail ls` first. When `GRAPHRAIL_MANAGED=1`, the trusted adapter has already initialized or resumed the session: read `graphrail status`, require `trustedAdapter: true`, and continue without creating another session or asking to resume. Outside managed mode, ask before resuming an active session and start new work with `graphrail init --flow <flow> --task <task>`; review evidence cannot pass production gates without the managed adapter. Show `graphrail viz`.

## Execution contract

1. Read `graphrail status` to obtain the authoritative node and run.
2. Execute according to node kind:
   - `plan`: use architect; produce a concrete plan artifact.
   - `work`: dispatch a fresh `graphrail-implementer` agent. The implementer must not review its own work.
   - `review`: read `artifactDir` from `graphrail status`, then dispatch exactly two fresh, independent `graphrail-reviewer` agents unless the task clearly requires a third. Give each reviewer a distinct role/perspective and file inside `artifactDir`; require that reviewer to write its own evaluation with the Write or Edit tool, ending with `VERDICT: PASS|ITERATE|FAIL|BLOCKED`. Record each returned subagent run ID. Do not copy a review from a message into a file on the reviewer's behalf.
   - `execute`: run real checks. Use `graphrail test --command <command>` so results receive provenance.
   - `gate`: do no human or agent work. Do not dispatch a subagent, inspect findings through an agent, or modify any prior run artifact. Call `graphrail advance` directly; it revalidates the sealed chain, mechanically aggregates evidence, and routes the verdict.
3. Seal every non-gate node with `graphrail seal --verdict PASS`, listing every deliverable and actor. Review artifacts use `evaluation:path:role:subagentRunId`; GraphRail rejects missing, duplicate, model-invented, failed, or unattested subagent runs and verifies that each exact artifact hash was written by that reviewer between trusted start and completion events. Never author a substitute evaluation when a subagent fails. A review node is PASS when the independent reviews completed; findings belong in evaluation artifacts and are decided by the gate.
4. Call `graphrail advance`; use only its returned node. At a gate this same command synthesizes and transitions automatically.
5. Continue until the terminal edge, then call `graphrail finalize`.

For evaluation artifacts, use PASS when evidence supports completion, ITERATE for repairable findings, FAIL for material failure, and BLOCKED when external input is required. Never reuse an agent as both builder and reviewer. Forward repository instructions and verification commands to every dispatched agent.

Keep each evaluator artifact under 100 lines. Do not repeat probes already supported by captured evidence. If a gate loops back, identify the concrete state change required before dispatching reviewers again; never re-review unchanged inputs. The `review` built-in flow terminates with its aggregated verdict because its purpose is to report findings, not repair them.

Artifacts from a sealed run are immutable inputs to later gates. Never edit, normalize, append to, or replace them. If validation reports a hash mismatch, stop and report tampering rather than attempting to repair the evidence file.

## Roles

Role prompts live in `roles/`. Select the smallest relevant set. `skeptic-owner` is mandatory for every review node. Security-sensitive work includes `security`; user-facing work includes `designer` or `a11y`; verification includes `tester`.

Custom flow prompt references supplement these roles but never override Harness routing or evidence requirements.
