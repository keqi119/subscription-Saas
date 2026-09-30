# R3 evidence delivery implementation plan

> **For agentic workers:** Use superpowers:executing-plans for root integration and bounded subagent implementation where explicitly assigned. Steps use checkbox syntax. The user approved the written design and implementation, including the necessary account/SSH configuration; do not request the same approval again.

**Goal:** Implement a connected source/fresh H1/hosted caller with actual evidence transport, explicit owner acknowledgement and verified cleanup/close, ready for later authorized CI execution.

**Architecture:** Keep the existing H1 and hosted holders alive. A separate file-only SSH identity carries the existing signed bundles and root-origin notifications through a limited tmpfs chroot; the existing forward identity and shutdown proof remain unchanged. Input writers establish the original fixed spec/job admission before either private holder starts.

**Tech stack:** Existing Node 22+ ESM, OpenSSH/internal-sftp, Linux private files/tmpfs, existing GitHub attestation and native H1 validators. No new service, cloud identity, package or business feature.

**Spec:** [Approved evidence delivery design](../specs/2026-09-30-stage1-r3-evidence-delivery-design.md).

**Execution record (2026-10-01):** Fixed inputs, adapters and source/fresh callers are implemented. The isolated H1 SSH probe passed; the approved account/Match was applied and independently read back. One bounded integrated review completed with its concrete findings corrected. Focused tests passed 12/12, followed by the affected adapter checks 4/4 after the last corrections. No long core composition was repeated. [The delivery status](../../acceptance/2026-10-01-stage1-r3-delivery-status.md) records the evidence and retained failures. Protected workflow wiring and public RC mapping remain next work within the completion boundary below; no real CI or Stage 1 acceptance is claimed. The checklist below preserves the original planning scope; the status record distinguishes completed checks from deferred real execution.

## Global constraints

- H1 is `139.196.227.195`, owner `keqi119`; retain the approved profile and key bindings.
- New account `stage1-r3-evidence`: distinct UID from 0 and 994, own group only, no sudo/password/shell/forwarding. Use the exact approved Match configuration and the existing job's temporary public key.
- Exchange root `/run/stage1-r3-evidence`: 8 MiB/128 inode tmpfs, nodev/nosuid/noexec, root-owned chroot and outbox; inbox owned by the new account. No secret or DB payload crosses it.
- Existing forward account, ports 55440/55441, key revocation, UID 994 absence and physical lock rules do not change.
- Retain fixed file names, at-most-1-MiB bundles, atomic upload and stable-file reads. Never promote an arriving file into authority.
- A fixed `in/closed-received.json` receipt binds the exact CLOSED bytes and existing scope before temporary exchange removal. This closes the disconnect-before-fetch race inside the already approved inbox permissions; it is never an owner ACK or native grant.
- Owner ACK remains separate and exact-terminal-bound. A CLI must not auto-approve, provide a success flag or accept a replacement executor/reader.
- No push/merge/workflow dispatch. No commercial KMS. No repetition of the passed final long composition.
- Local preflight `6442a5`: clean `da9334f1`, migrate status fails before contact because datasource.url is absent; Prisma `d305e4` passes. Release infrastructure only.

## Review focus

1. A stale SFTP process/key/directory must prevent a new operation from seeing old files; Task 1 tests reuse rejection.
2. Partial upload, link replacement and oversized content must fail before a one-shot native import; Task 1 tests stable bounded intake.
3. Hosted must close the forward connection before H1 cleanup, while independent SFTP remains available for CLOSED; Task 3 tests this sequence.
4. Success, timeout, EOF or an unrelated terminal digest cannot manufacture owner ACK; Task 3 tests no-ACK and wrong-digest paths.
5. Input writers must use actual job/machine/key and canonical H2-bound spec, with no runtime cloud/IO/command overrides; Task 2 tests mismatched environment and duplicate writes.

## Files and ownership

`scripts/release/r3-evidence-delivery.mjs` owns the closed transport messages and fixed names only. `r3-h1-evidence-delivery.mjs` owns the H1 private lease, bounded intake and root-only outbox; `r3-hosted-evidence-delivery.mjs` owns the actual fixed SFTP child and uploads/downloads. Their respective focused test files cover transport boundaries without replaying the core history fixture.

`scripts/release/r3-operation-inputs.mjs` owns H1 creation-spec production and hosted current-job/key production; `r3-operation-inputs.test.mjs` covers their fixed boundaries. It must reuse the existing target-policy/H2 readers and job descriptor meanings, not create a second admission authority.

`scripts/release/run-r3-source-fresh.mjs` owns the two controlled CLI modes and their connected sequencing; `run-r3-source-fresh.test.mjs` covers sequencing with holder doubles and actual transport in the bounded probe. A maintenance script under `scripts/release/maintenance/` owns only the reviewed new-account configuration. Root updates the repository-contract manifest and status documents after integrating all runtime files.

## Task 1: Fixed evidence exchange

**Consumes:** Existing `readFixedR3JobAdmission({repoRoot,operationRef})`, the approved spec and existing signed bundle codecs. Actual H1 account/config/host identity is checked before public-key installation.

**Produces:**

- `openR3H1EvidenceDelivery({repoRoot,operationRef})`: a retained lease with `receiveCreation()`, `publishCleanupRequest({executionBytes,acknowledgementBytes})`, `receiveCleanup()`, `publishCleanupImported({bundleDigest})`, `publishClosed({sessionBytes})`, `recheck()` and `close()`. Return received bytes as untrusted copies. Publications validate canonical records and exact current scope; they are called only by the fixed owning CLI after the corresponding native action.
- `openR3HostedEvidenceDelivery({creationSpecBytes,jobAdmissionBytes})`: fixed SFTP child using the operation-derived temporary key and checked H1 host key; methods `sendCreation(bundleBytes)`, `receiveCleanupRequest()`, `sendCleanup(bundleBytes)`, `receiveCleanupImported({bundleDigest})`, `receiveClosed()`, `close()`. No arbitrary host/path/command/identity/IO arguments.
- Notification fields are the common operation/session/job/spec/phase/chain binding plus their exact existing records/digests. They are internal transport records, not manual grants or public RC evidence. The two existing signed bundle formats are unchanged.

- [ ] Add focused failing checks: exact interface, foreign operation/job/phase, partial or oversized upload, link replacement, stale exchange, ACK subject mismatch and write-to-outbox refusal. Test the transport contract without new full history fixtures.
- [ ] Implement fixed codec and both adapters. Retain actual child exit, bound stdout/stderr, use only fixed SFTP operations, propagate failure and stop new actions while closing. Reuse held filesystem checks where their ownership model fits; the untrusted inbox must not be treated as H1 private storage.
- [ ] Write the explicit account/config maintenance script with check-only and apply modes. Assert root, original-account effective configuration, vacant account/name or exactly matching prior state, empty key, mount identity/capacity and limited groups. Preserve the previous SSH configuration before a reviewed atomic change; syntax-check before reload. Existing root management access must survive.
- [ ] Run only the new focused test files; require natural exit 0 and no unintended skips. Format, scoped Node lint and diff-check the changed files. Commit the tested adapter increment, explicitly keeping full caller status incomplete.

## Task 2: Real fixed inputs and temporary job key

**Consumes:** `readFixedR3TargetPolicy({repoRoot,proofBytes,materialBytes})`, current profile, existing H2 raw files and fixed GitHub current-job rules. Reuse one source/fresh operationRef throughout.

**Produces:**

- `prepareR3SourceFreshSpec({repoRoot,operationRef,proofRawDigest,materialRawDigest,capacityBytes,expiresAt})` writes the canonical fixed creation spec create-only under the existing archive path; derives profile/owner/source/build/policy/workspace fields from real validated inputs. It reopens the result with `readFixedR3CreationSpec` before returning nonsecret bytes.
- `prepareR3SourceFreshHostedJob({repoRoot,creationSpecBytes})` derives actual workflow/run/job/runner/machine identity, creates one temporary Ed25519 key beneath the existing verified tmpfs key root, and writes canonical job admission. Key material remains private; the same public key is used for both SSH identities and the existing evidence signatures.
- `readR3HostedOperationKey({operationRef})` loads only that fixed private key, verifies its public fingerprint against the canonical fixed job declaration, and exposes the KeyObject solely to the owning hosted process. SSH private-key serialization must be checked once with actual `ssh-keygen -y`; no dependency or replacement key is introduced.
- `importR3SourceFreshJob({repoRoot,operationRef,runId})` downloads only `stage1-r3-job-<operationRef>-<runId>-1` from `keqi119/subscription-Saas` using the existing H1 GitHub login and fixed per-operation private staging directory. Accept only the single canonical `job-admission.json`, preserve create-only semantics, and reopen through the existing attestation/current-job reader before returning. `runId` selects an untrusted artifact, never grants permission.

Fixed hosted key/input directory: `/dev/shm/stage1-keys/r3-job-<operationRef without hyphens>`, root:0700 on the already checked tmpfs. Files are `forwarding.key` (OpenSSH), `signing-key.pem` (PKCS8), `creation-spec.json` and `job-admission.json`, all root:0600 and create-only. The reader returns `{privateKey,sshPrivateKeyPath,recheck,close}` after proving both private encodings have the admitted same public key. The SFTP adapter holds this reader rather than accepting a path or key override. H1's pinned public host key is read from `release/contracts/stage1-r3-h1-known-hosts` relative to the checked installed repository.

- [ ] Add failing checks for build/source/policy mismatch, duplicate spec, wrong job/ref/runner/machine, key mismatch and forbidden override fields. Assert a generated spec reopens under the existing reader and admission bytes bind its exact digest.
- [ ] Implement the writers with existing canonical encoders and current API observations. The hosted preparation step writes the declared job file; the protected job uses the repository's pinned `actions/attest` and `actions/upload-artifact` steps for the exact artifact above. H1 imports it with the fixed downloader; neither SSH key is installed until GitHub attestation and the independent current job API pass. Nonsecret creation-spec bytes are an explicit workflow input from the owner-prepared spec, bound by the subsequently attested job declaration. Do not invent a local GitHub signature or describe these steps as already wired into CI.
- [ ] Pin H1's public SSH host key from the already trusted management connection into the reviewed fixed hosted input. Do not trust a bare `ssh-keyscan` result or disable StrictHostKeyChecking.
- [ ] Run the affected focused checks and key-format probe, register new runtime files in the existing contract manifest, and commit. No workflow dispatch and no broad R2/R3 rerun.

## Task 3: Connected source/fresh caller and one bounded SSH probe

**Consumes:** Task 1 adapters, Task 2 fixed inputs, `launchR3TargetCreate({repoRoot,operationRef})` and `openR3HostedCreationControl({creationSpecBytes,jobAdmissionBytes})`.

**Produces:** `runR3SourceFreshH1({repoRoot,operationRef})` and `runR3SourceFreshHosted({repoRoot,operationRef})`, exposed only through fixed CLI modes `--side h1|hosted --operation-ref <uuid>`. Repository location comes from the installed script, with no command/credential/path overrides. CLI output is a nonsecret operation result, not old public `source-gate` evidence.

- [ ] Add a focused failing sequence test that holds both sides alive: creation bytes import → PG/databases/destination/creation → complete source manifest → explicit exact-terminal owner confirmation → source ACK → hosted owned cleanup → cleanup bundle import → imported notice → actual forward child exit → H1 completeCleanup/close → CLOSED delivery. Assert no ACK after manifest success alone and no cleanup after wrong digest/EOF.
- [ ] Implement H1 orchestration around the real native holder and a local terminal prompt. Keep the authenticated owner process alive while waiting; bind its affirmative input to the displayed terminal digest. Publish notices only after the matching native method has returned and its retained record bytes are read back.
- [ ] Implement hosted orchestration around the real controller, its automatic PG relay, the actual bounded forward SSH child and Task 1 SFTP adapter. Preserve the temporary signing key until both signed bundles are exported, then perform owned cleanup. An interrupted operation cannot be restarted with new selectors.
- [ ] Run one isolated OpenSSH probe using the approved exact account restrictions and temporary names; prove file transfer, denied shell/forward/link/outbox writes, bounded inbox and SFTP survival after forward shutdown. Do not use the real DB or replay the long core history test.
- [ ] Apply the approved new-account configuration on H1 only after the probe and script review; keep the management SSH connection, validate syntax and compare root/original-forward effective settings before/after. Reuse approved SSH access; do not request the same account permission again.
- [ ] Run focused sequence/failure tests, contract verification, discovery and scoped lint once after integration. Record exactly which native/remote/CI paths remain unexecuted. Commit; no push, merge or workflow dispatch.

## Completion boundary

This plan completes the source/fresh caller and its transport, not Stage 1 itself. Actual GitHub admission requires the workflow wiring and authorized dispatch; retain that distinction in the status record. The old public evidence/aggregate mapping must be aligned before changing protected workflow success outputs. Then reuse the connected route for source/snapshot and both final chains, with lawful snapshot input, actual same-candidate R2/R3, Staging migration alignment and R4. No fabricated or relabelled release evidence.

Execution is authorized by the user's approval of the linked design. Root owns interfaces, input/caller integration and deployment; a bounded Sol agent may implement Task 1 after its exact brief. Use one independent review of the integrated change, not per-file reviewer chains. No further design approval is required unless the implementation must change the approved permission boundary.
