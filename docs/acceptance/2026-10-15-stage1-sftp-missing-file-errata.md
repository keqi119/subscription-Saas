# R3 SFTP missing-file polling correction

The hosted evidence receiver rejected the normal absence of an H1 output file.
OpenSSH reports `File "/out/cleanup-request.json" not found.`; the previous
`No such file|File not found` expression did not match the intervening filename.
Thus `receiveCleanupRequest()` could fail immediately after successfully sending
creation evidence, before H1 finished its work and produced the cleanup request.

This is a reproducible **code defect**, not evidence of environment jitter or
missing human confirmation. RC 38554217161 reached this hosted stage and reported
`R3_HOSTED_EVIDENCE_DELIVERY_UNAVAILABLE`, while H1 reported
`ACK_BODY / H1_INPUT_UNAVAILABLE`. The historical logs do not establish which
side failed first, so this correction does not establish that incident's unique
root cause or change its consumed / `INTERRUPTED_UNKNOWN` records.

## Evidence and correction

- A read-only native OpenSSH probe, using `sftp -b - -D` with the installed SFTP
  server and a fresh nonexistent file under `/tmp`, returned exit 0 and
  `File "<requested path>" not found.`. The old expression returned false.
  The direct-server probe used no SSH credential and performed no remote write.
- The existing public adapter fixture now supplies that actual diagnostic,
  leaves the local download absent, and produces the file on the next existing
  poll. Before the fix it failed at the missing-file predicate; after the fix
  it proceeds through cleanup and the explicit CLOSED receipt.
- The receiver accepts only the exact missing-file line for its current fixed
  `/out/<name>` path, with LF or CRLF. Permission errors, another path, and mixed
  error output still fail immediately. Existing deadlines, polling interval,
  identity checks, one-time actions and content validation are unchanged.
- All three focused tests passed under Linux Node 22 with
  `node --experimental-test-module-mocks --test scripts/release/r3-hosted-evidence-delivery.test.mjs`.
  Prisma validation passed. Staging remains at 126 of the current source's 128
  migrations; the two known `20260925` closure migrations remain pending until
  the required R3 result. No RC or migration was run for this correction.

## Re-entry check

Classify this as a deterministic transport-parser defect. Future preparation
must cover an output file that is initially absent, not only an immediately
available mocked file. Reuse this local result while the adapter, OpenSSH
diagnostic format and waiting contract remain unchanged.

The fix is wired into the shared receiver used by source/final fresh/snapshot
hosted entry points. A new formal RC still requires a current candidate/build
binding, valid authorization, independent input readback, and the existing C3
state/budget checks. The old consumed authorization cannot be replayed, and
this local result is not a substitute for R3 CLOSED or R4 acceptance.
