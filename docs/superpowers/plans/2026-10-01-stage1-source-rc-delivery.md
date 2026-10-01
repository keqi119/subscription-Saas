# Stage 1 source RC evidence delivery

> **For agentic workers:** Use superpowers:executing-plans. Continue the user-approved Stage 1 closeout and the prior delivery plan's next step; this changes existing release interfaces, not account permissions or business scope.

**Goal:** Carry genuine source/fresh gate evidence from the completed native H1 execution to the hosted caller, ready for existing RC attestation/upload steps.

**Architecture:** Reuse `runSourceDatabaseGate` with the native holder's independently reconstructed manifest and actual target. Deliver that projection only with the existing CLOSED notice after explicit owner acknowledgement and verified cleanup. Keep the hosted result separate from its eventual attested artifact. Do not turn a CLOSED status into a passing database result.

**Tech stack:** Existing Node ESM, native H1 holder, existing private originals and SFTP connection. No dependency, identity, service or public schema addition.

**Spec:** The next-work/completion boundary in [the approved delivery design](../specs/2026-09-30-stage1-r3-evidence-delivery-design.md) and [delivery implementation plan](2026-09-30-stage1-r3-evidence-delivery.md), plus existing `source-gate-evidence.v1` and RC workflow contracts.

## Constraints and decisions

- Preserve H1/hosted admission, source originals, manual result/ACK/cleanup/CLOSED and the existing source/snapshot behavior. Do not change historical core validation to make export convenient.
- Add a fresh-only projection in `r3-source-result.mjs`. It consumes the completed execution/result, their reconstructed manifest, admitted spec/job, exact contract digests and actual PostgreSQL identity. It reuses the existing public gate builder and rejects inconsistent bindings, failed/empty reports and snapshot input.
- `launch-manual-stage1.mjs` supplies those values from its existing private state only after source completion and readback. It may return the projection beside its current nonpromotional result. It must not derive provenance from H1 ambient GitHub variables.
- Bind `ciRunRef` to the admitted job in the internal delivery scope. Include the canonical public evidence and its digest in source/fresh CLOSED delivery; validate schema, source/chain/run identity and passing complete counts. Other phase/chain notices retain their current shape and cannot carry a fresh projection.
- The existing CLOSED receipt binds the entire notice, including the projected evidence. Preserve the 1 MiB limit and existing fixed files, permissions and account configuration.
- The hosted adapter separates reading CLOSED from sending its exact receipt. The caller first create-only writes and reads back `.release-output/source-fresh/source-gate-fresh.v1.json`, then sends that receipt and returns the canonical evidence only after SFTP exit and its normal key cleanup. A failed write sends no receipt; existing evidence is never overwritten. The workflow still needs explicit bootstrap/input/attestation/upload wiring. Do not change old workflow success outputs before those dependencies are implemented.
- No push, merge, workflow dispatch, cloud changes, business changes or commercial KMS. No long source/final composition rerun.

## Review focus

1. A completed result must bind the exact reconstructed manifest and target; callers cannot substitute another passing report.
2. Public CI provenance comes from the admitted job, not the H1 shell or an arbitrary workflow input.
3. Wrong owner ACK, incomplete cleanup or absent CLOSED cannot return publishable evidence.
4. The transferred evidence, its digest and its receipt must change together; mismatched source/run/chain fails.
5. Fresh-only export must not falsely enable snapshot or final RC evidence.

## Execution

- [x] Extend the existing short source-result fixture with a failing projection check and mutations of binding/counts/job. Implement `buildR3SourceFreshGateEvidence` in the existing result module and its native invocation; no new full history fixture.
- [x] Extend the existing delivery codec test for payload/digest/CI binding and the caller sequence test for evidence returned only after CLOSED. Update both adapters and callers without adding transport files.
- [x] Run only the changed short tests, scoped lint, format and contract verification. Obtain one bounded review of the integrated change; record exactly which boundaries remain synthetic.
- [x] Save a local commit and continue protected hosted workflow bootstrap/input/attestation/artifact wiring. Retain lawful snapshot provenance, actual same-candidate R2/R3, Staging migrations and R4 as incomplete.

Preflight: `22f993` clean `eacf3ac6`; local migrate status stopped before connection because datasource.url is absent. `f112d1` Prisma validate passed. This round changes release infrastructure only.

## Protected source/fresh workflow increment

The projection/delivery increment is committed as `5aaf5bcd`, reviewed without P1/P2. Continue the already planned workflow wiring in the same worktree. New-round preflight `80d118` again stopped before DB connection for absent local datasource.url; `ed9145` Prisma schema validation passed.

- Change only source/fresh to `ubuntu-24.04` under its existing protected environment. Pin setup-node v4.4.0 to its verified full commit and select Node 22. Keep existing pnpm lockfile and artifact actions.
- Accept one public canonical creation-spec input that was produced on H1 by the existing fixed writer. Pass it through an environment variable, never interpolate JSON into shell. Require its source/build digest to agree with the workflow's existing candidate inputs before preparing the current job.
- On that ephemeral hosted job only, install the required encryption tools, stop and runtime-mask default Docker/containerd, disable swap/core, and create the three fixed root-only workspace parents. Existing native observation still decides whether the actual Engine/containerd/workspace is admissible; image software listings do not prove compatibility.
- Invoke the existing current-job builder as root with an explicit environment allowlist. Attest/upload only a byte-checked public copy of `job-admission.json`; do not expose its private directory. H1 imports this attested artifact through its existing fixed reader and starts its owner process separately.
- Allow up to ten minutes (still bounded by the admitted expiry) for the initial H1/SFTP handoff after job artifact publication. This covers H1 artifact verification/startup, not a retry of a consumed operation.
- Run the hosted caller with core disabled and fixed operation reference. Require its actual CLOSED return and matching saved public evidence before the existing attest/upload/readback/custody steps can run. Preserve those steps and their artifact names; leave snapshot/final paths visibly pending.
- Validate YAML, shell/embedded JavaScript syntax and the existing short DAG contract test. Extend that existing test only for the new public-input/job-attestation/hosted-output path. No real workflow dispatch or local/remote service changes in this increment.

References: [setup-node v4.4.0 commit](https://github.com/actions/setup-node/commit/49933ea5288caeca8642d1e84afbd3f7d6820020), [official Ubuntu 24.04 runner inventory](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md). The inventory is mutable; runtime observations remain mandatory.

Implemented and reviewed without remaining P1/P2. Existing DAG regression RED `94556b` became GREEN `e29a9c`. Inspection reproduced `sudo` secure_path hiding Node (`e6462b`), so root steps now use the selected Node absolute path; `2be64c` confirmed that path runs Node 22.22.2. Three exact public-file uploads explicitly include hidden paths per the [pinned action's documented behavior](https://github.com/actions/upload-artifact/blob/043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/README.md#uploading-hidden-files). Final `afee9d`: DAG 1/1, duplicate-key-aware YAML parse, five shell blocks and two embedded modules syntax PASS. These are static/local checks, not real CI/Engine acceptance.
