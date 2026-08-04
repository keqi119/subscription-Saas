import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException
} from "@nestjs/common";
import { PaymentMandateStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { MockAutoDebitProvider } from "../src/auto-debit/mock-auto-debit.provider";
import { PaymentMandateService } from "../src/auto-debit/payment-mandate.service";
import { CurrentCustomer } from "../src/portal/portal-auth.types";

describe("PaymentMandateService", () => {
  it("creates and activates one mandate for the customer's active order", async () => {
    const harness = createHarness();

    const result = await harness.service.createPortalMandate(
      "order-1",
      currentCustomer,
      { ipAddress: "127.0.0.1" }
    );

    expect(result).toMatchObject({
      id: "mandate-1",
      orderId: "order-1",
      provider: "MOCK",
      providerMode: "mock",
      status: PaymentMandateStatus.ACTIVE
    });
    expect(result.providerReference).toMatch(/^\*+/);
    expect(result).not.toHaveProperty("providerMandateId");
    expect(result).not.toHaveProperty("responseSnapshot");
    expect(harness.prisma.paymentMandate.create).toHaveBeenCalledTimes(1);
    expect(harness.prisma.paymentMandate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PaymentMandateStatus.ACTIVE
        }),
        where: { id: "mandate-1" }
      })
    );
    expect(harness.audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "UPDATE",
        entityId: "mandate-1",
        entityType: "payment_mandate",
        module: "auto_debit",
        operatorId: "account-1"
      })
    );
    expect(harness.scheduler.enqueueFutureForBill).toHaveBeenCalledWith(
      harness.prisma,
      expect.objectContaining({ id: "bill-1", orderId: "order-1" }),
      expect.any(Date)
    );
  });

  it("does not let a customer create a mandate for another customer's order", async () => {
    const harness = createHarness();
    harness.prisma.subscriptionOrder.findFirst.mockResolvedValueOnce(null);

    await expect(
      harness.service.createPortalMandate(
        "other-order",
        currentCustomer,
        {}
      )
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(harness.provider.createMandate).not.toHaveBeenCalled();
  });

  it("does not mark a provider-active mandate failed when audit persistence fails", async () => {
    const harness = createHarness();
    harness.audit.write
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("audit unavailable"));

    await expect(
      harness.service.createPortalMandate("order-1", currentCustomer, {})
    ).rejects.toThrow("audit unavailable");

    expect(harness.prisma.paymentMandate.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PaymentMandateStatus.FAILED
        })
      })
    );
  });

  it("rejects a second open mandate before calling the provider", async () => {
    const harness = createHarness();
    harness.prisma.paymentMandate.findFirst.mockResolvedValueOnce({
      id: "existing-mandate"
    });

    await expect(
      harness.service.createPortalMandate("order-1", currentCustomer, {})
    ).rejects.toBeInstanceOf(ConflictException);
    expect(harness.provider.createMandate).not.toHaveBeenCalled();
  });

  it("never reactivates a terminal mandate during admin sync", async () => {
    const harness = createHarness({ status: PaymentMandateStatus.REVOKED });

    await expect(
      harness.service.syncAdminMandate(
        "mandate-1",
        { reason: "人工核对授权" },
        adminUser,
        {}
      )
    ).rejects.toBeInstanceOf(ConflictException);
    expect(harness.provider.queryMandate).not.toHaveBeenCalled();
  });

  it("includes the operator reason when an admin synchronizes a mandate", async () => {
    const harness = createHarness({ status: PaymentMandateStatus.ACTIVE });

    await harness.service.syncAdminMandate(
      "mandate-1",
      { reason: "客户反馈授权已恢复" },
      adminUser,
      {}
    );

    expect(harness.audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        after: expect.objectContaining({ reason: "客户反馈授权已恢复" }),
        operatorId: adminUser.id
      })
    );
  });

  it("does not reactivate a mandate revoked while provider sync was in flight", async () => {
    const harness = createHarness({ status: PaymentMandateStatus.ACTIVE });
    const revoked = {
      ...await harness.prisma.paymentMandate.findUnique({ where: { id: "mandate-1" } }),
      revokedAt: new Date("2026-08-04T01:00:00.000Z"),
      status: PaymentMandateStatus.REVOKED
    };
    harness.prisma.paymentMandate.findUnique
      .mockResolvedValueOnce({ ...revoked, status: PaymentMandateStatus.ACTIVE })
      .mockResolvedValueOnce(revoked);

    await expect(
      harness.service.syncAdminMandate(
        "mandate-1",
        { reason: "并发状态核对" },
        adminUser,
        {}
      )
    ).resolves.toMatchObject({ status: PaymentMandateStatus.REVOKED });

    expect(harness.prisma.paymentMandate.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: PaymentMandateStatus.ACTIVE })
      })
    );
  });

  it("revokes without deleting mandate history", async () => {
    const harness = createHarness({ status: PaymentMandateStatus.ACTIVE });

    await expect(
      harness.service.revokePortalMandate(
        "mandate-1",
        currentCustomer,
        {}
      )
    ).resolves.toMatchObject({ status: PaymentMandateStatus.REVOKED });

    expect("delete" in harness.prisma.paymentMandate).toBe(false);
    expect(harness.prisma.paymentMandate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PaymentMandateStatus.REVOKED
        }),
        where: { id: "mandate-1" }
      })
    );
  });

  it("persists revoke intent and an unknown result when the provider call fails", async () => {
    const harness = createHarness({ status: PaymentMandateStatus.ACTIVE });
    harness.provider.revokeMandate.mockRejectedValueOnce(
      new Error("provider timeout")
    );

    await expect(
      harness.service.revokeAdminMandate(
        "mandate-1",
        { reason: "客户要求解约" },
        adminUser,
        {}
      )
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    const stored = await harness.prisma.paymentMandate.findUnique({
      where: { id: "mandate-1" }
    });
    expect(stored?.requestSnapshot).toMatchObject({
      revokeRequestedBy: adminUser.id
    });
    expect(stored?.errorSnapshot).toMatchObject({
      code: "MANDATE_REVOKE_RESULT_UNKNOWN"
    });
    expect(harness.audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        after: expect.objectContaining({ operation: "REVOKE_RESULT_UNKNOWN" })
      })
    );
  });
});

const currentCustomer: CurrentCustomer = {
  accountStatus: "ACTIVE",
  customerAccountId: "account-1",
  customerId: "customer-1",
  phone: "13800000000"
};

const adminUser = {
  id: "admin-1",
  menus: [],
  name: "管理员",
  permissions: [],
  roles: ["ADMIN"],
  username: "admin"
};

function createHarness(
  options: { status?: PaymentMandateStatus } = {}
) {
  const provider = new MockAutoDebitProvider();
  const providerSpies = {
    createMandate: vi.spyOn(provider, "createMandate"),
    queryMandate: vi.spyOn(provider, "queryMandate"),
    revokeMandate: vi.spyOn(provider, "revokeMandate")
  };
  let mandate = {
    callbackSnapshot: null,
    createdAt: new Date("2026-08-04T00:00:00.000Z"),
    createdBy: "customer-1",
    customerId: "customer-1",
    effectiveAt: new Date("2026-08-04T00:00:00.000Z"),
    errorSnapshot: null,
    expiresAt: null,
    id: "mandate-1",
    lastSyncedAt: new Date("2026-08-04T00:00:00.000Z"),
    mandateNo: "MDT20260804000000TEST",
    orderId: "order-1",
    provider: "MOCK",
    providerMandateId: "mock-mandate-existing",
    providerMode: "mock",
    providerTemplateId: "mock-template",
    requestSnapshot: {},
    responseSnapshot: {
      effectiveAt: "2026-08-04T00:00:00.000Z",
      kind: "mock-mandate",
      mandateNo: "MDT20260804000000TEST",
      providerMandateId: "mock-mandate-existing",
      signedAt: "2026-08-04T00:00:00.000Z",
      status: options.status ?? PaymentMandateStatus.ACTIVE
    },
    revokedAt: null as Date | null,
    signedAt: new Date("2026-08-04T00:00:00.000Z"),
    status: (options.status ?? PaymentMandateStatus.ACTIVE) as PaymentMandateStatus,
    suspendedAt: null,
    updatedAt: new Date("2026-08-04T00:00:00.000Z"),
    updatedBy: null
  };
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "mandate-1" }]),
    $transaction: vi.fn(async (operation: (client: unknown) => unknown) =>
      operation(prisma)
    ),
    debitAttempt: { findMany: vi.fn().mockResolvedValue([]) },
    paymentMandate: {
      create: vi.fn(async ({ data }) => {
        mandate = {
          ...mandate,
          ...data,
          id: "mandate-1",
          providerMandateId: null,
          responseSnapshot: null,
          status: PaymentMandateStatus.PENDING
        };
        return mandate;
      }),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(async (args?: unknown) => {
        void args;
        return mandate;
      }),
      update: vi.fn(async ({ data }) => {
        mandate = { ...mandate, ...data, updatedAt: new Date() };
        return mandate;
      }),
      updateMany: vi.fn(async ({ data, where }) => {
        if (where.status && typeof where.status === "string" && mandate.status !== where.status) {
          return { count: 0 };
        }
        if (where.status?.notIn?.includes(mandate.status)) {
          return { count: 0 };
        }
        mandate = { ...mandate, ...data, updatedAt: new Date() };
        return { count: 1 };
      })
    },
    receivableBill: {
      findMany: vi.fn().mockResolvedValue([
        {
          dueDate: new Date("2026-08-05T00:00:00.000Z"),
          id: "bill-1",
          orderId: "order-1"
        }
      ])
    },
    subscriptionOrder: {
      findFirst: vi.fn().mockResolvedValue({
        customerId: "customer-1",
        id: "order-1",
        orderNo: "ORD-1",
        orderStatus: "ACTIVE"
      })
    }
  };
  const audit = { write: vi.fn().mockResolvedValue(undefined) };
  const scheduler = { enqueueFutureForBill: vi.fn().mockResolvedValue([]) };
  const config = {
    enabled: true,
    environment: "staging",
    mockEnabled: true,
    provider: "mock" as const,
    runTime: "09:00",
    wechatTemplateId: "mock-template"
  };
  const service = new PaymentMandateService(
    prisma as never,
    provider,
    config,
    scheduler as never,
    audit as never
  );

  return {
    audit,
    prisma,
    provider: providerSpies,
    scheduler,
    service
  };
}
