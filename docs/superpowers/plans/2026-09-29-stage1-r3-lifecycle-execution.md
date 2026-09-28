# R3 lifecycle execution on the held target

This continues the approved Stage 1 closeout. It retains the existing lifecycle suite, its two Node tests, and the current two namespace reservations. No new business feature, network service, authorization protocol, KMS, database suite or exception is required.

## Current baseline

`13e54492` binds the lifecycle migration count to the actual candidate catalog (currently 128), with equality to the existing migration scan digest. `7c050730` sends CREATE/DROP DATABASE outside multi-statement queries and limits final residue checking to the two owned database names. The existing generic provisioning and cleanup API remains unchanged.

Preflight `a6465e`: migration status exits 1 because `datasource.url` is missing, with dotenv disabled and no database contacted. Prisma validate `507e0f` exits 0. These edits affect release infrastructure, not business logic.

Focused RED `02c982` reproduced two connector-boundary failures. GREEN `1e66ec` passes all eight existing/affected target checks. Actual PostgreSQL 17.11 probe `7ece5e` confirms old combined CREATE returns `25001`, the changed helper creates two databases, rejects a forged marker, permits sibling connection after the first drop, and leaves neither owned database. The exact task-labelled container was removed. This probe uses the real postgres 3.4.7 driver with `prepare:false`; it does not claim TLS, migrations, a complete lifecycle suite or H1 acceptance. Original log: ignored `runner-second-stage/lifecycle-connector-probe.log`.

## Remaining implementation

1. Keep one assertion sequence in `database-lifecycle.postgres.test.mjs`. Its existing local entry remains usable. For R3, the admitted H1 holder supplies a private, one-use in-memory adapter with the fixed operation, compose target policy, TLS endpoint and two reserved names. It owns provisioner access; the suite only obtains its migration/runtime credentials. Do not accept caller SQL, endpoints, names, credentials or module paths at the native entry.
2. Extend the held session's existing reservation locks when each database is actually created and its OID/marker read back. Reuse the current wx/fsync/readback journal handling and Engine/system/OID/marker identity. Serialize creation through the held connector. Retain UNKNOWN and locks on lost authority, interruption or unproved cleanup. Namespace reservations are not physical identities; precreation must not substitute for the suite's real create/drop work.
3. Execute the exact manifest file through Node's existing programmatic test runner, in the same admitted H1 process, without test-name filters. Node 22.8+ supports `run({files, isolation: "none"})`; both registered tests must finish and counts must come from actual test events, not a call to only the exported lifecycle function. Restrict this adapter to the one fixed file and one invocation, and retain the original TAP/results plus actual create, role, cleanup, absence and sibling readbacks. This is still only one suite; the source/final manifest gate remains incomplete until every required suite and its custody succeeds.

The runtime capability is documented in [Node's test runner reference](https://nodejs.org/download/release/latest-jod/docs/api/test.html#runoptions). The current H1 holder and legacy source launcher are separate paths; the steps above are not yet wired. In-process execution removes the need for the initially considered child transport or any change to R2's MS2 protocol.

## Prepared assertion adapter

The existing test file now shares one assertion sequence between its original local Docker adapter and a private in-memory R3 adapter slot. Both Node test registrations remain unchanged. The slot provides only the named lifecycle callbacks, rejects a second take while installed (rather than falling back to local Docker), and exposes a revocation closure for the future H1 holder's `finally` path. Local migration URLs now respect the credential's TLS mode; the local adapter still explicitly supplies `disable`.

Syntax/format/diff and the existing package-manager assertion passed. Root's Linux Node 22.22.2 programmatic check `ef7670` ran the exact test file with no name filters: two real Node test results, 2 passed, 0 failed/skipped, 4,453.925358 ms. It also checked the one-use slot and revocation. Its finite database callbacks were synthetic; this is not a real database/lifecycle acceptance result. Log: ignored `runner-second-stage/lifecycle-in-process-probe.log`. Read-only H1 query `dd058d` reports Node v22.23.3, compatible with this mechanism; no H1 state changed.

Native wiring still needs the captured callbacks, original evidence, actual two physical locks and source-manifest result integration. In particular, `r3StoredDestination` currently compares the original lock count with `targetLocks.size`; its later change must explicitly account for the two validated lifecycle identities, without generally permitting extra locks. Bind the exact lifecycle file and adapter module into the existing trusted runtime catalog when connecting the native holder. The adapter slot alone grants no target access and cannot complete a release gate.

## Bounded verification

- Reuse the existing two lifecycle assertions and target/session checks. Preserve actual two-database creation, forged cleanup refusal, runtime restrictions, migration ownership/count, first-drop sibling availability and final owned-name absence.
- Check the new physical lock and once-only adapter boundaries with focused tests, then run the affected lifecycle path once. Do not rerun the unrelated 37-target snapshot chain solely for this slice.
- Keep synthetic adapter/Engine results separate from actual H1/PG/hosted acceptance. Hosted wiring, matching-source final proof and the pending cloud identity/source-origin inputs remain on the existing closeout plan.
