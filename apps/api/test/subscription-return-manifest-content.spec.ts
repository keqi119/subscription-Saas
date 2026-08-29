import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { isCurrentRegistrationDocumentApproval } from "../src/esign/return-manifest-esign.service";
import { canonicalSubscriptionClosureJson } from "../src/subscription-closure/subscription-closure.domain";

import {
  buildReturnManifestModel,
  extractReturnManifestPdfFacts
} from "../src/subscription-closure/subscription-return-manifest-model";

describe("return manifest model", () => {
  it("accepts only an independently approved, exact registration-document evidence snapshot", () => {
    const snapshot = {
      checklistItemId: "registration-item-1",
      checklistItemState: "MISSING",
      checklistManifestHash: "a".repeat(64),
      checklistRevisionId: "checklist-1",
      closureCaseId: "closure-1",
      evidenceIds: ["evidence-1"]
    };
    const approval = {
      decidedAt: new Date("2026-08-29T00:00:00.000Z"),
      decidedBy: "approver-1",
      decision: "APPROVED",
      exceptionType: "VEHICLE_REGISTRATION_DOCUMENT_MISSING",
      expiredAt: null,
      requestedBy: "requester-1",
      status: "APPROVED",
      subjectField: "returnRegistrationDocument:registration-item-1",
      subjectId: "closure-1",
      subjectSnapshot: snapshot,
      subjectSnapshotHash: createHash("sha256")
        .update(canonicalSubscriptionClosureJson(snapshot as never))
        .digest("hex"),
      subjectType: "SETTLEMENT_CASE"
    };
    const base = {
      approval,
      checklist: { id: "checklist-1", manifestHash: "a".repeat(64) },
      closureCaseId: "closure-1",
      evidenceLinks: [{
        checklistItemId: "registration-item-1",
        evidenceId: "evidence-1"
      }],
      registrationItem: { id: "registration-item-1", state: "MISSING" }
    };

    expect(isCurrentRegistrationDocumentApproval(base)).toBe(true);
    expect(isCurrentRegistrationDocumentApproval({
      ...base,
      evidenceLinks: [{ checklistItemId: "key-item-1", evidenceId: "evidence-1" }]
    })).toBe(false);
    expect(isCurrentRegistrationDocumentApproval({
      ...base,
      approval: { ...approval, decidedBy: "requester-1" }
    })).toBe(false);
    expect(isCurrentRegistrationDocumentApproval({
      ...base,
      approval: { ...approval, subjectSnapshotHash: "b".repeat(64) }
    })).toBe(false);
  });

  it("contains every signed return fact and evidence hash", () => {
    const manifest = buildReturnManifestModel({
      attestation: { mode: "CUSTOMER_REFUSED", reason: "客户拒绝签字", witnesses: ["张三"] },
      caseNo: "SC-1",
      checklist: [
        { itemCode: "KEY", returnedQuantity: 1, state: "NORMAL" },
        { itemCode: "REGISTRATION_CERTIFICATE", returnedQuantity: 1, state: "NORMAL" }
      ],
      customerComments: "不同意损伤费用",
      damages: [{ description: "右门划痕", evidenceIds: ["e-1"] }],
      evidence: [{ contentSha256: "a".repeat(64), id: "e-1" }],
      location: "上海交付中心",
      mileageKm: 12345,
      pickupAt: "2026-08-28T10:00:00.000Z",
      revision: 2,
      vehicle: { id: "vehicle-1", vin: "VIN001" }
    });

    expect(manifest).toMatchObject({
      attestation: { mode: "CUSTOMER_REFUSED" },
      customerComments: "不同意损伤费用",
      mileageKm: 12345,
      revision: 2
    });
    expect(manifest.evidenceManifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.manifestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("extracts every checklist and evidence fact for the signed PDF", () => {
    const facts = extractReturnManifestPdfFacts(
      {
        returnChecklistAttestationMode: "CUSTOMER_SIGNED",
        returnChecklistManifestHash: "b".repeat(64),
        returnChecklistRevisionId: "revision-2",
        returnChecklistSnapshot: {
          customerComments: "钥匙共两把",
          items: [
            {
              expectedQuantity: 2,
              itemCode: "KEY",
              remark: "均已收回",
              returnedQuantity: 2,
              state: "NORMAL"
            },
            {
              expectedQuantity: 1,
              itemCode: "REGISTRATION_CERTIFICATE",
              returnedQuantity: 1,
              state: "NORMAL"
            }
          ],
          revisionNumber: 2
        },
        returnEvidence: [
          {
            contentSha256: "a".repeat(64),
            evidencePurpose: "CHECKLIST_PROOF",
            evidenceType: "PHOTO",
            fileId: "file-1"
          }
        ],
        returnLocation: "上海交付中心",
        returnScheduledAt: "2026-08-28T10:00:00.000Z"
      },
      {}
    );

    expect(facts).toMatchObject({
      attestationMode: "CUSTOMER_SIGNED",
      checklistRevisionNumber: 2,
      customerComments: "钥匙共两把",
      returnLocation: "上海交付中心"
    });
    expect(facts.items.map(({ itemCode }) => itemCode)).toEqual([
      "KEY",
      "REGISTRATION_CERTIFICATE"
    ]);
    expect(facts.evidence[0]).toMatchObject({
      contentSha256: "a".repeat(64),
      fileId: "file-1"
    });
  });
});
