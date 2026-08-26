import assert from "node:assert/strict";
import test from "node:test";

import { classifyFinalPlanOrderReconciliation } from "./stage1-journey-final-plan-order-reconcile-core.mjs";

test("returns a customer-waiting journey to pending vehicle allocation", () => {
  assert.deepEqual(
    classifyFinalPlanOrderReconciliation(
      journeyRow({
        currentStepCode: "CUSTOMER_PLAN_CONFIRMATION",
        currentStepStatus: "WAITING_CUSTOMER",
        journeyStatus: "WAITING_CUSTOMER"
      })
    ),
    {
      action: "RETURN_TO_VEHICLE_ALLOCATION",
      reason: "vehicle allocation is still pending before customer confirmation"
    }
  );
});

test("advances a matching already-confirmed allocation without another confirmation", () => {
  assert.deepEqual(
    classifyFinalPlanOrderReconciliation(
      journeyRow({
        currentStepCode: "FINAL_VEHICLE_ALLOCATION",
        currentStepStatus: "WAITING_MANUAL",
        customerConfirmationCommercialHash: `sha256:${"a".repeat(64)}`,
        journeyStatus: "WAITING_MANUAL",
        steps: {
          CUSTOMER_PLAN_CONFIRMATION: "COMPLETED",
          FINAL_VEHICLE_ALLOCATION: "WAITING_MANUAL"
        }
      })
    ),
    {
      action: "ADVANCE_WITHOUT_RECONFIRMATION",
      reason: "confirmed revision, commercial hash, and soft reservation match"
    }
  );
});

test("reports mismatched or corrupt allocation records without changing them", () => {
  assert.deepEqual(
    classifyFinalPlanOrderReconciliation(
      journeyRow({
        currentStepCode: "FINAL_VEHICLE_ALLOCATION",
        customerConfirmationCommercialHash: `sha256:${"b".repeat(64)}`,
        journeyStatus: "WAITING_MANUAL"
      })
    ),
    {
      action: "REPORT_ONLY",
      reason: "confirmed commercial hash does not match the final plan"
    }
  );
  assert.deepEqual(
    classifyFinalPlanOrderReconciliation(
      journeyRow({
        currentStepCode: "FINAL_VEHICLE_ALLOCATION",
        softReservedVehicleId: null
      })
    ),
    {
      action: "REPORT_ONLY",
      reason: "final vehicle is not held by the application soft reservation"
    }
  );
});

test("is idempotent for terminal and already reconciled journeys", () => {
  assert.deepEqual(
    classifyFinalPlanOrderReconciliation(
      journeyRow({ currentStepCode: "ORDER_AND_CONTRACT_CREATION" })
    ),
    { action: "NONE", reason: "journey is outside the affected final-plan steps" }
  );
  assert.deepEqual(
    classifyFinalPlanOrderReconciliation(journeyRow({ journeyStatus: "COMPLETED" })),
    { action: "NONE", reason: "terminal journeys are immutable" }
  );
});

function journeyRow(overrides = {}) {
  return {
    currentStepCode: "CUSTOMER_PLAN_CONFIRMATION",
    currentStepStatus: "WAITING_CUSTOMER",
    customerConfirmationCommercialHash: null,
    customerConfirmedPlanRevision: 2,
    finalPlanCommercialHash: `sha256:${"a".repeat(64)}`,
    finalPlanRevision: 2,
    finalVehicleId: "vehicle-1",
    journeyStatus: "RUNNING",
    softReservedVehicleId: "vehicle-1",
    steps: {
      CUSTOMER_PLAN_CONFIRMATION: "WAITING_CUSTOMER",
      FINAL_VEHICLE_ALLOCATION: "PENDING"
    },
    ...overrides
  };
}
