# R3 Physical Target Locks

**Goal:** Hold the actual precreated R3 database identities in the existing H1 session before destination admission, while retaining lifecycle's two fixed names for its later real create/drop test.

**Existing specification:** `docs/superpowers/specs/2026-09-28-stage1-r3-target-policy-slice.zh-CN.md`, fixed `manual-stage1-r3-target-policy.v1`.

This is implementation of the already approved fixed target policy. It does not change the profile, signing mechanism, business behavior, database suites or cloud services. NO COMMERCIAL KMS. Creation success remains unproven until the destination, workspace provenance, custody, consumer and cleanup graph is connected.

## Design

- Reuse the current session's owner-only journal `locks` directory and exclusive create/held-descriptor checks. Both fixed forward slots remain held first.
- Derive lock keys from actual Engine ID, PG system identifier, database OID and exact marker. Reject duplicate physical identities, wrong operation markers and names outside the existing suite naming rule. Acquire the resulting keys in deterministic sorted order, without waiting or replacing an existing lock.
- Derive lifecycle's two reservation names with the existing `suiteDatabaseName(operationRef, "database-lifecycle", shard)` rule. These are separate namespace locks, with no invented OID/marker. Later execution must acquire actual identity locks after creating those databases and retain cleanup evidence; this slice does not bypass the test.
- The pure planner creates inert lock descriptions. Only the existing consumed R3 session can acquire them. One initial target-set attempt per session; no retry after a partial acquire. All created lock files stay on failure/ordinary close, alongside UNKNOWN and the forward slots. No automatic unlink or successful cleanup claim.
- The native creation handle feeds its own PG/database observations into this method; no new caller endpoint/path/identity overrides. Recheck the databases after acquiring the locks, archive the observed lock facts, and retain local lock checks in later handle rechecks.
- Holding locks proves exclusion, not destination or snapshot authority. No new public schema, authorization service, SUCCEEDED shortcut or workflow dispatch in this step. The next connected result must bind the exact lock set and active workspace/job evidence.

## Work

- [x] Sol medium: bounded pure target-lock planner and focused identity/reservation tests.
- [x] Root: existing session/store acquisition, recheck and retained-close behavior; fixed H1 wrapper and native connection.
- [x] Focused session negatives for before-consume, collision/partial acquire, tampering and retained locks; extend the existing native creation fixture once.
- [x] Relevant checks and bounded review; document exact evidence and remaining gaps, then persist this round's commit and checkpoint.

## Current Preflight

Clean HEAD `2dfcfc1025fe7ccba5915fa87a4417f38226011a` (`fdd37e`). Migration status exit 1, exact error `The datasource.url property is required in your Prisma config file when using prisma migrate status.` (`179486`), with dotenv and URL disabled and no DB connection. Prisma validate exit 0 (`3bcd6a`). Only release infrastructure changes are planned.

## Evidence and Remaining Work

- The session test first failed because holdTargets did not exist (`d90abc`, 0/1, 1,532.4898 ms). After implementation the focused helper/session group passed 9/9, 0 skip, 6,992.2068 ms (`53ae97`, `r3-target-lock-session-green01.log`). It includes collision, partial prefix retention, same-byte inode replacement, before-consume rejection, once-only behavior and existing R3 consumption/close cases. Windows filesystem is real; OS ACL responses in this fixture are simulated.
- Sol medium's pure-helper RED/GREEN were reported as `a4b36b` (missing module) / `a005ac` (3/3, 124.7525 ms). The root's final 9-test group includes these same helper tests after formatting.
- Sol high completed one bounded read-only review of planner, session/store, fixed H1 wrapper and native connection, finding no blocker in lock identity, origin, partial failure or retained-close behavior. It did not run another test suite.
- Native `r3-target-locks-native01.log` naturally exited 0 (`e01d04`): 1/1, 0 skip, 205,229.78784 ms. Private copy `/root/.cache/r3-target-locks-a3B2mo`, 261 files bound by `20260928-032310-074403845-copy.sha256`. This proves the H1 wiring through real Linux files/TCP and 41 retained lock files (2 forward slots, 37 physical, 2 reservations); Engine/PG/GitHub responses and the SQL helper are synthetic. It is not a real hosted or PG gate. No production changes followed the pass.
- Contracts passed (`ec03a7`): 214 files, 83 schemas, 128 migrations, 13 commands, digest `sha256:2014b06d274c8790e1ebb3e27664c039b67a01421ac03eedfa5e1746a3df9437`. Staged discovery (`9db43b`) passed 99/39/60/0, without another exception. Syntax/staged diff passed; initial formatter invocation rejected the shell's combined array argument (`85338a`), corrected explicit filenames passed (`f4510b`).
- No existing R3 destination schema/API can substitute for the missing result. Next connect active workspace/job provenance, exact precreated identities plus explicit lifecycle reservations, actual lock records, destination/custody and same-session creation success. Preserve the initial UNKNOWN record. Only then connect consumer and actual cleanup; lifecycle dynamic identities must be added during its real execution, not invented at initial creation.
