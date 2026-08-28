import { describe, expect, it } from "vitest";

import {
  buildBoundHandoverFactSnapshot,
  buildPhysicalHandoverFactSnapshot,
  getExplicitHandoverFactBlockingCodes
} from "../src/handover-work-order/handover-explicit-facts";

describe("explicit handover facts", () => {
  it("canonicalizes accessories and produces a stable physical fact hash", () => {
    const first = buildPhysicalHandoverFactSnapshot({
      accessoryItems: [
        { code: "CHARGING_CABLE", name: "Charging cable", quantity: 1, remark: "sealed", state: "PRESENT" },
        { code: "WARNING_TRIANGLE", name: "Warning triangle", quantity: 1, state: "PRESENT" }
      ],
      handoverFactRevision: 3,
      keyState: "COMPLETE",
      primaryKeyCount: 1,
      registrationDocumentRemarks: null,
      registrationDocumentState: "HANDED_OVER",
      spareKeyCount: 1,
      vehicleConditionConfirmed: true,
      vehicleConditionRemarks: "No unrecorded damage"
    });
    const second = buildPhysicalHandoverFactSnapshot({
      ...first.snapshot,
      accessoryItems: [...first.snapshot.accessoryItems].reverse()
    });

    expect(first.snapshot.accessoryItems.map((item) => item.code)).toEqual([
      "CHARGING_CABLE",
      "WARNING_TRIANGLE"
    ]);
    expect(first.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second.hash).toBe(first.hash);
  });

  it("binds the document ledger and exact approved exception into a new fact hash", () => {
    const physical = buildPhysicalHandoverFactSnapshot(completeFacts());
    const documentPresent = buildBoundHandoverFactSnapshot(physical.snapshot, {
      allowed: true,
      approval: null,
      documentPresent: true,
      snapshotHash: "ledger-a"
    });
    const approvedException = buildBoundHandoverFactSnapshot(physical.snapshot, {
      allowed: true,
      approval: {
        approvalNo: "BEA-001",
        decision: "APPROVE",
        id: "approval-1",
        status: "APPROVED",
        subjectSnapshotHash: "ledger-b",
        version: 2
      },
      documentPresent: false,
      snapshotHash: "ledger-b"
    });

    expect(documentPresent.hash).not.toBe(approvedException.hash);
    expect(approvedException.snapshot.registrationAuthority).toEqual({
      approval: {
        approvalNo: "BEA-001",
        decision: "APPROVE",
        id: "approval-1",
        status: "APPROVED",
        subjectSnapshotHash: "ledger-b",
        version: 2
      },
      documentPresent: false,
      snapshotHash: "ledger-b"
    });
  });

  it("reports each missing confirmation group independently", () => {
    expect(getExplicitHandoverFactBlockingCodes({
      accessoryItems: null,
      keyState: null,
      primaryKeyCount: null,
      registrationDocumentState: null,
      spareKeyCount: null,
      vehicleConditionConfirmed: null
    })).toEqual([
      "VEHICLE_CONDITION_CONFIRMATION_MISSING",
      "KEY_CONFIRMATION_MISSING",
      "REGISTRATION_DOCUMENT_CONFIRMATION_MISSING",
      "ACCESSORY_CONFIRMATION_MISSING"
    ]);
  });
});

function completeFacts() {
  return {
    accessoryItems: [
      { code: "CHARGING_CABLE", name: "Charging cable", quantity: 1, state: "PRESENT" }
    ],
    handoverFactRevision: 1,
    keyState: "COMPLETE",
    primaryKeyCount: 1,
    registrationDocumentState: "HANDED_OVER",
    spareKeyCount: 1,
    vehicleConditionConfirmed: true
  };
}
