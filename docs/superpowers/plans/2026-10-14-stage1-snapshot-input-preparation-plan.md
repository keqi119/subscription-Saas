# Stage 1 snapshot input preparation

Scope: finish the missing production bridge between already verified snapshot originals and the existing R3 consumer. Do not issue a new RC, change the owner prompt, fabricate an allowed use, or repeat successful production steps.

1. Add a declaration-only preparation reader sharing the original source/storage checks. Keep the full permission reader mandatory.
2. Add a standalone fixed H1 preparation entry in the authenticated candidate checkout. Accept only releaseAttemptId, snapshotRunId and operationRef. Authenticate the existing producer/completion originals, the fixed protected owner configuration and the actual creation spec. Freeze a phase UUID, originals and preparation bytes before the live window. Keep the signing control bundle's entry points and dependency boundary unchanged.
3. Install the phase permission/index from the session's actual created destination and job admission. Close all preparation captures before writes, reopen the full reader afterwards, and preserve the original deadline and one-attempt rule.
4. Run finite fixture checks for missing originals, mismatched identities, caller overrides, actual source/final bindings and private-path reuse. Review the combined change before build/RC preparation.

Fixed H1 configuration: snapshot-authority/r3-input-pins.json maps operationRef to the canonical digest of snapshot-authority/r3-inputs/<operationRef>/approval.json. The approval binds sourceSha, profileDigest, ownerId, releaseAttemptId, snapshotRunId, operationRef, phase, validUntil, sourceAuthority, sourceIdentity and restrictionOriginals. Raw owner originals live below that operation directory's raw/<digest>.bin. Both the exact approval and pin list are installed only after review of the actual owner declaration; the API cannot supply or replace them. No runtime configuration is created by this code change.

Preparation layout: archive/inputs/snapshots/prepared/<operationRef>/{raw/<digest>.bin,package.json}. Precreate the archive/raw and snapshot parents before any live session. A repeated operation directory or package is a reconciliation stop; no overwrite/delete. Missing historical before observations cannot be reconstructed from after observations.

Deployment: invoke scripts/release/prepare-h1-r3-snapshot-input.mjs from /opt/stage1-r3-candidate-<first-seven-source-hex>. Its module location must match the authenticated producer source. The fixed creation reader validates the entire source SHA, clean checkout, build and executing verifier bytes. The short directory suffix is only a locator. H1 signing continues to run from its original content-addressed control bundle; it does not import this preparation entry or the R3 runtime.

Validity is bounded by the actual creation spec, owner use approval, profile and snapshot metadata. A completed producer's execution expiry is not a new snapshot use grant and is not substituted for these use limits. No signature/key is created by preparation.

Installation checks the full declarations and the single allowed phase/destination/job use. The actual consumer request is checked at consumeSnapshot, after its real attempt allocation digest exists and before signing. No synthetic consumer request is used as a substitute. The local installation budget is bounded by both the original startup wall and monotonic deadlines, and by a 30-second local cap.
