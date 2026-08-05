import { describe, expect, it } from "vitest";

const subjectPath = "../src/lib/" + "portal-renewal-view-model";

type Subject = {
  getPortalRenewalNextAction: (input: Record<string, unknown>) => {
    helper: string;
    href?: string;
    step: string;
    title: string;
  };
};

async function loadSubject() {
  const subject = await import(subjectPath).catch(() => ({}));
  expect(subject).toHaveProperty("getPortalRenewalNextAction");
  return subject as Subject;
}

function renewal(input: Record<string, unknown> = {}) {
  return {
    change: null,
    changeOrderId: null,
    completionDeadlineAt: "2026-09-02T16:00:00.000Z",
    considerationStartAt: "2026-08-03T01:00:00.000Z",
    decision: null,
    decidedAt: null,
    id: "renewal-1",
    nextAction: "DECIDE",
    order: { id: "order-1", orderNo: "ORD001", plateMasked: "沪A***45" },
    reminders: [],
    segment: {
      endDate: "2026-09-02",
      id: "segment-1",
      monthlyFeeAmount: "100000",
      sequenceNo: 1,
      startDate: "2026-03-03",
      status: "ACTIVE"
    },
    status: "PENDING_DECISION",
    version: 0,
    ...input
  };
}

function change(input: Record<string, unknown> = {}) {
  return {
    cancelReason: null,
    completionDeadlineAt: "2026-09-02T16:00:00.000Z",
    confirmedQuoteId: null,
    contractId: null,
    currentQuote: null,
    extensionMonths: 6,
    id: "change-1",
    orderId: "order-1",
    orderNo: "ORD001",
    pricingMode: "CURRENT_VERSION",
    quotes: [],
    sourceSegment: renewal().segment,
    status: "DRAFT",
    targetEndDate: "2027-03-02",
    targetSegment: null,
    targetStartDate: "2026-09-03",
    version: 0,
    ...input
  };
}

describe("portal renewal view model", () => {
  it.each([
    [renewal(), { href: "/portal/renewals/renewal-1", step: "DECIDE" }],
    [
      renewal({ decision: "RENEW", status: "RENEWAL_REQUESTED" }),
      { href: "/portal/renewals/renewal-1", step: "WAIT_QUOTE" }
    ],
    [
      renewal({
        change: change({
          currentQuote: {
            id: "quote-2",
            monthlyFeeAmount: "98000",
            quoteNo: "SCQ002",
            revision: 2,
            status: "FORMAL",
            validUntil: "2026-08-08T00:00:00.000Z"
          },
          status: "QUOTED"
        }),
        changeOrderId: "change-1",
        decision: "RENEW",
        status: "EXTENSION_IN_PROGRESS"
      }),
      { href: "/portal/subscription-changes/change-1", step: "CONFIRM_QUOTE" }
    ],
    [
      renewal({
        change: change({ contractId: "contract-1", status: "SIGNING_OR_PAYMENT" }),
        changeOrderId: "change-1",
        decision: "RENEW"
      }),
      { href: "/portal/contracts/contract-1", step: "SIGN" }
    ],
    [
      renewal({
        change: change({ contractId: "contract-1", status: "SCHEDULED" }),
        changeOrderId: "change-1",
        decision: "RENEW"
      }),
      { step: "WAIT_ARCHIVE" }
    ],
    [
      renewal({
        change: change({ status: "COMPLETED" }),
        changeOrderId: "change-1",
        decision: "RENEW",
        status: "EXTENDED"
      }),
      { step: "EXTENDED" }
    ],
    [renewal({ decision: "EXPIRE", status: "EXPIRY_CONFIRMED" }), { step: "RETURN" }],
    [renewal({ status: "EXPIRED" }), { step: "RETURN" }]
  ])("maps the continuous renewal journey to one customer action", async (input, expected) => {
    const subject = await loadSubject();
    expect(subject.getPortalRenewalNextAction(input)).toMatchObject(expected);
  });

  it("shows the exact quote revision in the confirmation guidance", async () => {
    const subject = await loadSubject();
    const action = subject.getPortalRenewalNextAction(
      renewal({
        change: change({
          currentQuote: {
            id: "quote-3",
            monthlyFeeAmount: "96000",
            quoteNo: "SCQ003",
            revision: 3,
            status: "FORMAL",
            validUntil: "2026-08-08T00:00:00.000Z"
          },
          status: "QUOTED"
        }),
        decision: "RENEW"
      })
    );

    expect(action.helper).toContain("revision 3");
  });

  it("keeps a rejected quote reason visible while waiting for a replacement", async () => {
    const subject = await loadSubject();
    const action = subject.getPortalRenewalNextAction(
      renewal({
        change: change({
          cancelReason: "CUSTOMER_QUOTE_REJECTED: 月租超出预算",
          status: "CANCELLED"
        }),
        decision: "RENEW"
      })
    );

    expect(action).toMatchObject({ step: "WAIT_QUOTE" });
    expect(action.helper).toContain("月租超出预算");
  });
});
