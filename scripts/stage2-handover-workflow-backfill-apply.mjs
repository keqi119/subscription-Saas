import {
  stage2BackfillJobMatchesCandidate
} from "./stage2-handover-workflow-contract.mjs";

export async function applyStage2BackfillJobCandidates(tx, candidates) {
  for (const candidate of candidates) {
    const persisted = await tx.vehicleHandoverWorkflowJob.upsert({
      create: {
        eSignTaskId: candidate.eSignTaskId,
        handoverId: candidate.handoverId,
        idempotencyKey: candidate.idempotencyKey,
        jobType: candidate.jobType,
        payload: candidate.payload,
        workOrderId: candidate.workOrderId
      },
      select: {
        eSignTaskId: true,
        handoverId: true,
        id: true,
        idempotencyKey: true,
        jobStatus: true,
        jobType: true,
        payload: true,
        workOrderId: true
      },
      update: {},
      where: {
        idempotencyKey: candidate.idempotencyKey
      }
    });
    if (!stage2BackfillJobMatchesCandidate(persisted, candidate)) {
      throw new Error(
        "STAGE2_HANDOVER_WORKFLOW_BACKFILL_JOB_WRITE_CONFLICT"
      );
    }
  }
}
