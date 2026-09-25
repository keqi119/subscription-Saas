import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { SubscriptionReturnGovernanceService } from "../src/subscription-closure/subscription-return-governance.service";

describe("return checklist persistence and exact replay", () => {
  it.each(["CUSTOMER_SIGNED", "CUSTOMER_REFUSED", "CUSTOMER_ABSENT"] as const)(
    "persists the correct %s attestation and replays the same business items without writes",
    async (mode) => {
      const h = harness(mode);
      const first = await h.capture();
      expect(first.replayed).toBe(false);
      const data = h.create.mock.calls[0]![0].data;
      expect(data.attestationSnapshot).toEqual(
        mode === "CUSTOMER_SIGNED"
          ? Prisma.DbNull
          : {
              evidenceIds: ["proof-1"],
              reason: "Customer unavailable",
              witnesses: ["Witness"]
            }
      );
      const replay = await h.capture({ ...h.input, items: [...h.input.items].reverse() });
      expect(replay).toEqual({ ...first, replayed: true });
      expect(h.create).toHaveBeenCalledTimes(1);
      expect(h.caseUpdate).toHaveBeenCalledTimes(1);
      expect(h.returnUpdate).toHaveBeenCalledTimes(1);
      expect(h.jobUpsert).toHaveBeenCalledTimes(1);
      expect(h.jobUpdate).toHaveBeenCalledTimes(1);
    }
  );

  it("rejects a changed item under the same key without writing a new revision", async () => {
    const h = harness("CUSTOMER_SIGNED");
    await h.capture();
    await expect(
      h.capture({
        ...h.input,
        items: h.input.items.map((item) =>
          item.itemCode === "KEY" ? { ...item, returnedQuantity: 0 } : item
        )
      })
    ).rejects.toMatchObject({ response: { code: "RETURN_CHECKLIST_IDEMPOTENCY_CONFLICT" } });
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.jobUpsert).toHaveBeenCalledTimes(1);
  });
});

function harness(mode: "CUSTOMER_SIGNED" | "CUSTOMER_REFUSED" | "CUSTOMER_ABSENT") {
  const capturedAt = new Date("2026-09-25T00:00:00.000Z");
  const input = {
    attestationEvidenceIds: mode === "CUSTOMER_SIGNED" ? [] : ["proof-1"],
    attestationMode: mode,
    attestationReason: mode === "CUSTOMER_SIGNED" ? null : "Customer unavailable",
    capturedAt,
    customerComments: null,
    idempotencyKey: "checklist-1",
    items: [
      "ACCESSORIES",
      "BATTERY",
      "CHARGING_EQUIPMENT",
      "CUSTOMER_ITEMS",
      "KEY",
      "MILEAGE",
      "REGISTRATION_CERTIFICATE",
      "VEHICLE_EXTERIOR",
      "VEHICLE_INTERIOR"
    ].map((itemCode) => ({
      expectedQuantity: 1,
      itemCode,
      returnedQuantity: 1,
      state: "NORMAL" as const
    })),
    witnesses: mode === "CUSTOMER_SIGNED" ? [] : ["Witness"]
  };
  type Data = Prisma.VehicleReturnChecklistRevisionUncheckedCreateInput & {
    items: { create: Array<Record<string, unknown>> };
  };
  let revision: Record<string, unknown> | null = null;
  const create = vi.fn(async ({ data }: { data: Data }) => {
    revision = {
      ...data,
      id: "revision-1",
      createdAt: capturedAt,
      items: data.items.create.map((item, index) => ({
        ...item,
        createdAt: capturedAt,
        id: `item-${index}`,
        revisionId: "revision-1"
      }))
    };
    return revision;
  });
  const caseUpdate = vi.fn().mockResolvedValue({});
  const returnUpdate = vi.fn().mockResolvedValue({});
  const jobUpdate = vi.fn().mockResolvedValue({ count: 0 });
  const jobUpsert = vi.fn().mockResolvedValue({});
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    assetWorkOrderEvidence: {
      findMany: vi
        .fn()
        .mockResolvedValue(mode === "CUSTOMER_SIGNED" ? [] : [{ workOrderId: "work-1" }])
    },
    contractESignTask: { findFirst: vi.fn().mockResolvedValue(null) },
    subscriptionAutomationJob: { updateMany: jobUpdate, upsert: jobUpsert },
    subscriptionClosureCase: {
      findUnique: vi.fn().mockResolvedValue({
        id: "case-1",
        orderId: "order-1",
        status: "PREPARING_RETURN",
        vehicleReturnId: "return-1",
        returnAssetWorkOrderId: "work-1"
      }),
      update: caseUpdate
    },
    subscriptionClosureDocumentRevision: {
      findFirst: vi.fn().mockResolvedValue({ id: "document-1" })
    },
    vehicleReturn: { update: returnUpdate },
    vehicleReturnChecklistRevision: { create, findUnique: vi.fn(async () => revision) },
    vehicleReturnEvidenceLink: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          mode === "CUSTOMER_SIGNED"
            ? []
            : [{ id: "link-1", evidenceId: "proof-1", supersedesLinkId: null }]
        )
    }
  };
  const service = new SubscriptionReturnGovernanceService(
    { $transaction: (work: (client: typeof tx) => Promise<unknown>) => work(tx) } as never,
    {} as never,
    undefined,
    undefined,
    undefined,
    undefined,
    new ConfigService({ SUBSCRIPTION_RETURN_THREE_STAGE_ENABLED: "true" })
  );
  return {
    input,
    create,
    caseUpdate,
    returnUpdate,
    jobUpdate,
    jobUpsert,
    capture: (value = input) => service.captureChecklist("case-1", value, "actor-1")
  };
}
