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
   - `review`: dispatch at least two fresh, independent roles. Each writes a distinct evaluation artifact.
   - `execute`: run real checks. Use `graphrail test --command <command>` so results receive provenance.
   - `gate`: call `graphrail transition --verdict <verdict>`; do not create a human gate opinion.
3. Seal non-gate work with `graphrail seal`, listing every artifact and actor.
4. Call `graphrail advance`; use only its returned node.
5. Continue until the terminal edge, then call `graphrail finalize`.

Use PASS only when the run's evidence supports it. Use ITERATE for repairable findings, FAIL for material failure, and BLOCKED when external input is required. Never reuse an agent as both builder and reviewer. Forward repository instructions and verification commands to every dispatched agent.

## Roles

Role prompts live in `roles/`. Select the smallest relevant set. `skeptic-owner` is mandatory for every review node. Security-sensitive work includes `security`; user-facing work includes `designer` or `a11y`; verification includes `tester`.

Custom flow prompt references supplement these roles but never override Harness routing or evidence requirements.
