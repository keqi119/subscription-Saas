# Stage1 historical-input session reuse

> **For agentic workers:** Use `superpowers:executing-plans` for this bounded repair. Do not replay the failed 5d operation or broaden Stage1.

**Goal:** Avoid repeating authentication of identical historical originals inside the R3 connected window while retaining all current authority checks.

**Architecture:** The H1 session retains authenticated historical-input handles for its exact historical context set. Each history invocation still rebuilds and validates the graph, revocations, locks and originals, then rechecks held files/source identity and current GitHub build/run/job facts. No persistent cache, caller-supplied trust, timeout change or additional production authority is introduced.

**Evidence:** The 5d sourceFresh run `37883859641` failed in `H1_CONSUME / HISTORY` with `R3_CONNECTED_WINDOW_EXHAUSTED`; the actual authorization was unconsumed. Its session is CLOSED and independent formal H1 IDLE passed. Individual external-call latency remains unknown.

## Constraints and review boundaries

- Retain only verified handles in one session; exact context selectors include profile, operation, scope, execution and optional cleanup times.
- Revalidate the full graph and dynamic build/run/job facts on every use. Changed context sets or invalid originals fail before consumption.
- Close retained handles on history failure and session termination; failed handles cannot silently regain trust.
- Keep serialized public build results and all 90/600-second budgets unchanged.
- Preserve failed-attempt evidence, old signatures and RAM scopes. Do not release held snapshot jobs; retire an obsolete waiting run with independent readback. A new candidate needs a new exact binding before execution.

## Implementation

- [x] Extend the private trust-layer historical recheck with the authenticated build-run identity. Add a focused test that mutable build failure rejects a held context without redoing immutable attestation verification.
- [x] Retain exact historical handles inside `manual-stage1-session.mjs`; reject a changed context set, recheck each use and close on failure/termination. Extend the historical incident fixture to cover reuse, mutable rejection before consumption, and cleanup.
- [x] Run the affected trust/session tests and formatting checks, perform one independent code review, and update the execution errata. No remote R3 retry is part of this repair verification.
- [ ] Integrate through the already authorized GitHub workflow; prepare the resulting concrete candidate binding before requesting any new execution authority.
