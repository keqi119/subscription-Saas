# R3 native ciphertext fetch

Continue the approved authenticated recovery path from `3b513b66`. This step connects actual scoped OSS access and ciphertext streaming to the existing consumed H1 session. No business feature, new authorization service or commercial KMS.

Preflight: clean `3b513b66`; `3627f4` migrate status exited 1 because `datasource.url` is missing, dotenv disabled and no DB contacted; `34df8a` Prisma validate exited 0. Release infrastructure only.

## Boundaries

- Native `fetchSnapshot()` has no arguments, requires the held source/snapshot consumer and current original/session/revocation/target checks, and is attempted once. It does not consume again, release locks or write a successful execution record.
- The fixed input reader exposes a frozen storage subject derived from verified custody/envelope originals. Native code supplies that subject and the existing profile/operation to an internal fetch helper; public callers cannot choose endpoints, credentials, paths, adapters or success declarations.
- Reserve `credentialRoot/r3/<operation>/consumer/{ciphertext,plaintext,observations}` before credential pins. The helper writes only its own fixed ciphertext directory; it must not modify pinned global archive/raw or add siblings to held credential directories. Readback originals use the separate observations directory.
- H1 bootstrap credentials live only in fixed private `credentialRoot/snapshot-reader/bootstrap.json`, with a closed `{accessKeyId,accessKeySecret}` format. The dedicated RAM user can only assume `subscription-saas-stage1-snapshot-consumer`; request a 900-second session, verify its actual STS identity and use that identity for OSS reads. This is configuration for the already approved host, not a new operator or approval authority. Cloud existence is unproven until real readback.
- Restrict the role to read the specified Shanghai bucket's `snapshot-slots/v2/` objects and necessary read-only ACL/WORM/versioning metadata. H2 evidence roles remain separate. Missing config or current login fails closed.
- Live bucket/object ACL, owner, WORM, versioning, HEAD/GET metadata, complete length and ciphertext SHA-256 must match. Use HTTPS, no retry or endpoint override, exclusive private files and bounded streaming. Returned replay streams are owned by the helper; secrets and vendor errors must not reach diagnostics.
- Publication proves only the downloaded ciphertext. Current session/input/originals stay held; RSA release, authenticated plaintext, restore, final/source proof and successful execution remain separate required work.

## Work and validation

- [x] Sol helper implements internal native transfer and a small Linux test set with real files/streams and SDK network-boundary mocks. No test-only production adapters.
- [x] Root connects the derived subject, directory preparation and no-argument native method; preserves UNKNOWN/locks and checks after transfer and on later rechecks/close.
- [x] Run only the affected reader/helper/API checks and one existing native integration, then contract/discovery/format checks and bounded review. Retain failures; synthetic network/PG is not live acceptance.
- [ ] Configure/read back the actual least-privilege RAM identity when cloud login works; do not fabricate completion while OAuth renewal or lawful source input is pending.

Cloud observation this round: CLI STS identity output named the correct root account, but subsequent RAM ListRoles/ListUsers failed with `invalid_grant`. Edge connection returned `nodeRepl.fetch request failed`. Fresh OAuth process/session is being monitored and a single renewal question is pending. No cloud mutation has occurred.

## Record

Code implementation and bounded checks are complete; actual cloud configuration is still pending. The native method derives its fixed storage subject from the pinned input, writes a private readback after actual ciphertext verification, and retains the same consumer UNKNOWN and locks. It does not declare successful restore or promotion eligibility.

- Reader RED: `700bbc`, expected missing storage projection; reader GREEN: `734c34`, 6/6, natural exit 0, 12,350.255949 ms. No repeat of the unchanged reader suite.
- Native RED: `4107e7`, natural exit 1, expected missing `fetchSnapshot`; original log `r3-fetch-native-red.log` retained. Integration process `66778` used one frozen 274-file copy at `/root/.cache/r3-fetch-n6PFgX`; its terminal result is recorded below.
- Helper first Linux run: 8/8, natural exit 0, log digest `6290517d26073ace08916788b4ef4e68207fced41a172146f3cfc7b6bb227989`. Independent bounded review then found two introduced defects: returned replay streams outlived close, and ACL/WORM mocks supplied `res.data` which installed ali-oss methods do not expose. Fixes and their narrow regressions are recorded below; the first pass does not establish live SDK interoperability.
- Contract verification initially reported `CONTRACT_FILE_SET_DRIFT` because the new helper had not been added to the discovery catalog. Catalog and manifest are now aligned; `e69d06` passes with 219 files, 83 schemas, 128 migrations, 13 commands. Discovery `9b4c78` passes with 99 candidates, 39 manifested, 60 excepted, 0 unclassified; no new database suite or exception.
- H1 read-only inspection `970835`: both intended encrypted volume mount paths currently resolve to the system ext4 underlay; swap is active and the snapshot-reader bootstrap is absent. No credential was written to an unmounted directory. Restore and verify the approved encrypted storage before provisioning credentials or releasing the RSA key.
- Cloud mutations: none. The same OAuth process `72618` and its one renewal question remain pending; do not resend credentials or repeat an approval request. The existing source-origin question also remains pending.

Review corrections are complete. Lifetime RED was terminal-only `b9014e` (session 76053, exit 1, 0/2); real SDK shape RED was terminal-only `7883f0` (session 93299, exit 1, 0/1). No RED log files were saved for these two runs. The final helper tracks pending replay opens and owned streams through close, reads ACL/WORM bytes from raw `client.request` top-level `data`, and rejects writer sessions using the fixed consumer role. Final Linux helper file: 11/11, 0 fail/cancel/skip, natural exit 0, 29,111.10363 ms; log `payload-test-lifetime-raw.log` digest `c27ee46dbcaf58a43d05ce1e1fc708b1d5db851ad7d8790b83451261353073b2`. Root independently matched the private Linux copy's three file hashes to the worktree (`4ab022`). The follow-up bounded review found no actionable issue; no tests were run by the reviewer.

Final helper/source contract check `f2d86f` passes, repository digest `sha256:00b5503962b50e6efd1c354d78492a6364a0ae696b844e29e8dd5dd0c4b4ec4d`; format/diff `ccec64` passes. Native terminal `d0c326`: host and Node exit 0, 1/1, 0 fail/cancel/skip, test body 855,753.608757 ms, total 882,868.909647 ms. Log `r3-fetch-native01.log` digest `e3e8dfdb1f5098a2658a0d8b24a4af6d812373406852aa7b079b298bec9d81da`.

The native integration used the earlier helper copy. Root hash comparison `f11f8b` confirms 270/274 source paths remain identical, including the wrapper, reader and input fixture. Only the three helper files and the contract discovery catalog changed. Helper corrections are covered by the final focused test file and review, and the catalog by contract verification. No second creation-chain run was needed for these local corrections. This is synthetic integration evidence, not real OSS, STS, hosted CI, PostgreSQL restore or Stage 1 acceptance.
