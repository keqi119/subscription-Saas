# Stage1 active forward locks in historical verification

RC 40193967194 failed during SIGN_HISTORY before authorization persistence or socket connection. The 728e created-target policy requires its retired forward-slot names to be absent. Every new R3 session reuses those same two global names; its own live locks therefore make the historical check fail. The after-cleanup probe could not reproduce this context.

## Scope and authority

Repair this release-control defect only, under the user's standing authorization for closure-aligned plans and implementation. Keep historical UNKNOWN records, signatures, 39 retained target locks, strict incident policy, current evidence capture, and real SOURCE/SNAPSHOT/ACK requirements. No business code, schema change, remote history deletion, or automatic RC retry.

## Approaches

Changing the incident assessor to accept arbitrary foreign session locks would broaden a historical exception. Instead, the selected implementation keeps that assessor unchanged. Only the live `verifyR3History` caller supplies a historical view after proving that exactly two captured entries match its private lock paths and bytes. All other entries remain. The full capture continues to hold and recheck both active locks and every historical original. Standalone historical readers receive the unfiltered view.

This is an implementation decision under delegated authority, not a new human approval. Removing locks physically or bypassing SIGN_HISTORY is excluded.

## Evidence required

The existing real session test must reach sign with a historical group and two live locks, assert that the incident-reader boundary gets only historical locks, and prove that its store still contains both current lock files. Missing or substituted current locks must fail. The strict created-target assessor must continue rejecting a forward-slot name in its historical input. Preserve a failing-before/fixed-after local result before any new release candidate.
