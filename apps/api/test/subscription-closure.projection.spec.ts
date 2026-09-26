import { describe, expect, it } from "vitest";

import {
  SubscriptionClosureProjectionService,
  governedAllowedActions,
  projectSubscriptionClosureAdmin,
  projectSubscriptionClosureCustomer,
  sanitizeSubscriptionClosurePublic
} from "../src/subscription-closure/subscription-closure.projection";
import { vi } from "vitest";

describe("subscription closure public projections", () => {
  describe("proposal refresh after a positive customer pricing bill", () => {
    function facts() {
      return {
        closureCase: {
          status: "PENDING_SETTLEMENT",
          currentSettlementRevision: {
            id: "proposal-1",
            stage: "PROPOSED",
            billInputSnapshot: { bills: [] as Array<{ id: string }> }
          }
        },
        governed: {
          deltaRevisions: [{ id: "delta-1", items: [] }],
          chargeLines: [
            {
              settlementRevisionId: "proposal-1",
              status: "FINAL",
              responsibility: "CUSTOMER",
              amountCents: "200",
              billId: "bill-1" as string | null
            }
          ],
          receivableBills: [
            { id: "bill-1", billStatus: "PENDING", amount: "200", remainingAmount: "200" }
          ]
        }
      };
    }

    it("offers the existing propose action only for an uncaptured live final customer bill", () => {
      const { closureCase, governed } = facts();
      expect(governedAllowedActions(closureCase, governed)).toContain("PROPOSE_SETTLEMENT");
      closureCase.currentSettlementRevision.billInputSnapshot.bills.push({ id: "bill-1" });
      expect(governedAllowedActions(closureCase, governed)).not.toContain("PROPOSE_SETTLEMENT");
    });

    it.each([
      ["zero", { amountCents: "0" }],
      ["negative", { amountCents: "-1" }],
      ["invalid amount", { amountCents: "invalid" }],
      ["platform", { responsibility: "PLATFORM" }],
      ["preview", { status: "PREVIEW" }],
      ["exception", { status: "PRICING_EXCEPTION" }],
      ["other revision", { settlementRevisionId: "proposal-old" }],
      ["no bill", { billId: null }],
      ["absent bill", { billId: "bill-other" }]
    ])("does not refresh for %s", (_label, change) => {
      const { closureCase, governed } = facts();
      Object.assign(governed.chargeLines[0]!, change);
      expect(governedAllowedActions(closureCase, governed)).not.toContain("PROPOSE_SETTLEMENT");
    });

    it.each(["RETURN_INSPECTION", "RECONDITIONING", "SETTLED", "COMPLETED"])(
      "does not refresh the proposal in %s",
      (status) => {
        const { closureCase, governed } = facts();
        closureCase.status = status;
        expect(governedAllowedActions(closureCase, governed)).not.toContain("PROPOSE_SETTLEMENT");
      }
    );

    it.each(["CANCELLED", "missing bill", "missing delta", "FINALIZED", "SETTLED"])(
      "does not refresh when %s",
      (condition) => {
        const { closureCase, governed } = facts();
        if (condition === "CANCELLED") governed.receivableBills[0]!.billStatus = "CANCELLED";
        if (condition === "missing bill") governed.receivableBills = [];
        if (condition === "missing delta") governed.deltaRevisions = [];
        if (["FINALIZED", "SETTLED"].includes(condition))
          closureCase.currentSettlementRevision.stage = condition;
        expect(governedAllowedActions(closureCase, governed)).not.toContain("PROPOSE_SETTLEMENT");
      }
    );

    it("preserves initial proposals and the existing accepted-dispute successor route", () => {
      const { closureCase, governed } = facts();
      expect(
        governedAllowedActions({ ...closureCase, currentSettlementRevision: null }, governed)
      ).toContain("PROPOSE_SETTLEMENT");
      closureCase.currentSettlementRevision.stage = "FINALIZED";
      expect(
        governedAllowedActions(closureCase, {
          ...governed,
          disputes: [{ status: "ACCEPTED_BY_PLATFORM" }]
        })
      ).toContain("PROPOSE_SETTLEMENT");
    });

    it.each([null, {}, { bills: "malformed" }])(
      "does not treat a malformed snapshot %j as proof the bill was captured",
      (billInputSnapshot) => {
        const { closureCase, governed } = facts();
        expect(
          governedAllowedActions(
            {
              ...closureCase,
              currentSettlementRevision: {
                ...closureCase.currentSettlementRevision,
                billInputSnapshot
              }
            },
            governed
          )
        ).toContain("PROPOSE_SETTLEMENT");
      }
    );

    it("compares positive cent amounts without floating point conversion", () => {
      const { closureCase, governed } = facts();
      governed.chargeLines[0]!.amountCents = "900719925474099312345";
      expect(governedAllowedActions(closureCase, governed)).toContain("PROPOSE_SETTLEMENT");
    });
  });

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
      allowedActions: ["ACCEPT_SETTLEMENT", "DISPUTE_CHARGE_LINES"],
      caseNo: "SC-1",
      chargeLines: [],
      checklist: null,
      closureCaseId: "case-1",
      closureType: "NORMAL_COMPLETION",
      contractChargeClauses: [],
      customerResponse: null,
      delta: null,
      disputes: [],
      effectiveAt: "2026-08-24T00:00:00.000Z",
      evidenceReferences: [{ evidenceType: "PHOTO", fileId: "evidence-file-1", id: "evidence-1" }],
      finalDisposition: "COMPLETE",
      nextAction: "请确认最终退车结算方案或逐项提出争议",
      payableBillIds: [],
      physicalControlMode: "VOLUNTARY_RETURN",
      returnAppointment: { location: "Depot", scheduledAt: "2026-08-25T00:00:00.000Z" },
      returnManifestSigning: null,
      returnThreeStageEnabled: false,
      settlement: {
        amountDueCents: "0",
        amountRefundableCents: "500",
        resultHash: "hash",
        stage: "FINALIZED"
      },
      signedReferences: [{ documentType: "RETURN_MANIFEST", fileId: "file-1", stage: "ARCHIVED" }],
      status: "PENDING_SETTLEMENT"
    });
    expect(JSON.stringify(customer)).not.toContain("private-source");
  });

  it.each([
    ["normal expiry", "NORMAL_COMPLETION", "COMPLETED", "COMPLETE", "流程已结束"],
    ["D+7 recovery", "NORMAL_COMPLETION", "RETURN_INSPECTION", "TERMINATE", "车辆检查处理中"],
    ["early termination", "EARLY_TERMINATION", "TERMINATED", "TERMINATE", "流程已结束"]
  ])(
    "projects the %s acceptance journey for admin and customer consumers",
    (_name, closureType, status, finalDisposition, nextAction) => {
      const aggregate = {
        approvals:
          status === "RETURN_INSPECTION"
            ? [
                {
                  approvalComment: "private",
                  approvalType: "RECOVERY_EXECUTION_APPROVAL",
                  id: "approval",
                  status: "APPROVED"
                }
              ]
            : [],
        audits: [{ action: "UPDATE", entityType: "subscription_closure_case", id: "audit" }],
        closureCase: {
          caseNo: `SC-${closureType}`,
          closureType,
          finalDisposition,
          physicalControlMode: status === "RETURN_INSPECTION" ? "RECOVERY" : "VOLUNTARY_RETURN",
          status
        },
        currentDocuments: [
          { documentType: "RETURN_MANIFEST", signedFileId: "signed-file", stage: "ARCHIVED" }
        ],
        events: [{ eventType: "ACCEPTANCE", id: "event" }],
        settlementRevisions:
          status === "RETURN_INSPECTION"
            ? []
            : [{ amountDueCents: 0n, amountRefundableCents: 500n, stage: "SETTLED" }],
        vehicleReturn: {
          returnLocation: "Depot",
          scheduledAt: new Date("2026-08-25T00:00:00.000Z")
        },
        workOrders: [
          {
            evidence: [{ evidenceType: "INSPECTION_REPORT", fileId: "evidence", id: "evidence-1" }]
          }
        ]
      };

      expect(projectSubscriptionClosureAdmin(aggregate)).toMatchObject({
        closureCase: { closureType, finalDisposition, status },
        events: [{ eventType: "ACCEPTANCE" }]
      });
      expect(projectSubscriptionClosureCustomer(aggregate)).toMatchObject({
        closureType,
        finalDisposition,
        nextAction,
        signedReferences: [
          { documentType: "RETURN_MANIFEST", fileId: "signed-file", stage: "ARCHIVED" }
        ],
        status
      });
      expect(JSON.stringify(projectSubscriptionClosureCustomer(aggregate))).not.toContain(
        "private"
      );
    }
  );

  it("keeps portal charge lines bound to the proposed pricing revision after settlement", () => {
    const customer = projectSubscriptionClosureCustomer({
      chargeLines: [{ id: "line-1", settlementRevisionId: "proposal-1", status: "FINAL" }],
      closureCase: {
        caseNo: "SC-SETTLED",
        closureType: "NORMAL_COMPLETION",
        id: "case-settled",
        status: "PENDING_SETTLEMENT"
      },
      settlementRevisions: [
        { id: "proposal-1", stage: "PROPOSED", supersedesRevisionId: null },
        { id: "final-1", stage: "FINALIZED", supersedesRevisionId: "proposal-1" },
        { id: "settled-1", stage: "SETTLED", supersedesRevisionId: "final-1" }
      ]
    });

    expect(customer).toMatchObject({
      chargeLines: [{ id: "line-1", settlementRevisionId: "proposal-1", status: "FINAL" }],
      settlement: {
        id: "settled-1",
        pricingSettlementRevisionId: "proposal-1",
        stage: "SETTLED"
      }
    });
  });

  it("never exposes an unpublished successor settlement or its charge lines to the portal", () => {
    const customer = projectSubscriptionClosureCustomer({
      chargeLines: [
        { id: "published-line", settlementRevisionId: "proposal-1", status: "FINAL" },
        { id: "draft-line", settlementRevisionId: "proposal-2", status: "FINAL" }
      ],
      closureCase: {
        caseNo: "SC-DRAFT-ISOLATION",
        closureType: "NORMAL_COMPLETION",
        id: "case-draft-isolation",
        status: "PENDING_SETTLEMENT"
      },
      deltaRevisions: [{ id: "draft-delta", items: [], revisionNumber: 2 }],
      settlementRevisions: [
        { id: "proposal-1", stage: "PROPOSED", supersedesRevisionId: null },
        {
          amountDueCents: 5000n,
          amountRefundableCents: 0n,
          id: "final-1",
          resultHash: "published-hash",
          stage: "FINALIZED",
          supersedesRevisionId: "proposal-1"
        },
        { id: "proposal-2", stage: "PROPOSED", supersedesRevisionId: "final-1" }
      ]
    });

    expect(customer).toMatchObject({
      chargeLines: [{ id: "published-line" }],
      delta: null,
      settlement: {
        id: "final-1",
        pricingSettlementRevisionId: "proposal-1",
        resultHash: "published-hash",
        stage: "FINALIZED"
      }
    });
    expect(JSON.stringify(customer)).not.toContain("proposal-2");
    expect(JSON.stringify(customer)).not.toContain("draft-line");
    expect(JSON.stringify(customer)).not.toContain("draft-delta");
  });

  it("keeps self-service payment available for historical payable bills when closure amount due is zero", () => {
    const customer = projectSubscriptionClosureCustomer({
      closureCase: {
        caseNo: "SC-HISTORICAL-BILL",
        closureType: "NORMAL_COMPLETION",
        financialStatus: "COLLECTION_PENDING",
        id: "case-historical-bill",
        status: "PENDING_SETTLEMENT"
      },
      customerResponses: [
        {
          id: "response-1",
          settlementRevisionId: "final-1",
          status: "ACCEPTED"
        }
      ],
      receivableBills: [
        {
          billStatus: "OVERDUE",
          id: "historical-bill-1",
          remainingAmount: 3600n
        }
      ],
      settlementRevisions: [
        {
          amountDueCents: 0n,
          amountRefundableCents: 0n,
          id: "final-1",
          stage: "FINALIZED"
        }
      ]
    });

    expect(customer).toMatchObject({
      allowedActions: ["PAY_UNDISPUTED_BILLS"],
      nextAction: "请支付待结算账单",
      payableBillIds: ["historical-bill-1"]
    });
  });

  it("restores the payment helper after every customer dispute is rejected", () => {
    const customer = projectSubscriptionClosureCustomer({
      chargeLines: [
        {
          billId: "bill-1",
          id: "line-1",
          settlementRevisionId: "proposal-1",
          status: "FINAL"
        }
      ],
      closureCase: {
        caseNo: "SC-REJECTED-DISPUTE",
        closureType: "NORMAL_COMPLETION",
        financialStatus: "DISPUTED",
        id: "case-rejected-dispute",
        status: "PENDING_SETTLEMENT"
      },
      customerResponses: [
        { id: "response-1", settlementRevisionId: "final-1", status: "DISPUTED" }
      ],
      disputes: [
        {
          chargeLineId: "line-1",
          customerResponseId: "response-1",
          id: "dispute-1",
          status: "REJECTED_BY_PLATFORM"
        }
      ],
      receivableBills: [{ billStatus: "PENDING", id: "bill-1", remainingAmount: 1000n }],
      settlementRevisions: [
        { id: "proposal-1", stage: "PROPOSED" },
        {
          id: "final-1",
          resultHash: "hash-1",
          stage: "FINALIZED",
          supersedesRevisionId: "proposal-1"
        }
      ]
    });
    expect(customer).toMatchObject({
      allowedActions: ["PAY_UNDISPUTED_BILLS"],
      nextAction: "争议已处理，请支付仍有效账单",
      payableBillIds: ["bill-1"]
    });
  });

  it("does not advertise financial settlement or operational completion for unpaid bills", () => {
    const closureCase = {
      currentSettlementRevision: {
        id: "final-1",
        resultHash: "hash-1",
        stage: "FINALIZED"
      },
      physicalControlledAt: new Date(),
      settlementRevisions: [],
      status: "PENDING_SETTLEMENT",
      vehicle: { status: "AVAILABLE" },
      returnAssetWorkOrder: { restrictions: [] }
    };
    const governed = {
      checklistRevisions: [{ id: "checklist-1" }],
      customerResponses: [
        {
          id: "response-1",
          settlementHash: "hash-1",
          settlementRevisionId: "final-1",
          status: "ACCEPTED"
        }
      ],
      deltaRevisions: [{ id: "delta-1", items: [] }],
      disputes: [],
      evidencePackages: [],
      legalCases: [],
      receivableBills: [{ id: "bill-1", remainingAmount: 1000n }],
      receivableDispositions: []
    };
    const actions = governedAllowedActions(closureCase, governed);
    expect(actions).toContain("RECORD_RECEIVABLE_DISPOSITION");
    expect(actions).toContain("EXPORT_EVIDENCE_PACKAGE");
    expect(actions).not.toContain("SETTLE_FINANCIAL");
    expect(actions).not.toContain("COMPLETE_OPERATIONS");
  });

  it.each([
    ["the exact true flag for a new case", { configValue: "true" }],
    [
      "a legacy checklist revision while the flag is false",
      {
        configValue: "false",
        currentChecklistRevisionId: "checklist-1"
      }
    ],
    [
      "a legal collection case while the flag is false",
      {
        configValue: "false",
        legalCases: [{ id: "legal-case-1" }]
      }
    ],
    [
      "a return-manifest e-sign task while the flag is false",
      {
        configValue: "false",
        returnManifestTask: { id: "return-manifest-task-1" }
      }
    ]
  ])("projects the three-stage UI for %s", async (_name, fixture) => {
    const projection = projectionFixture(fixture);

    await expect(projection.getAdminById("closure-1")).resolves.toMatchObject({
      returnThreeStageEnabled: true
    });
  });

  it("does not project three-stage UI for a new case while the flag is false", async () => {
    const projection = projectionFixture({ configValue: "false" });

    await expect(projection.getAdminById("closure-1")).resolves.toMatchObject({
      returnThreeStageEnabled: false
    });
  });

  it("continues the portal three-stage UI for internal-only governed evidence without exposing it", async () => {
    const projection = projectionFixture({
      configValue: "false",
      evidenceLinks: [
        {
          id: "internal-evidence-link-1",
          internalMarker: "must-not-reach-customer",
          visibility: "INTERNAL_ONLY"
        }
      ]
    });

    const customer = await projection.getCustomerByOrder("order-1", "customer-1");

    expect(customer).toMatchObject({
      evidenceLinks: [],
      returnThreeStageEnabled: true
    });
    expect(JSON.stringify(customer)).not.toContain("must-not-reach-customer");
  });
});

function projectionFixture(input: {
  configValue: string;
  currentChecklistRevisionId?: string;
  evidenceLinks?: readonly Record<string, unknown>[];
  legalCases?: readonly Record<string, unknown>[];
  returnManifestTask?: Record<string, unknown>;
}) {
  const findMany = vi.fn().mockResolvedValue([]);
  const prisma = {
    auditLog: { findMany },
    businessExceptionApproval: { count: vi.fn().mockResolvedValue(0), findMany },
    contractChargeClauseSnapshot: { findMany },
    contractESignTask: { findFirst: vi.fn().mockResolvedValue(input.returnManifestTask ?? null) },
    receivableBill: { findMany },
    subscriptionClosureCase: {
      findFirst: vi.fn().mockResolvedValue({
        commandReceipts: [],
        contractId: "contract-1",
        currentChecklistRevisionId: input.currentChecklistRevisionId ?? null,
        currentDeltaRevisionId: null,
        customerId: "customer-1",
        currentSettlementRevision: null,
        documentRevisions: [],
        events: [],
        id: "closure-1",
        orderId: "order-1",
        settlementRevisions: [],
        vehicleReturn: null
      }),
      findUnique: vi.fn().mockResolvedValue({
        commandReceipts: [],
        contractId: "contract-1",
        currentChecklistRevisionId: input.currentChecklistRevisionId ?? null,
        currentDeltaRevisionId: null,
        currentSettlementRevision: null,
        documentRevisions: [],
        events: [],
        id: "closure-1",
        orderId: "order-1",
        settlementRevisions: [],
        vehicleReturn: null
      })
    },
    subscriptionClosureChargeDispute: { findMany },
    subscriptionClosureChargeLine: { findMany },
    subscriptionClosureCustomerResponse: { findMany },
    subscriptionClosureEvidencePackageExport: { findMany },
    subscriptionClosureLegalCollectionCase: {
      findMany: vi.fn().mockResolvedValue(input.legalCases ?? [])
    },
    subscriptionClosureReceivableDisposition: { findMany },
    vehicleConditionDeltaRevision: { findMany },
    vehicleReturnChecklistRevision: { findMany },
    vehicleReturnEvidenceLink: {
      count: vi.fn().mockResolvedValue(input.evidenceLinks?.length ?? 0),
      findMany: vi
        .fn()
        .mockImplementation(({ where }) =>
          Promise.resolve(
            (input.evidenceLinks ?? []).filter(
              (link) => where.visibility === undefined || link.visibility === where.visibility
            )
          )
        )
    }
  };
  return new SubscriptionClosureProjectionService(
    prisma as never,
    { get: vi.fn().mockReturnValue(input.configValue) } as never
  );
}
