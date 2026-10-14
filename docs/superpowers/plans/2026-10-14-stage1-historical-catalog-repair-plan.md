# Stage 1 Historical Catalog Repair Implementation Plan

> For agentic workers: use test-driven development. The implementing subagent must not commit or push; root integrates after independent review under the existing user authorization.

**Goal:** Authenticate each of seven approved R3 historical source catalogs using its own pinned discovery list while keeping current candidate catalog validation strict.

**Architecture:** The current catalog calculator keeps its public signature and delegates to one private discovery core. A separate historical calculator verifies fixed catalog bytes, strictly extracts the reviewed literal entrypoint list, and uses that core. The trust reader alone selects a seven-field approved historical descriptor and verifies the old checkout before and after calculation.

**Spec:** `RECON/HISTORICAL-CATALOG-REPAIR-DESIGN.md` and `RECON/HISTORICAL-CATALOG-API-ADDENDUM.md`; seven raw Git-object pins are in `HISTORICAL-DISCOVERY-DESIGN-EVIDENCE.json`.

**Scope:** Modify only `packages/release-foundation/src/{catalogs.mjs,manual-r3-incident.mjs}`, their focused tests, `scripts/release/manual-stage1-trust.mjs` and its focused test. No business or snapshot code, remote execution, signing, RC, full suite, subagent commit or push. Set `pnpm_config_verify_deps_before_run=false` if pnpm is used; targeted Node suites can run directly. Root preflight found Git clean and Prisma validate PASS. Two pending staging migrations (`20260925090000_stage1_operational_completion_terminal_shape`, `20260925091000_stage1_operational_completion_settlement_guard`) remain in the R4 business segment; this release-verification change does not apply them. Raw RED/GREEN outputs go under `RECON/history-contract-development`.

### Task 1 — approved descriptor

- [x] Add a failing test in `packages/release-foundation/test/manual-r3-incident.test.mjs` for all seven exact seven-field bindings and fixed `{sourceRoot,sourceSha,catalogRawDigest,discoveryVersion}`; reject altered fields and unknown identity.
- [x] Run that focused test and preserve RED output.
- [x] Replace the 588-only compatibility object with fixed descriptors using the seven reviewed raw catalog pins; preserve null for unknown bindings.
- [x] Re-run the focused test.

### Task 2 — catalog calculator

- [x] Add failing tests in `packages/release-foundation/test/catalogs.test.mjs` for a pinned old literal list, malformed/duplicate/escaped/expressive lists, strict ordinary entrypoints, and missing/changed old files.
- [x] Preserve RED output.
- [x] Add a private parameterized discovery/calculation core and `computeHistoricalRepositoryContract(repoRoot,{catalogBytes,catalogRawDigest})`; verify bytes and parse the sole literal array without evaluating old code. Keep `computeRepositoryContract(repoRoot,{ignore}={})` unchanged.
- [x] Re-run the focused test.

### Task 3 — historical trust path

- [x] Extend the existing older-source fixture in `scripts/release/manual-stage1-trust.test.mjs` for pinned old-list success, held recheck, rejected extra discovery, wrong head/contract/verifier and unknown identity. The c820-shaped timing entrypoint is covered by the catalog unit test, not a separate full-reader fixture.
- [x] Preserve the initial trust failure logs as diagnostics; their non-root/DrvFS failures are not evidence of a code-level RED.
- [x] Make `repositoryContractForSource` read the pinned old catalog only after verified old HEAD/clean, calculate with the historical function, and verify HEAD/clean again. Delete the 588 drift subtraction fallback; ordinary current builds still call strict `computeRepositoryContract`.
- [x] Re-run the focused historical reader cases and the other two focused suites, record GREEN output and file diff. Stop for root's independent review.

**Finite verification already recorded:** `RECON/history-contract-development/incident-GREEN-attempt1.txt` passed 2/2; `catalogs-GREEN-attempt1.txt` passed 2/2. On the isolated native Linux fixture owned and run by root, `trust-history-native-root-none.stdout.txt` passed 1/1 and `trust-history-native-root-seven.stdout.txt` passed all 7 historical binding cases. The incident/catalog code-level RED logs and separate trust environment-failure diagnostics remain preserved in the same directory. No full suite, remote verification, signing or RC was run for this repair.

**Erratum:** Applying the current catalog discovery list to an older approved source was a code compatibility defect; the source-pinned old literal list is required. The initial historical reader failures on `/mnt/d` and under a non-root native process had deterministic test precondition causes: DrvFS exposed executing files as mode 777, and `r3EvidenceSelector` requires UID 0. These were not random environment fluctuations. Future native fixture runs must first verify a private root directory, root ownership and execution, and non-group-writable source files and parent directories.
