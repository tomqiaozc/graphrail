# Production Validation

GraphRail treats deterministic Harness correctness and real multi-agent behavior as separate release gates. Automated tests prove enforcement logic; fresh Claude Code trials prove that agents can operate the contract and deliver useful artifacts.

## Current result

- 34 automated tests pass, including CLI integration, all built-in topology golden tests, provenance failures, budget guards, resume behavior, and unsafe custom-template rejection.
- `npm pack` installs and starts in an isolated directory.
- The GitHub installation path works in a clean environment and the Claude skill installs locally.
- `quick`, `review`, `build`, and `verify` all completed fresh real fixtures through `finalize`.
- A fresh managed review dispatched two distinct `graphrail-reviewer` agents. Each produced its own evaluation and a signed `SubagentStart -> Write -> SubagentStop` chain bound to the exact session, node, run, path, and content hash.
- An intentional API interruption resumed the same Claude and GraphRail sessions without replaying sealed work.

Model cost and turn counts are retained as diagnostics. They are not release gates and never cause GraphRail to reduce reviewer count, model quality, evidence requirements, or verification depth.

## Automated release gate

Every release must verify:

- all four built-in PASS paths and every declared repair edge;
- stale runs, changed artifact hashes, fabricated test results, duplicate reviewers, failed reviewers, model-authored reviewer IDs, and signed-state tampering fail closed;
- test command, result hash, node/run identity, and provenance ledger agree exactly;
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
| `quick` | Small dependency-free module | Implementation, two independent reviews, test design, signed test execution, and final gate completed. An interrupted run resumed at the authoritative node without replaying sealed work. |
| `review` | Intentionally flawed authorization helper | Two independent reviewers reproduced the defect, source remained unchanged, and the mechanically aggregated non-PASS result finalized. |
| `build` | Async utility with failure paths | Reviewers detected a vacuous test through a mutation probe; the gate returned to the repair edge, the tests were strengthened, and the second pass finalized. |
| `verify` | Existing tested package | Two deficient release candidates were rejected; the corrected fixture completed acceptance, audit, end-to-end user validation, and all three gates. |

The review-agent routing was also repeated in a new Claude session after installation. Both review workers were reported by Claude's trusted hook stream as `graphrail-reviewer`, rather than inferred from their prose or role labels.

## Trust boundary

The managed adapter accepts lifecycle provenance only from typed Claude hook-response frames. Review gates require two distinct completed subagents, and each exact artifact hash must be observed in a reviewer Write/Edit event between that reviewer's trusted start and stop events. Missing, failed, stale, changed, duplicate, or orchestrator-authored evidence is rejected.

Gate stages are mechanical: they must dispatch no agent and must never edit prior artifacts. A later hash change invalidates the chain and blocks advancement.

GraphRail protects against stale evidence, accidental mutation, model-text forgery, reviewer substitution, and ordinary orchestration mistakes. It does not claim to protect secrets or state from a malicious process with unrestricted access to the same operating-system account. Use OS-level isolation when that attacker is in scope.

## Production acceptance

The P0 production-candidate criteria are satisfied when the automated gate, clean installation, four-flow matrix, trusted reviewer lifecycle, and interruption recovery all pass on the release commit. Any change to adapter framing, attestation, sealing, transition logic, or Skill execution rules requires those checks to be repeated.
