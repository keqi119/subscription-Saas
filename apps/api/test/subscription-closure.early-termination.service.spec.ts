import { ESignDocumentType, ESignSigningStage } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { SubscriptionClosureService } from "../src/subscription-closure/subscription-closure.service";

const IDS = {
  actor: "70000000-0000-4000-8000-000000000001",
  order: "70000000-0000-4000-8000-000000000002"
} as const;

describe("SubscriptionClosureService early-termination command boundary", () => {
  it("exposes dedicated early-termination and recovery e-sign semantic carriers", () => {
    expect(ESignDocumentType).toMatchObject({
      EARLY_TERMINATION_AGREEMENT: "EARLY_TERMINATION_AGREEMENT",
      RECOVERY_AUTHORITY: "RECOVERY_AUTHORITY"
    });
    expect(ESignSigningStage).toMatchObject({
      STAGE4_EARLY_TERMINATION: "STAGE4_EARLY_TERMINATION",
      STAGE5_RECOVERY_AUTHORITY: "STAGE5_RECOVERY_AUTHORITY"
    });
  });

  it("rejects client authority, hash, and document payloads before opening a transaction", async () => {
    const transaction = vi.fn();
    const service = new SubscriptionClosureService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { $transaction: transaction } as never
    );

    await expect(
      service.initiateEarlyTermination({
        actorId: IDS.actor,
        authoritySnapshot: { forged: true },
        documentHash: "forged",
        effectiveAt: new Date("2026-08-25T00:00:00.000Z"),
        evidence: [{ reference: "customer-request-42", type: "CUSTOMER_REQUEST" }],
        idempotencyKey: "early-init-1",
        orderId: IDS.order,
        reason: "Customer requested an early return",
        rawDocument: { forged: true }
      } as never)
    ).rejects.toMatchObject({
      response: { code: "SUBSCRIPTION_CLOSURE_EARLY_TERMINATION_CLIENT_AUTHORITY_FORBIDDEN" }
    });
    expect(transaction).not.toHaveBeenCalled();
  });
});
