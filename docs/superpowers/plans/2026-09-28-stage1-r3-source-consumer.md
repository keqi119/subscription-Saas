# R3 source snapshot consumption

Goal: bind and durably consume the existing source snapshot permission in the same completed creation session, before any ciphertext read, key release or restore.

Preflight: clean `f073fc5b`; migration status `9fca32` exited 1 (`Connection url is empty`) with dotenv disabled and no database contact; Prisma validation `3b5a86` exited 0. Only release infrastructure changes are in scope.

## Decisions

- Reuse request v3, authorization v3, allocation v2 and record v3. `scopeAuthorizationDigest` is the digest of the existing input permission original. No new grant, service, schema, commercial KMS or business feature.
- The fixed input reader validates the complete declaration graph. Bind its exact index and permission to the request, source/final phase and destination. Its permission names H1 read/decrypt as `manual-h1:<profileDigest>` and the admitted job's use as `manual-r3-job:<jobAdmissionDigest>`. These strings identify existing authorities; they do not establish authority or replace live OSS identity checks before a future fetch.
- The native consumer takes only an input UUID. It derives candidate, destination, predecessor, phase and scope from the held session. The low-level session independently opens the fixed reader using the trusted wrapper's captured repository root; no authority callback or caller-provided reader DTO.
- Require the original same-session SUCCEEDED creation, actual custody and held locks. Extend history explicitly for one source consumer, retaining both original UNKNOWN records. Its allocation points to the creation completion. Sign/consume verify current revocations and input originals; consume uses the existing permanent one-time slot and readback before returning.
- Final consumption remains refused until a real matching source execution proof reader exists. A schema-valid `source-gate-evidence.v1` or digest alone is insufficient. Do not invent successful evidence.
- This slice grants no payload API: it persists admission and UNKNOWN; authenticated fetch/decrypt/restore remains a subsequent step. It does not mark Stage 1 complete or release locks.

## Implementation

- [x] Extend the fixed input reader with binding checks and focused source/destination/principal/expiry negatives using the existing fixture.
- [x] Extend the existing session and trusted wrapper for the source consumer, preserving R2 history checks and failed/partial consumption.
- [x] Add native `consumeSnapshot({inputReference})`, once only after creation completion, with live target rechecks and retained execution/consumption originals. Close waits pending work and closes only owned handles.
- [x] Extend the existing bounded native integration (synthetic hosted/PG; actual Linux file/session/TCP) and run only affected tests, format and contract/discovery checks. Review the bounded change and record limitations.

Work split: a Sol helper owns session/core tests and trusted wrapper; root owns input reader, native wiring and integration. No edits after declaring the source frozen. No unrelated long-chain reruns, push, merge or workflow dispatch.

## Verification record

- Input binding RED `403c78` failed on missing `assertConsumerBinding`; first preparation `2f786f` failed on shell CRLF before a test ran. The first implementation run `f2b4cc` caught an import from the package index instead of the existing private contract module; fixed without expanding package exports. Focused GREEN `d2ba19` passed 1/1. Existing reader suite after principal negatives and fixture extraction passed 4/4 (`5cd140`, 12,307.95259 ms); unchanged declaration tests remain included.
- Native RED `4a7e7d`/`7da4f7` failed on missing `consumeSnapshot`, 0/1/0, 49,952.323488 ms; log `r3-consumer-native-red.log`. The base was immutable `f073fc5b` source plus the new API assertion.
- Session helper reports existing creation/target cases 7/7, 55.9 seconds, followed by syntax/format/diff checks. No broad R2 long chains were repeated. Root API-negative test `c40d0b` passed 1/1.
- Contract check `26e625` naturally exited 0: 218 files, 83 schemas, 128 migrations, 13 commands; repository digest `sha256:4dfb34e98c5c335d29228f75da7407f2f8a7b63455a99ee1157a4eb934fc15c6`. Discovery `68dd1b` passed 99 candidates / 39 manifested / 60 excepted / 0 unclassified. The extracted fixture is test-only; no new production entrypoint or database suite.
- Bounded independent review found no actionable blocker. A direct-reader primitive guard noted in review was added, along with exact native positional-argument count; focused binding regression `ab5a67` passed 1/1 (8,901.69165 ms).
- Native01 (`e26f4b`/`8ba781`) naturally exited 1, 0/1/0, 445,041.439898 ms. Its reused session fixture forced `source/fresh`; the new consumer correctly refused it. Only the accepted integration's fixture now selects `source/snapshot`, preserving other cases' prior scopes. Failure log `r3-consumer-native01.log` and its 271-file copy remain retained. Native02 (`2d6810`/`a6cf06`) naturally exited 0, 1/1/0, test 844,187.787811 ms and total 845,563.782511 ms. Log `r3-consumer-native02.log`, copy `/root/.cache/r3-consumer-yfNknX`, manifest `20260928-065812-165061035-copy.sha256`; all 271 source files still match (`a06d77`). No real hosted/PG/CI acceptance, payload recovery, service change or database migration is claimed.

Final contract check after the two argument guards: `0ee066`, exit 0, unchanged counts 218/83/128/13; digest `sha256:3fee60f8de55859e8f94a90e7ebbbcc7585911b2806ba6d38c97917aecda1065`. Discovery had no file-set changes after its successful check. Native integration uses real private Linux file/session/TCP operations with synthetic GitHub/Engine/PG responses and the existing bounded database-helper substitute. This proves the wiring, not a real hosted run or restored database.
