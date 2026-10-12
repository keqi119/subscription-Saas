# Stage 1 Trust Material Segments Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for the core implementation and one bounded diagnostic subtask; use one independent whole-change review before integration.

**Goal:** Remove repeated TUF root acquisition inside one H1 owner while preserving attestation verification, live checks, useful failure evidence and Stage 1 scope.

**Architecture:** A private AsyncLocalStorage scope owns roots acquired by the fixed official gh command, protected files, and a nonrenewable deadline. Fixed attestation calls borrow those root bytes within that owner only. The actual owner wrapper surrounds OWNER_SPEC, IMPORT and execution with the scope. Failed command metadata reaches the existing Python/PowerShell collector without credentials.

**Tech Stack:** Existing Node.js ESM, native Linux fs protections, installed gh 2.101.0, existing Python/PowerShell operational controls; no new dependency.

**Spec:** [Approved design](D:/Projects/auto-subscription-platform/.worktrees/stage1-integrated-candidate-20260927/.superpowers/sdd/2026-10-05-stage1-h1-snapshot-host/candidate-23e4b82-rc-audit-reentry/DESIGN-review.md), raw sha256:2d879762ca24cd2e32cbfb025feb2bbfb25cd3c8ad7bd613bc998f8665451b6e. Approval raw sha256:6ab0976edb411ac95547eb880df7bc0231644d5b99e3b16f70ccd7aa4ffcfe20.

## Global Constraints

- TTL is min(earliest authenticated TUF metadata expiry, actual startup cutoff, acquisition+1200000ms); enforce wall and monotonic time, no renewal.
- Official GitHub and Public Good roots only; no caller root path/bytes or arbitrary mirror; current GH identity/signature/statement checks remain.
- Root fetch failure does not fall back or automatically retry; wait for subprocess closure and all owned resources.
- Root scope is same owner/process only, never a stored verification pass or cross-RC authority.
- Keep 30/15/95/120/1200/90/600-second command/collection/handoff/startup/connected/database limits distinct.
- Original RC, consumed/UNKNOWN records, existing approvals and scripts are immutable. No new RC/RAM/build merely to test this patch.
- Focused tests only, per explicit user constraint; do not rerun unrelated business/full-chain suites.
- Working tree starts at 23e4b824fddf6ef37fda50b414cdb75885903555. Existing linked worktree reused; no active owner process.
- Preflight: clean tree; Prisma validate PASS; actual staging migrate status exit1, 128 migrations, only 20260925090000_stage1_operational_completion_terminal_shape and 20260925091000_stage1_operational_completion_settlement_guard pending. No business/schema/database changes.

## Review Focus

1. Two official JSONL roots must match the CLI-validated targets and expected issuer classes; default/custom root policy is compared, while refresh-frequency change is explicit.
2. A root file or directory swapped between commands, an expired scope, and changed current operation must reject before another verification.
3. OWNER_SPEC and IMPORT may precede current startup context; actual wrapper must pass the original Execute deadline, not start a new 1200-second timer.
4. A primary attestation failure and cleanup failure must remain distinguishable through real wrappers, including fixed failure collection.
5. Unchanged segment reuse must depend on exact source/input/runtime digests; no old ref/body/timeout may survive descriptor rendering.

### Task 1: Private TUF scope and fixed trust integration

**Files:** Create scripts/release/r3-tuf-material-scope.mjs and scripts/release/r3-tuf-material-scope.test.mjs; modify scripts/release/manual-stage1-trust.mjs; register new production module in release/contracts/repository-contract-files.v1.json.

**Interfaces:**

- Public trusted wrapper: withFixedR3TrustMaterialScope({repoRoot, operationRef, deadlineAtMs}, consume). Validate exact selector and existing profile/host, then own root acquisition for the awaited callback.
- Internal scope: withR3TufMaterialScope(binding, consume), obtains official material itself using fixed command, no injected trust provider.
- Internal command adapter: withR3TufAttestation(args, execute), supplies internal --custom-trusted-root only in active scope, validates held material and active deadlines before/after the awaited child, otherwise preserves existing standalone behavior.
- Storage is a unique root-private native directory under /run; use an isolated GH cache/config for root acquisition. Files bounded, symlinks/mutable identities refused. Keep cleanup ownership exact; no shared cache deletion.

- [x] Write a focused failing test for one root acquisition across distinct attestations and rejection of caller-provided root options.
- [x] Observe RED against absent/current implementation; then implement root lifetime, official two-root/metadata capture and safe cleanup.
- [x] Add identity/tamper/expiry/clock/operation invalidation and failure/no-reuse checks to the same bounded suite. Mocks stop only at the external CLI boundary; use real native file handles.
- [x] Integrate fixed proof/receipt, current admission and historical admission paths; preserve all dynamic API/graph/file checks.
- [x] Verify affected scope and actual trust wiring tests in native Linux; no real RC.

### Task 2: Exact safe attestation diagnostics

**Files:** Create scripts/release/r3-attestation-diagnostic.mjs and scripts/release/r3-attestation-diagnostic.test.mjs; root integrates calls into manual-stage1-trust.mjs. New operational parser/control templates under the current ignored host directory; never edit executed controls.

**Interfaces:**

- withR3AttestationDiagnostic({kind,inputRawDigest,operationRef}, action): kind is proof, receipt, current-admission or historical-admission; digest is exact SHA-256; operationRef is UUID or null for non-operation build input.
- On failure, emit bounded R3_ATTESTATION_FAILURE record containing kind/digest/ref/monotonic elapsed/allowlisted child code and signal, rethrow original error. Never emit argv/path/stdout/stderr/token.
- Node record must be accepted by fixed Python parser, survive PowerShell wrapping, and appear in fixed collected failure manifest.

- [x] Write one failure-injection test against missing implementation, then implement the fixed envelope.
- [x] Exercise genuine Node emission → Python parsing → PowerShell/collector file handling locally without SSH or RC; reject malformed/secret-bearing extra fields.
- [x] Root connects metadata from already verified input bytes, not guessed filenames; historical admission includes its exact context operationRef.
- [x] Add module to contract registry once with Task 1.

### Task 3: Reusable controls and no-cost reentry review

**Files:** New descriptor-driven templates and renderer in current host operational directory; preserve all old ACTIVE/once files. Update docs/acceptance/2026-10-12-stage1-trust-segment-errata.md.

**Interfaces:** One descriptor owns source/build/run/job/ref, original input digests, Execute origin, cutoff and separate budgets. Rendered files carry manifest digests and STOP until actual approved candidate inputs exist.

- [x] Use last verified 23e runtime logic; render new bindings from the descriptor instead of copying candidate text and replacing globally.
- [x] Put withFixedR3TrustMaterialScope outside actual OWNER_SPEC → withFixedR3BuildAttestationScope → IMPORT → runR3\*H1 awaited flow. Pass original Execute-based deadline.
- [x] Include both existing gh-diagnostic.json and new exact failure envelope in the fixed collector.
- [x] Validate one deterministic fixture descriptor and rejection of stale timeout/body/ref/expired binding; do not open a real terminal.
- [x] Link 27-RC gate matrix, completed segment hashes and precise invalidation rules.

### Task 4: Bounded real comparison, review and one integration

- [x] For the installed fixed gh binary, verify one known exact public build proof using default roots and the internally acquired root material; compare accepted identity/digest/issuer and current metadata. No guessed historical selector, no full history sweep, no RC.
- [x] Run changed tests plus relevant existing trust/lifecycle tests, contract verification, formatting and diff checks once; revisit only failures or subsequent changes.
- [x] One independent review covers trust freshness, real wrapper wiring, diagnostics, cleanup and the exact diff. Fix substantive findings with focused regression tests.
- [ ] Commit/push/PR/merge under existing authorization after required CI passes; one consolidated candidate build after the full patch is ready.
- [ ] Only then prepare actual candidate execution/RAM differences that still require precise approval; do not transfer old source signatures to new source.

## Execution rulings

- User approved the design including its six implementation steps and economical agent delegation; proceed with those authorized steps without another general permission loop.
- Existing linked worktree/dependencies are reusable. No blanket reinstall or full baseline suite.
- Linux-only filesystem security tests run from native private source, not Windows DrvFS. Missing environment prerequisites are reported separately from product failures.
- Optional new external assertions are not Stage 1 business gates. Formal R3 and R4 remain unproven.
