# R3 payload originals

Continue the approved authenticated recovery path from `a30bf3e9`. Use the existing fixed H1 input reader and local RSA/AES-GCM implementation. No new authorization service, schema, business feature or commercial KMS.

Preflight: clean `a30bf3e9`; migrate status `3ae19a` exited 1 because `datasource.url` is missing (dotenv disabled, no database contacted); Prisma validation `1bfd5f` exited 0. This slice changes release infrastructure only.

## Scope and decisions

The envelope already references its historical producer authorization by canonical digest. The reader currently validates the envelope without opening that original. Read it from the existing fixed `archiveRoot/raw/<digest>.bin` namespace, using the same private pins, 1 MiB limit and total reference bound. Require the local-key v2 contract and verify the authorization/envelope relationship. Do not add a selector, authority callback or new input-index version.

Expose only frozen `cryptoInputs: { authorization, envelope, aad }` from the held reader. Derive AAD from the verified original, rather than accepting caller overrides. These are historical declarations for the existing decryptor, not a current consume decision, live storage observation or private-key release. Preserve the separate permission/session/slot checks and retained originals. A producer's short execution window may have ended: current consumer validity remains governed by the existing input/profile/permission deadlines.

The previous 1 GiB OSS roundtrip is an encrypted RSA recovery volume, not a database snapshot. There is no established lawful R3 payload or independent snapshot-reader runtime identity in the inspected artifacts. Actual OSS fetch, native private-key release and database restore remain subsequent work; the pending source-origin question is not repeated.

## Tasks

- [x] Extend the existing synthetic fixture with a valid historical v2 producer original. Add a failing regression for missing original and a test consuming the reader's parameters through real RSA/AES-GCM encryption/decryption of synthetic bytes.
- [x] Implement fixed digest dereference, full envelope/producer binding and frozen crypto inputs. Preserve byte/directory rechecks and raw-reference accounting.
- [x] Run the affected reader tests in a private Linux copy, syntax/format and repository contract/discovery checks. Review this bounded change; retain real failures and limits. No repeat of the unrelated 14-minute creation integration or old R2 chains.

Review focus: digest/canonical-byte binding, local-only v2 enforcement, producer timing versus consumer deadline, mutable projections, retained-file replacement, no ciphertext/private-key access at declaration admission, and compatibility with existing native consumption's raw-reference projection.

## Verification

- RED `369df2`: both targeted regressions failed as expected, 0/2, 4,471.485255 ms. Missing producer original was accepted and derived crypto inputs were absent. Unexpected acceptance left handles to GC in that failed test; its cleanup now explicitly closes an unexpected successful result. Original output is retained in `r3-payload-originals-red.log`.
- First GREEN attempt `786c20` was 1/2, 7,916.658492 ms: the missing/oversized/mismatched-original regression passed; the roundtrip test incorrectly passed a filename where the existing decryptor requires an owned replay stream. Corrected the test call to open the actual ciphertext file on each pass; no crypto API change. Failure retained in `r3-payload-originals-green.log`.
- Final affected file `380c14`: 6/6, 0 skip, natural exit 0, 17,616.08673 ms, `r3-payload-originals-full.log`. The run used actual private Linux files and real RSA-3072/AES-256-GCM over synthetic bytes. It proves original binding and decryptor interoperability; it is not a native consumer key release, OSS read, database restore or CI acceptance.
- Private copy `/root/.cache/r3-payload-originals-llwNdz` derives from the prior verified 271-file copy `/root/.cache/r3-consumer-yfNknX`, replacing only the three changed reader/test/fixture files. Their SHA-256 values are recorded in the log. No prior verified copy was modified.
- Contract check `2463cc` exited 0: 218 files, 83 schemas, 128 migrations, 13 commands; repository digest `sha256:f92221a9f93d67d64e4555ab1815725f91373137fc336f73751842072b170b6c`. Discovery `5964cd` exited 0: 99 candidates / 39 manifested / 60 excepted / 0 unclassified. Syntax and diff check `babedc` exited 0.
- Bounded independent Sol review found no actionable findings: digest/canonical-byte and size/reference bounds, historic timing, frozen projections, retained pins and session raw-reference filtering were checked. Luna performed the separate read-only custody/input inventory. No business code, server/cloud/database mutation, service change, push, merge or workflow dispatch.
