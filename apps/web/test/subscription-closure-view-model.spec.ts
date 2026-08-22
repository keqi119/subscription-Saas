import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildAdminSubscriptionClosureView,
  buildCustomerSubscriptionClosureView
} from "../src/lib/subscription-closure-view-model";

describe("subscription closure view model", () => {
  it("builds the complete admin workspace without exposing raw envelopes", () => {
    const view = buildAdminSubscriptionClosureView(
      {
        approvals: [
          { exceptionType: "RECOVERY_EXECUTION_APPROVAL", id: "approval-1", status: "APPROVED" }
        ],
        audits: [
          {
            action: "UPDATE",
            createdAt: "2026-08-23T01:00:00.000Z",
            entityType: "subscription_closure_case",
            id: "audit-1"
          }
        ],
        closureCase: {
          caseNo: "SC-1",
          closureType: "RECOVERY",
          finalDisposition: "TERMINATE",
          physicalControlMode: "RECOVERY",
          status: "RECOVERY_APPROVED"
        },
        events: [
          { eventType: "RECOVERY_APPROVED", id: "event-1", occurredAt: "2026-08-23T00:00:00.000Z" }
        ],
        settlementRevisions: [
          {
            amountDueCents: "1200",
            amountRefundableCents: "0",
            id: "settlement-1",
            revisionNumber: 1,
            stage: "FINALIZED"
          }
        ],
        workOrders: [
          {
            id: "work-order-1",
            restrictions: [
              { id: "restriction-1", restrictionType: "RECOVERY_IN_PROGRESS", status: "ACTIVE" }
            ],
            status: "IN_PROGRESS",
            workOrderNo: "AWO-1",
            workOrderType: "RECOVERY"
          }
        ]
      },
      new Set(["subscription_recovery:execute"])
    );

    expect(view).toMatchObject({
      caseNo: "SC-1",
      closureType: "RECOVERY",
      status: "RECOVERY_APPROVED",
      workOrders: [{ id: "work-order-1", type: "RECOVERY" }],
      restrictions: [{ id: "restriction-1", type: "RECOVERY_IN_PROGRESS" }],
      settlementRevisions: [{ amountDueCents: "1200", stage: "FINALIZED" }],
      allowedActions: [{ key: "EXECUTE_RECOVERY" }]
    });
    expect(view.timeline).toHaveLength(1);
    expect(view.auditLinks).toHaveLength(1);
  });

  it("keeps the portal projection deliberately small and formats money as cents", () => {
    const view = buildCustomerSubscriptionClosureView({
      caseNo: "SC-2",
      closureType: "EARLY_TERMINATION",
      evidenceReferences: [
        { evidenceType: "INSPECTION_REPORT", fileId: "evidence-file", id: "evidence-1" }
      ],
      nextAction: "等待最终结算",
      returnAppointment: { location: "Depot", scheduledAt: "2026-08-24T02:00:00.000Z" },
      settlement: { amountDueCents: "2500", amountRefundableCents: "0", stage: "FINALIZED" },
      signedReferences: [
        { documentType: "RETURN_MANIFEST", fileId: "signed-file", stage: "ARCHIVED" }
      ],
      status: "PENDING_SETTLEMENT"
    });

    expect(view).toEqual({
      caseNo: "SC-2",
      closureType: "EARLY_TERMINATION",
      evidenceReferences: [
        { evidenceType: "INSPECTION_REPORT", fileId: "evidence-file", id: "evidence-1" }
      ],
      nextAction: "等待最终结算",
      returnAppointment: { location: "Depot", scheduledAt: "2026-08-24T02:00:00.000Z" },
      settlement: { amountDueCents: "2500", amountRefundableCents: "0", stage: "FINALIZED" },
      signedReferences: [
        { documentType: "RETURN_MANIFEST", fileId: "signed-file", stage: "ARCHIVED" }
      ],
      status: "PENDING_SETTLEMENT"
    });
  });

  it("fails closed on malformed projections", () => {
    expect(() =>
      buildAdminSubscriptionClosureView({ closureCase: { status: 7 } }, new Set())
    ).toThrow("Invalid subscription closure projection");
    expect(() => buildCustomerSubscriptionClosureView({ status: 7 })).toThrow(
      "Invalid subscription closure projection"
    );
  });

  it("does not advertise recovery assessment while a case is durably paused", () => {
    const view = buildAdminSubscriptionClosureView(
      {
        closureCase: {
          caseNo: "SC-PAUSED",
          closureType: "RECOVERY",
          finalDisposition: "TERMINATE",
          physicalControlMode: "RECOVERY",
          status: "PAUSED"
        }
      },
      new Set(["subscription_recovery:assess"])
    );

    expect(view.allowedActions).toEqual([]);
  });

  it("wires the complete admin surface and the deliberately smaller portal surface", () => {
    const repoRoot = join(__dirname, "../../..");
    const admin = readFileSync(join(repoRoot, "apps/web/src/app/orders/[id]/page.tsx"), "utf8");
    const portal = readFileSync(
      join(repoRoot, "apps/web/src/app/portal/orders/[id]/page.tsx"),
      "utf8"
    );

    for (const label of [
      "退车 / 追回 / 整备工单",
      "车辆限制",
      "结算修订",
      "审批",
      "审计链接",
      "允许操作"
    ]) {
      expect(admin).toContain(label);
    }
    for (const label of ["退车与结算进度", "退车预约", "结算结果", "已签文件", "检查凭证"]) {
      expect(portal).toContain(label);
    }
    expect(portal).not.toContain("approvalComment");
    expect(portal).not.toContain("commandEnvelope");
    expect(portal).not.toContain("providerPayload");
  });
});
