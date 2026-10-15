# R3 historical catalog correction

RC 38693286913 crossed admission collection and owner-control freezing, then H1
failed in `SIGN_HISTORY` with `R3_HISTORY_CONTEXT_UNAVAILABLE`. The new diagnostic
places the failure before authorization persistence and socket connection.
This is a deterministic code defect, not evidence of GitHub or SSH jitter.

The current compatibility table pinned the 1c historical catalog to `83e468…`.
Both the Git object at `1c8ecfdc52c46fa1c6ead634fe2c6eaa1b664825` and the clean
H1 checkout contain the same bytes, whose SHA-256 is
`0c5ba9cace38336b6ffb80c4d4d9e9de6a6ca71c91129f5a7a6a2205fca60280`.
The other seven historical source/catalog bindings matched their Git objects.
The existing test repeated the erroneous constant without authenticating the
original historical file.

An actual-file regression exposed a second failure after correcting that pin:
the historical parser counted a string containing its own declaration marker
as a second declaration. The parser now requires exactly one matching declaration
at a line or explicit statement boundary. The raw-file digest is still checked first, and the
literal entrypoint list is still parsed without executing historical JavaScript.
Changed bytes, executable list syntax and duplicate actual declarations (including
two on the same line) remain
rejected.

## Evidence and bounded validation

- The committed 1c fixture is byte-identical to the Git object and independently
  checked H1 file. Git attributes preserve those bytes across checkout platforms.
- The regression calls the real compatibility selector and historical contract
  computation with those bytes. It first reproduced the digest mismatch, then
  the duplicate-marker failure, then passed with both corrections.
- The two adjacent test files pass 24 tests, including tampered-byte and duplicate
  declaration rejection. This is a local contract regression, not an H1 signing
  or R3 acceptance result.
- Prisma validation passes. Staging remains at 126 of 128 migrations; the known
  `20260925090000` and `20260925091000` closure migrations remain pending. This
  correction changes no business logic or migration state.
- Independent protected readback found the current request and attempt allocation,
  a normally closed session, no current consumption slot and no current operation
  locks. Historical 1c authorization/request records remain present. The empty
  exchange tmpfs was released; an independent formal check confirms IDLE and
  closed encrypted volumes. Session closure is not successful R3 completion.

## Re-entry rule

Before a new RC, authenticate the actual historical source bytes and exercise
the reader using that file; do not approve a test that only repeats a digest
constant or checks a synthetic catalog. Keep this result reusable while the
catalog reader, pins and original bytes remain unchanged. Verify candidate,
deadline and concrete control artifacts separately, including the prior ISO
cutoff and PowerShell output-contract corrections.

The failed RC and its once records remain retained. Its replacement approval
has been used. A new formal run requires the applicable exact candidate/run
binding; this fix does not authorize replay, fabricate human acknowledgements,
or establish any of the four R3 CLOSED results or R4 acceptance.

## October 16: 233d manifest/catalog digest confusion

The bounded historical-trust read passed eight prior contexts and stopped on
the newly retained 233d context before any new build or RC. Its native history
graph had already passed independently (133 objects, nine groups); that result
does not authenticate the separate H1/H2 build inputs.

The 233d compatibility entry incorrectly used the raw digest of
`release/contracts/repository-contract-files.v1.json` (`1f761f27…`) as
`catalogRawDigest`. That field authenticates the actual historical
`packages/release-foundation/src/catalogs.mjs`, whose raw SHA-256 is
`c34beff7b479440cc4390d679fb9073a854b2543f959ac64b4c5174f68823d3b`.
This is a repeated binding defect, not environment jitter. The existing policy
test repeated the wrong constant and therefore did not detect it.

The correction changes only that production pin. An exact archive of Git
commit `233d237227fbcbf5bb03efb068decca63dc6bca7` reproduces
`CONTRACT_HISTORICAL_CATALOG_CHANGED` with the old pin. With the corrected pin,
the real historical reader finds 339 contract entries and digest
`549d0d0591d8ee813b5a811a849eac1be1ff72681ce0d34ad321c01de408b42d`,
matching both retained build proof and material. All nine historical catalog
pins were independently compared with their own Git blob bytes. The existing
233d policy test now also authenticates an exact historical catalog fixture;
Git attributes preserve its original bytes.

For each new historical entry, derive the pin from the named source file and
commit, record both paths alongside the digest, and run the actual historical
reader before a new RC. A schema check or a test repeating the configured
constant does not satisfy that gate. Preserve the eight passed acquisitions;
the next protected read targets only 233d. Historical trust timing and the
complete five-minute sign-to-consume budget remain unverified at this point.
