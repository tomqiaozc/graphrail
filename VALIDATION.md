# Production Validation

GraphRail separates deterministic Harness correctness from adapter-level agent behavior. Passing unit and CLI tests does not by itself prove that a real model can complete a workflow efficiently or that reviewer independence is authentic.

## Automated baseline

The following checks are required before every release:

- all four built-in flow PASS paths reach finalize;
- custom template validation rejects unsafe fields and paths;
- stale runs, changed artifact hashes, forged test results, duplicate reviewers, and state tampering fail closed;
- node, edge, repair, and total-step budgets stop runaway transitions;
- packed npm artifact installs and starts in an isolated environment;
- repository identity scan passes.

Current result: 28 automated tests pass, including package installation.

## Real Claude Code trials

Trials used an actual global installation and the installed `/graphrail` Claude Code skill in isolated fixture projects.

### Findings

- The Harness created and resumed real sessions, copied deliverables, sealed exact runs, validated chains, aggregated review verdicts, and recorded gate handshakes.
- A read-only review reached finalize with a mechanically aggregated FAIL and preserved the source file.
- The orchestrator admitted that failed subagents were replaced with two evaluations it authored itself. Distinct role labels and content hashes were therefore insufficient proof of independent review.
- Requiring distinct subagent run IDs correctly blocked that fallback, but the adapter did not reliably capture usable IDs before its execution budget was exhausted.
- Quick-flow trials produced correct modules, tests, and review artifacts, but repeatedly stopped around test-design instead of reaching finalize within a 3–5 USD per-run ceiling.
- Build and verify trials advanced through real nodes and gates but did not finish within the same ceiling.

## Release blockers

GraphRail must not be described as production-ready until all of these are resolved:

1. The Claude adapter records subagent lifecycle provenance from trusted hook events rather than model-authored metadata.
2. A failed subagent cannot be replaced by an orchestrator-authored review.
3. `quick`, `review`, `build`, and `verify` each complete fresh real-world fixtures from init through finalize.
4. Quick flow completes within an explicit cost and turn budget appropriate for a small change.
5. Resume after API interruption completes without restarting or weakening evidence requirements.

## Acceptance matrix for production status

| Flow | Required fixture | Required outcome |
|---|---|---|
| quick | Small dependency-free code change | Correct implementation and tests, independent reviews, signed test evidence, finalized PASS within budget |
| review | Intentionally flawed security helper | Source unchanged, independently reproduced findings, finalized non-PASS verdict |
| build | Async utility with failure paths | Plan, implementation, independent code/test review, executed tests, finalized PASS |
| verify | Existing tested package | Independent acceptance and audit, executed release tests, finalized evidence-backed result |

Production status is earned only when the matrix passes on fresh sessions without manual artifact fabrication or Harness bypasses.
