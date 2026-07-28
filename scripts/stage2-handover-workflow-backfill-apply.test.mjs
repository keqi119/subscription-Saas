import assert from "node:assert/strict";
import test from "node:test";

import {
  applyStage2BackfillJobCandidates
} from "./stage2-handover-workflow-backfill-apply.mjs";

const CUSTOMER_TRANSACTION_ID = "ESG20260726080000ABCDH1";

test("accepts an upsert winner only when its full job contract matches", async () => {
  const candidate = customerReconcileCandidate();
  const tx = {
    vehicleHandoverWorkflowJob: {
      upsert: async () => ({
        ...structuredClone(candidate),
        id: "created-job-1",
        jobStatus: "PENDING"
      })
    }
  };

  await assert.doesNotReject(
    applyStage2BackfillJobCandidates(tx, [candidate])
  );
});

test("rejects a concurrent same-key winner with conflicting payload or status", async () => {
  const candidate = customerReconcileCandidate();
  for (const conflict of [
    {
      payload: {
        customerTransactionId: "ATTACKERCONTROLLEDH1"
      }
    },
    {
      jobStatus: "CANCELLED"
    }
  ]) {
    const tx = {
      vehicleHandoverWorkflowJob: {
        upsert: async () => ({
          ...structuredClone(candidate),
          id: "concurrent-job-1",
          jobStatus: "PENDING",
          ...conflict
        })
      }
    };

    await assert.rejects(
      applyStage2BackfillJobCandidates(tx, [candidate]),
      /STAGE2_HANDOVER_WORKFLOW_BACKFILL_JOB_WRITE_CONFLICT/
    );
  }
});

function customerReconcileCandidate() {
  return {
    eSignTaskId: "stage2-task-1",
    handoverId: "handover-1",
    idempotencyKey:
      `customer-reconcile:stage2-task-1:${CUSTOMER_TRANSACTION_ID}`,
    jobType: "RECONCILE_CUSTOMER_SIGNATURE",
    payload: {
      customerTransactionId: CUSTOMER_TRANSACTION_ID
    },
    workOrderId: "work-order-1"
  };
}
