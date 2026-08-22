import { describe, expect, it } from "vitest";

import {
  projectSubscriptionClosureAdmin,
  projectSubscriptionClosureCustomer,
  sanitizeSubscriptionClosurePublic
} from "../src/subscription-closure/subscription-closure.projection";

describe("subscription closure public projections", () => {
  it("recursively removes approval comments, command envelopes, provider payloads, and BigInt", () => {
    const source = {
      amountDueCents: 1250n,
      nested: {
        approvalComment: "secret approval",
        approval_comment: "secret approval variant",
        "callback-payload": { token: "secret" },
        commandEnvelope: { sourceKey: "secret" },
        command_request: { sourceKey: "secret" },
        providerPayload: { token: "secret" },
        provider_request_payload: { token: "secret" },
        requestSnapshot: { providerRequest: true },
        responseSnapshot: { providerResponse: true },
        safe: [{ decisionComment: "secret", value: 3n }]
      }
    };
    expect(sanitizeSubscriptionClosurePublic(source)).toEqual({
      amountDueCents: "1250",
      nested: { safe: [{ value: "3" }] }
    });
  });

  it("keeps an admin operational graph but emits a deliberately smaller customer view", () => {
    const aggregate = {
      closureCase: {
        caseNo: "SC-1",
        closureType: "NORMAL_COMPLETION",
        effectiveAt: new Date("2026-08-24T00:00:00.000Z"),
        finalDisposition: "COMPLETE",
        id: "case-1",
        physicalControlMode: "VOLUNTARY_RETURN",
        status: "PENDING_SETTLEMENT"
      },
      currentDocuments: [
        { documentType: "RETURN_MANIFEST", signedFileId: "file-1", stage: "ARCHIVED" }
      ],
      events: [{ eventType: "RETURN_CONFIRMED", sourceKey: "private-source" }],
      settlementRevisions: [
        { amountDueCents: 0n, amountRefundableCents: 500n, resultHash: "hash", stage: "FINALIZED" }
      ],
      vehicleReturn: { returnLocation: "Depot", scheduledAt: new Date("2026-08-25T00:00:00.000Z") },
      workOrders: [
        {
          evidence: [
            {
              captureMetadata: { providerPayload: { token: "secret" } },
              evidenceType: "PHOTO",
              fileId: "evidence-file-1",
              id: "evidence-1"
            }
          ],
          id: "wo-1"
        }
      ]
    };
    const admin = projectSubscriptionClosureAdmin(aggregate);
    const customer = projectSubscriptionClosureCustomer(aggregate);
    expect(admin).toMatchObject({ events: expect.any(Array), workOrders: expect.any(Array) });
    expect(customer).toEqual({
      caseNo: "SC-1",
      closureType: "NORMAL_COMPLETION",
      effectiveAt: "2026-08-24T00:00:00.000Z",
      evidenceReferences: [{ evidenceType: "PHOTO", fileId: "evidence-file-1", id: "evidence-1" }],
      finalDisposition: "COMPLETE",
      nextAction: "等待最终结算",
      physicalControlMode: "VOLUNTARY_RETURN",
      returnAppointment: { location: "Depot", scheduledAt: "2026-08-25T00:00:00.000Z" },
      settlement: { amountDueCents: "0", amountRefundableCents: "500", stage: "FINALIZED" },
      signedReferences: [{ documentType: "RETURN_MANIFEST", fileId: "file-1", stage: "ARCHIVED" }],
      status: "PENDING_SETTLEMENT"
    });
    expect(JSON.stringify(customer)).not.toContain("private-source");
  });
});
