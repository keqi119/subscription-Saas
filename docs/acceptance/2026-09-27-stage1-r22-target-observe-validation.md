# R2.2 target-observe bounded implementation report

Status: DONE_WITH_CONCERNS; final scoped review approved, commit metadata appended below. Base: e7a1b5e15ce9ac5d84ee2c83f2ee7c80e81684b4.

Scope: only scripts/release/launch-manual-stage1.mjs and its existing test. No business/schema/shared R1/R2.1/child/CLI/workflow/manifest changes. This report and raw logs remain in the approved ignored task workspace. No real PostgreSQL, network, SSH, or target-resource operations were performed. Existing synthetic Docker CLI named-pipe fixture remains an offline Engine-edge test.

## Implementation and exact boundaries

- Parent fixed IO preserves the existing genuine H1/build/index/H3-resource gates and held owner/H3/index identities through asynchronous work. A private target context carries genuine fixed H3 RawRefs and physical origin into the existing R2.1 observer; nothing is added to request or authorization shapes.
- Public connectAndObserveManualTarget accepts exactly session/operationRef. Parent session creation uses openTrustedManualSession. Observation allocation and frozen request are create-only, Schema-validated, and independently reopened in the established archive objects layout before genuine session sign/consume.
- Capability release requires a branded parent decision, exact consumed authorization/request, journal consumption slot plus genuine readback, and the existing verifyManualAuthorization kernel using freshly read session/revocation/checkpoint originals. All existing checkpoints are compared to the currently read revocation chain to retain rollback refusal. Rechecks happen both before secret read and after secret/resource awaits before connector creation.
- Only credentialRoot/operations/{fixed operationRef}/observer.json is opened. It is a protected canonical closed two-field username/password file. Username is the approved observer role; password is nonempty and NUL-free. Connector capabilityProfile is derived as verify. No secret values/hashes are archived or logged, no credential file is deleted, JSON parse diagnostics are replaced by a fixed error code, and controlled secret bytes/references are cleared in finally.
- The genuine PostgreSQL connector and genuine observer perform the fixed READ ONLY/REPEATABLE READ transaction, isolation/read-only readback, actual system identifier/database OID/name/internal address/port/role/TLS and complete catalog queries. Statement log includes setter and SHOW statements.
- Actual observation is archived and independently read back; session custody records independently validate it. Genuine post-state and RETURNED result are archived and session.record writes a shared-assessor-validated SUCCEEDED execution plus custody. Baseline factory consumes the reopened observation/request, its actual catalog/role, verified build decision and authorization digest. The canonical verified build object, original baseline object and baseline custody use the existing content-addressed archive layout.
- Connection and session close on all paths. SQL/authorization failures never create a baseline or Runner. Uncertain archival facts remain consumed pending history/UNKNOWN; when malformed/unreadable archive bytes prevent R1 from appending UNKNOWN, R1 retains the durable slot/session lock rather than claiming a successful close.
- Parent success still throws MANUAL_RUNNER_INPUT_REQUIRED. Runner spawn, expected-schema request freeze and credential handoff remain disabled.
- Original baseline reuse is deliberately unfinished in this slice: a prior target-observe request for the fixed run/observe operation triggers MANUAL_BASELINE_REUSE_INPUT_REQUIRED before any replacement allocation/sign/secret/connect. The original manifest is preserved. Root explicitly allowed this boundary after original baseline persistence. Next slice must resolve a unique original through the existing archive graph and exact fixed index bindings; no latest pointer or new index field is introduced.

## Verification evidence so far

Root-owned infrastructure-only preflight: dotenv disabled, DATABASE_URL deliberately absent; migrate status exit 1 with Connection url is empty, prisma:validate exit 0. No server contacted. Logs: observe-preflight-migrate.log / observe-preflight-validate.log.

Focused command: node --test --test-name-pattern='^target-observe genuine' scripts/release/launch-manual-stage1.test.mjs.

- Corrected RED against original base source: 1 test, 0 pass, 1 fail; expected TypeError connectAndObserveManualTarget is not a function. Log target-observe-red-corrected.log. The original implementation was restored byte-for-byte after this base-source check.
- GREEN on final frozen source: 1 test, 1 pass, 0 fail, Node exit 0, test duration 39450.6114ms / total 40556.4005ms. Log target-observe-positive-final.log. This positive executes real trusted session/kernel/archive writes/readbacks and real connector/transaction/observer using only an offline PostgreSQL client edge. It proves shared-assessor SUCCEEDED, baseline bindings/custody, observer-only path, session close and no replacement allocation on the second invocation.
- Earlier setup/iteration logs are retained, not relabeled as successful: target-observe-red.log had fixture bootstrap failures; target-observe-first-green.log had fixture bootstrap failure; target-observe-positive-green.log failed an overstrict one-open assertion (actual 3 legitimate protected read/reopen opens); target-observe-green.log was interrupted once obsolete, after the original positive lacked the referenced canonical build object. Parent/forged/expired/revoked cases passed before interruption. These caused focused fixture/assertion/source fixes, not shared contract changes.
- The R1 module captures promisified native execFile at initialization; test OS ACL double is installed before dynamic R1 imports, preserving execFile's custom promisify object result, then restores the builtin. PostgreSQL registerHooks replaces only the postgres client module; connector and all production trust/observer code execute unchanged. No production injection options exist.
- Default scoped eslint command reported 88 errors: 87 no-undef because the repository's .mjs configuration omits Node globals, plus one no-useless-assignment on the intentional finally credential=null reference release; raw target-observe-eslint.log retained. First CLI comma-list of globals was interpreted as one identifier; raw target-observe-eslint-scoped.log retained. Final scoped lint uses separate global arguments and explicitly disables no-useless-assignment for the intentional secret reference clearing. No eslint configuration or source bytes are changed for this exception.
- node --check both allowed files and git diff --check returned exit 0 before final freeze. Prettier write applied only these two files.

Final affected-file and bounded correction evidence, hashes and review disposition are recorded below. No unchanged multi-file237/343, business/API or real PG suite was run.

## Frozen review candidate

Uncommitted production/test bytes frozen while final gate and root's independent review overlap:

- launcher SHA256 C60C9251021BBB5011E90D2613C70D0EA6A2C83358E72EFB4084074B503E8DD7.
- test SHA256 C1E2425A211B38F4E1BAB8EDACA0C5727327CB8049F60055059F3ADF4C651A86.
- pnpm exec prettier --check scripts/release/launch-manual-stage1.mjs scripts/release/launch-manual-stage1.test.mjs: exit0, all matched files use Prettier style; target-observe-prettier.log.
- node --check scripts/release/launch-manual-stage1.mjs; node --check scripts/release/launch-manual-stage1.test.mjs; git diff --check: each exit0 at frozen source.
- Single full-file gate: node --test scripts/release/launch-manual-stage1.test.mjs; raw target-observe-launcher-final.log; shell propagates Node exit via $observeTestExit. Final outcome and the separately approved test-only correction appear below.
- Final scoped lint: pnpm exec eslint --global process --global Buffer --global TextDecoder --global URL --global structuredClone --global queueMicrotask --rule 'no-useless-assignment: off' scripts/release/launch-manual-stage1.mjs scripts/release/launch-manual-stage1.test.mjs; exit0, no diagnostics; raw target-observe-eslint-final.log; shell propagates lint exit.

## Independent review

Root-supplied independent reviewer /root/r22_target_observe_review initially returned spec PASS, quality PASS conditional on the affected-file gate. Frozen source/test hashes matched. No Critical/Important/Minor finding required work. The scoped-consumption concern was examined against genuine R1 consume plus the kernel; reviewer found no reachable borrowed-consumption bypass and requested no additional hardening. After the full gate, the same reviewer checked the two assertion-only corrections and their targeted GREEN, confirmed absent-key rejection occurs before fs.open and zero is correct, and approved the final increment with no new issue. Production bytes never changed after the initial review; only the two documented test expectations changed. Root explicitly authorized the scoped two-file commit and no additional suite.

## Single full-file gate and bounded test-only correction

The one required whole-file command completed: node --test scripts/release/launch-manual-stage1.test.mjs. Node exit1; 157 tests /155 pass /2 fail /0 cancelled /0 skipped /0 todo; duration1003427.8705ms. All21 new target-observe cases passed. Raw original output target-observe-launcher-final.log is retained unchanged and is explicitly not an all-green result.

The only failures were existing H3 positives whose new bootstrap-boundary assertions incorrectly expected privateKeyReads1 and2:

- H3 Docker source observations bind resources before trusted session bootstrap: actual0, expected1.
- H3 Docker real CLI formats nonsecret projections against an isolated synthetic Engine pipe: actual0, expected2.

R1 rejects the absent key path before fs.open, so no private key bytes are read. An already-started one-name diagnosis confirmed the first assertion: 1 test/0 pass/1 fail/exit1/duration20044.2107ms; target-observe-h3-counter-red.log. Only those two expected counts were then changed to0. Production hash remains C60C9251021BBB5011E90D2613C70D0EA6A2C83358E72EFB4084074B503E8DD7; no production behavior changed. Small reviewed-to-corrected test diff is target-observe-test-counter-correction.diff.

Root explicitly approved finishing with corrected two-name evidence rather than repeating the expensive unchanged whole file. Completed command: node --test --test-name-pattern='^H3 Docker (source observations bind|real CLI formats)' scripts/release/launch-manual-stage1.test.mjs; target-observe-h3-counter-green.log. Final test-only reviewer check passed and root approved this increment. The original157-test failures remain separately reported.

Corrected two-name GREEN: Node exit0; 4 tests/4 pass/0 fail/0 cancelled/0 skipped/0 todo; duration33617.548ms. This includes both parent tests plus the existing2 synthetic Docker subcases. No second full-file run was made. Final test SHA256 AEC3A6BFF72F74251FB037A805963CBC1C499C8480E48E6BFA940B3AA00276F3; production bytes remain the reviewed C60C...E8DD7. No new production change or additional suite was introduced after the full gate.

## Final raw evidence hashes

| Raw file                                    | SHA256                                                           |
| ------------------------------------------- | ---------------------------------------------------------------- |
| target-observe-red-corrected.log            | 29e1a023208ff3edad353b192b293f09fc5bc6ede732ec0eeb1ce036187b0489 |
| target-observe-positive-final.log           | 346f35f892569d44073720dde15a3ae91454f355f2642e1d3bc86fc871edaa09 |
| target-observe-launcher-final.log           | 8622adebc1803642159dd6e11ca4ab2812de410ade5dc9d4c6f5a07136a04654 |
| target-observe-h3-counter-red.log           | ac4a9d1f87961aac4b66fbf9e4157de1c7291ceb50cbc586f21d8eee46f017a5 |
| target-observe-h3-counter-green.log         | 43281942ad2a19423a585c723037b077a0f69fcdbc5e9de16f52c4886fe9233c |
| target-observe-test-counter-correction.diff | d5a9cd00d8b90e2c7aa5de72815f95e9469da29214048bf5f27293953fa7973f |
| target-observe-eslint.log                   | cc08ede6c2f680d4a1c6707726cfc2647b921aa40d39dd9720c157e24aa6f282 |
| target-observe-eslint-scoped.log            | cc08ede6c2f680d4a1c6707726cfc2647b921aa40d39dd9720c157e24aa6f282 |
| target-observe-eslint-final.log             | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 |
| target-observe-prettier.log                 | f20510a9da4717c51c4cffee6d0dd88d6c9a723d0a83711d01216f5b48961283 |
| target-observe-syntax-diff.log              | 00436f10a75b8b24975c96a00d9e7d3a6760cb992f5f44703ef0dc3c74cd34a5 |
| observe-preflight-migrate.log               | 83c48eea00257e71ceb455e19956038cc64639e7bd9957a87dd40055285cda03 |
| observe-preflight-validate.log              | 509279e865417367a75e5e7df3f20345473a46142150d53ce77ee25e82b35777 |

## Commit and final state

Commit: 900b978bc55d8a4c2e7d399d1ce47764251ad970 — feat(release): archive authorized manual Stage1 target observation.

Only the two approved source/test files are committed; the report and raw evidence remain in the ignored task workspace. Final git status --short is empty. Final reviewed production SHA256 remains C60C9251021BBB5011E90D2613C70D0EA6A2C83358E72EFB4084074B503E8DD7; corrected reviewed test SHA256 remains AEC3A6BFF72F74251FB037A805963CBC1C499C8480E48E6BFA940B3AA00276F3.

Delivered increment: genuine authorized target observation with protected archive/readback, shared execution record and original baseline persistence. Known continuation boundaries: original baseline graph reuse is explicit STOP, and Runner/expected-schema dispatch remains explicit STOP. This report does not claim all Stage1 or whole R2.2 completion. Verification remains transparently single whole-file155/157 with two historical assertion failures, followed by corrected two-name4/4 GREEN and final reviewer approval; all21 new observation cases passed. No additional full-file or broader suite was run.
