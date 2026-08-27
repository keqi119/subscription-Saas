import {
  AssetWorkOrderEvidenceAction,
  AssetWorkOrderEvidenceType,
  AssetWorkOrderEventType,
  AssetWorkOrderStatus,
  AssetWorkOrderType
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  evaluateVehicleSwapWorkOrderReadiness,
  VEHICLE_SWAP_READINESS_FIELDS
} from "../src/subscription-change/subscription-vehicle-swap-activation.service";

describe("vehicle-swap activation readiness", () => {
  it("accepts a closed governed work order with complete handover facts and durable evidence", () => {
    expect(
      evaluateVehicleSwapWorkOrderReadiness(
        readyWorkOrder(AssetWorkOrderType.SWAP_INBOUND, "source-vehicle"),
        {
          vehicleId: "source-vehicle",
          workOrderType: AssetWorkOrderType.SWAP_INBOUND
        }
      )
    ).toEqual({ blockers: [], ready: true });
  });

  it.each(VEHICLE_SWAP_READINESS_FIELDS)(
    "blocks activation when the %s handover fact is absent",
    (field) => {
      const workOrder = readyWorkOrder(AssetWorkOrderType.SWAP_OUTBOUND, "target-vehicle");
      const closedEvent = workOrder.events[0]!;
      const swapReadiness = {
        ...(closedEvent.detailSnapshot.swapReadiness as Record<string, boolean>),
        [field]: false
      };

      expect(
        evaluateVehicleSwapWorkOrderReadiness(
          {
            ...workOrder,
            events: [
              {
                ...closedEvent,
                detailSnapshot: { swapReadiness }
              }
            ]
          },
          {
            vehicleId: "target-vehicle",
            workOrderType: AssetWorkOrderType.SWAP_OUTBOUND
          }
        )
      ).toEqual({
        blockers: [`HANDOVER_FACT_${field.toUpperCase()}_MISSING`],
        ready: false
      });
    }
  );

  it("requires both condition and signed-document evidence with an immutable content hash", () => {
    const workOrder = readyWorkOrder(AssetWorkOrderType.SWAP_OUTBOUND, "target-vehicle");

    expect(
      evaluateVehicleSwapWorkOrderReadiness(
        {
          ...workOrder,
          evidence: workOrder.evidence.filter(
            ({ evidenceType }) => evidenceType !== AssetWorkOrderEvidenceType.DOCUMENT
          )
        },
        {
          vehicleId: "target-vehicle",
          workOrderType: AssetWorkOrderType.SWAP_OUTBOUND
        }
      )
    ).toEqual({ blockers: ["SIGNED_DOCUMENT_EVIDENCE_MISSING"], ready: false });

    expect(
      evaluateVehicleSwapWorkOrderReadiness(
        {
          ...workOrder,
          evidence: workOrder.evidence.map((item) => ({ ...item, contentSha256: null }))
        },
        {
          vehicleId: "target-vehicle",
          workOrderType: AssetWorkOrderType.SWAP_OUTBOUND
        }
      )
    ).toEqual({
      blockers: ["CONDITION_EVIDENCE_MISSING", "SIGNED_DOCUMENT_EVIDENCE_MISSING"],
      ready: false
    });
  });

  it("rejects a wrong vehicle, direction, or non-closed work order", () => {
    const workOrder = readyWorkOrder(AssetWorkOrderType.SWAP_INBOUND, "source-vehicle");

    expect(
      evaluateVehicleSwapWorkOrderReadiness(
        {
          ...workOrder,
          status: AssetWorkOrderStatus.PENDING
        },
        {
          vehicleId: "target-vehicle",
          workOrderType: AssetWorkOrderType.SWAP_OUTBOUND
        }
      )
    ).toEqual({
      blockers: [
        "WORK_ORDER_NOT_CLOSED",
        "WORK_ORDER_TYPE_MISMATCH",
        "WORK_ORDER_VEHICLE_MISMATCH"
      ],
      ready: false
    });
  });
});

function readyWorkOrder(workOrderType: AssetWorkOrderType, vehicleId: string) {
  return {
    evidence: [
      {
        action: AssetWorkOrderEvidenceAction.ATTACH,
        contentSha256: "a".repeat(64),
        evidenceType: AssetWorkOrderEvidenceType.PHOTO,
        fileId: "condition-file",
        supersededBy: null
      },
      {
        action: AssetWorkOrderEvidenceAction.ATTACH,
        contentSha256: "b".repeat(64),
        evidenceType: AssetWorkOrderEvidenceType.DOCUMENT,
        fileId: "signed-document-file",
        supersededBy: null
      }
    ],
    events: [
      {
        detailSnapshot: {
          swapReadiness: Object.fromEntries(
            VEHICLE_SWAP_READINESS_FIELDS.map((field) => [field, true])
          )
        },
        eventType: AssetWorkOrderEventType.CLOSED,
        sequence: 7
      }
    ],
    status: AssetWorkOrderStatus.CLOSED,
    vehicleId,
    workOrderType
  };
}
