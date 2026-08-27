# Production Validation

GraphRail treats deterministic Harness correctness and real multi-agent behavior as separate release gates. Automated tests prove enforcement logic; fresh Claude Code trials prove that agents can operate the contract and deliver useful artifacts.

## Current result

- Automated tests pass, including CLI integration, all built-in topology golden tests (with explicit review/design gates), provenance failures, budget guards, resume behavior, hash-chain tampering, structured test parsing, mutation-probe sensitivity, and unsafe custom-template rejection.
- `npm pack` installs and starts in an isolated directory.
- The GitHub installation path works in a clean environment and the Claude skill installs locally.
- `quick`, `review`, `build`, and `verify` all complete fresh real fixtures through `finalize`.
- A fresh managed review dispatched two distinct `graphrail-reviewer` agents. Each produced its own evaluation and a signed `SubagentStart -> Write -> SubagentStop` chain bound to the exact session, node, run, path, and content hash.
- An intentional API interruption resumed the same Claude and GraphRail sessions without replaying sealed work.

Model cost and turn counts are retained as diagnostics. They are not release gates and never cause GraphRail to reduce reviewer count, model quality, evidence requirements, or verification depth.

## Automated release gate

Every release must verify:

- all four built-in PASS paths and every declared repair edge, including FAIL/ITERATE routing back to the build node from `gate-review` / `gate-test-design` / `gate-code-review` rather than deferring to the final gate;
- stale runs, changed artifact hashes, fabricated test results, duplicate reviewers, failed reviewers, model-authored reviewer IDs, and signed-state tampering fail closed;
- role isolation: an implementer cannot review its own change, a test designer cannot attest its own execution, and reusing one agent ID under a different actor label is rejected;
- test command, result hash, node/run identity, and provenance ledger agree exactly; test-plan hash binds the execute run to the authoritative test-design artifact; the working-tree hash is identical before and after test execution;
- PASS requires structured `testsExecuted > 0` unless the node declares `allowZeroTests`; exit codes and counts are consistent; required test-plan case IDs must be covered; nodes that require a mutation probe must show a detected probe;
- the provenance and adapter-event ledgers are contiguous hash chains: truncation, insertion, deletion, reordering, and payload tampering all fail `verifyChain()`, and finalize records a signed chain head;
- node, edge, repair, and total-step budgets stop runaway transitions;
- path traversal, prototype-pollution keys, unknown nodes, unreachable nodes, invalid verdicts, and executable template fields are rejected;
- packed installation and repository identity checks pass.

Run:

```bash
npm test
npm run test:pack
```

## Real-flow acceptance matrix

| Flow | Fixture | Observed outcome |
|---|---|---|
| `quick` | Small dependency-free module | Implementation, two independent reviews, gate-review, test design, gate-test-design, signed test execution with parsed structured statistics, and the final gate completed. An interrupted run resumed at the authoritative node without replaying sealed work. |
| `review` | Intentionally flawed authorization helper | Two independent reviewers reproduced the defect, source remained unchanged, and the mechanically aggregated non-PASS result finalized. |
| `build` | Async utility with failure paths | Reviewers detected a vacuous test through a mutation probe; a gate returned to the repair edge, the tests were strengthened, and the second pass finalized. |
| `verify` | Existing tested package | Two deficient release candidates were rejected; the corrected fixture completed acceptance, audit, end-to-end user validation, and all three gates. |

The review-agent routing was also repeated in a new Claude session after installation. Both review workers were reported by Claude's trusted hook stream as `graphrail-reviewer`, rather than inferred from their prose or role labels.

## Trust boundary

The managed adapter accepts lifecycle provenance only from typed Claude hook-response frames. Review gates require two distinct completed subagents, and each exact artifact hash must be observed in a reviewer Write/Edit event between that reviewer's trusted start and stop events. Missing, failed, stale, changed, duplicate, or orchestrator-authored evidence is rejected. Implementer deliverables and test-design artifacts are bound to their agent lifecycle the same way, and cross-role reuse is rejected.

Gate stages are mechanical: they must dispatch no agent and must never edit prior artifacts. A later hash change invalidates the chain and blocks advancement.

GraphRail protects against stale evidence, accidental mutation, model-text forgery, reviewer substitution, and ordinary orchestration mistakes. Ledger signatures are HMAC-chained — the provenance and adapter-event ledgers verify as contiguous hash chains and a finalized session carries a signed chain head. This chain detects accidental tampering and ordinary forgery; it does not claim to protect secrets or state from a malicious process with unrestricted access to the same operating-system account. Use OS-level isolation when that attacker is in scope.

## Production acceptance

The P0 production-candidate criteria are satisfied when the automated gate, clean installation, four-flow matrix, trusted reviewer lifecycle, hash-chain integrity, structured test evidence, and interruption recovery all pass on the release commit. Any change to adapter framing, attestation, sealing, transition logic, ledger chaining, or Skill execution rules requires those checks to be repeated.
