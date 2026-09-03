import { ConfigService } from "@nestjs/config";
import {
  RenewalConsiderationStatus,
  RenewalDecision,
  SubscriptionChangePricingMode,
  SubscriptionChangeQuoteStatus,
  SubscriptionChangeStatus
} from "@prisma/client";
import { PermissionCode } from "@subscription-saas/shared";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit.service";
import { PortalRenewalService } from "../src/portal/portal-renewal.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { ContractSegmentService } from "../src/subscription-change/contract-segment.service";
import { SubscriptionChangeRepository } from "../src/subscription-change/subscription-change.repository";
import { SubscriptionExtensionPricingService } from "../src/subscription-change/subscription-extension-pricing.service";
import { SubscriptionExtensionService } from "../src/subscription-change/subscription-extension.service";
import { requiredReleaseDatabaseTestContext } from "./helpers/release-database-test-context";
import { insertRuntimeContract, insertRuntimeOrderGraph } from "./helpers/runtime-domain-fixture";

const TEST_DATABASE_URL = requiredReleaseDatabaseTestContext(
  "apps/api/test/subscription-extension.integration.spec.ts"
).databaseUrl;

describe("SubscriptionExtensionService PostgreSQL integration", () => {
  let prisma: PrismaService;
  let repository: SubscriptionChangeRepository;
  let segmentService: ContractSegmentService;
  let service: SubscriptionExtensionService;

  beforeAll(async () => {
    prisma = new PrismaService(new ConfigService({ DATABASE_URL: TEST_DATABASE_URL }));
    await prisma.onModuleInit();
    segmentService = new ContractSegmentService(prisma);
    repository = new SubscriptionChangeRepository(prisma);
    service = new SubscriptionExtensionService(
      prisma,
      new AuditService(prisma),
      segmentService,
      new SubscriptionExtensionPricingService(prisma),
      {
        enabled: true,
        now: () => new Date("2026-08-05T04:00:00.000Z"),
        quoteValidityHours: 72
      },
      repository
    );
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it("persists an ORIGINAL_PRICE extension, append-only quote and idempotent command result", async () => {
    const fixture = await createFixture(prisma);
    const approverId = randomUUID();
    await prisma.user.create({
      data: {
        id: approverId,
        name: "Integration Price Approver",
        passwordHash: "not-used-by-test",
        username: `extension-approver-${approverId}`
      }
    });
    const actor = {
      id: randomUUID(),
      menus: [],
      name: "Integration Operator",
      permissions: [
        PermissionCode.SUBSCRIPTION_CHANGE_CREATE,
        PermissionCode.SUBSCRIPTION_CHANGE_QUOTE
      ],
      roles: ["OP"],
      username: "integration-op"
    };
    const context = { ipAddress: "127.0.0.1", userAgent: "vitest-integration" };

    try {
      const change = await service.createExtension(
        {
          extensionMonths: 6,
          idempotencyKey: `create:${fixture.orderId}`,
          orderId: fixture.orderId,
          priceOverrideReason: "Retain the archived agreement price",
          pricingMode: SubscriptionChangePricingMode.ORIGINAL_PRICE
        },
        actor,
        context
      );
      expect(change).toMatchObject({
        orderId: fixture.orderId,
        status: SubscriptionChangeStatus.DRAFT,
        targetStartDate: new Date("2026-09-03T00:00:00.000Z"),
        targetEndDate: new Date("2027-03-02T00:00:00.000Z")
      });
      const stored = await prisma.subscriptionChangeOrder.findUniqueOrThrow({
        include: { extensionDetail: true },
        where: { id: change.id }
      });
      expect(stored).toMatchObject({
        extensionMonths: null,
        pricingMode: null,
        sourceSegmentId: null,
        targetEndDate: null,
        targetStartDate: null,
        extensionDetail: {
          extensionMonths: 6,
          pricingMode: SubscriptionChangePricingMode.ORIGINAL_PRICE,
          sourceSegmentId: expect.any(String),
          targetEndDate: new Date("2027-03-02T00:00:00.000Z"),
          targetStartDate: new Date("2026-09-03T00:00:00.000Z")
        }
      });

      const quoteInput = {
        idempotencyKey: `quote:${change.id}:1`,
        version: 0
      };
      const quote = await service.createFormalQuote(change.id, quoteInput, actor, context);
      const replay = await service.createFormalQuote(change.id, quoteInput, actor, context);

      expect(quote).toMatchObject({
        monthlyFeeAmount: 88_000n,
        revision: 1,
        status: SubscriptionChangeQuoteStatus.FORMAL
      });
      expect(replay.id).toBe(quote.id);
      await expect(
        prisma.subscriptionChangeQuote.count({ where: { changeOrderId: change.id } })
      ).resolves.toBe(1);
      await expect(
        prisma.subscriptionChangeCommand.count({
          where: { actorId: actor.id, resourceId: { in: [change.id, quote.id] } }
        })
      ).resolves.toBe(2);

      const approver = {
        ...actor,
        id: approverId,
        permissions: [PermissionCode.SUBSCRIPTION_CHANGE_PRICE_OVERRIDE_APPROVE],
        username: `extension-approver-${approverId}`
      };
      await service.approvePriceOverride(
        change.id,
        {
          idempotencyKey: `approve:${change.id}:1`,
          reason: "Approved against the archived agreement",
          version: 1
        },
        approver,
        context
      );

      const approved = await prisma.subscriptionChangeOrder.findUniqueOrThrow({
        include: { extensionDetail: true },
        where: { id: change.id }
      });
      expect(approved).toMatchObject({
        priceOverrideApprovedAt: null,
        priceOverrideApprovedBy: null,
        priceOverrideReason: null,
        extensionDetail: {
          priceOverrideApprovedAt: new Date("2026-08-05T04:00:00.000Z"),
          priceOverrideApprovedBy: approverId,
          priceOverrideReason: "Approved against the archived agreement"
        }
      });
    } finally {
      await cleanupFixture(prisma, fixture.orderId);
      await prisma.user.deleteMany({ where: { id: approverId } });
    }
  });

  it("serializes Admin and customer-renewal creation through one active-change slot", async () => {
    const fixture = await createFixture(prisma);
    const actor = {
      id: randomUUID(),
      menus: [],
      name: "Integration Operator",
      permissions: [PermissionCode.SUBSCRIPTION_CHANGE_CREATE],
      roles: ["OP"],
      username: "integration-op"
    };
    const context = { ipAddress: "127.0.0.1", userAgent: "vitest-integration" };

    try {
      const segment = await segmentService.ensureBaseSegment(fixture.orderId, actor.id);
      const consideration = await prisma.renewalConsideration.create({
        data: {
          completionDeadlineAt: new Date("2026-09-02T16:00:00.000Z"),
          considerationNo: `RNC${randomUUID().replaceAll("-", "").slice(0, 20)}`,
          considerationStartAt: new Date("2026-08-03T00:00:00.000Z"),
          orderId: fixture.orderId,
          segmentId: segment.id,
          status: RenewalConsiderationStatus.PENDING_DECISION
        }
      });
      const portal = new PortalRenewalService(
        prisma,
        new AuditService(prisma),
        {
          enabled: true,
          now: () => new Date("2026-08-05T04:00:00.000Z"),
          quoteValidityHours: 72
        },
        repository
      );

      const results = await Promise.allSettled([
        service.createExtension(
          {
            extensionMonths: 6,
            idempotencyKey: `admin:${fixture.orderId}`,
            orderId: fixture.orderId,
            pricingMode: SubscriptionChangePricingMode.CURRENT_VERSION
          },
          actor,
          context
        ),
        portal.decide(
          consideration.id,
          {
            decision: RenewalDecision.RENEW,
            idempotencyKey: `portal-renewal:${consideration.id}`,
            version: 0
          },
          {
            accountStatus: "ACTIVE",
            customerAccountId: randomUUID(),
            customerId: fixture.customerId,
            phone: "13800138000"
          } as never,
          context
        )
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      await expect(
        prisma.subscriptionChangeOrder.count({
          where: {
            orderId: fixture.orderId,
            status: {
              in: [
                SubscriptionChangeStatus.DRAFT,
                SubscriptionChangeStatus.QUOTED,
                SubscriptionChangeStatus.CUSTOMER_CONFIRMED,
                SubscriptionChangeStatus.SIGNING_OR_PAYMENT,
                SubscriptionChangeStatus.SCHEDULED,
                SubscriptionChangeStatus.EXECUTING,
                SubscriptionChangeStatus.MANUAL_TAKEOVER
              ]
            }
          }
        })
      ).resolves.toBe(1);
      await expect(
        prisma.subscriptionExtensionChangeDetail.count({
          where: { changeOrder: { orderId: fixture.orderId } }
        })
      ).resolves.toBe(1);
    } finally {
      await cleanupFixture(prisma, fixture.orderId);
    }
  });
});

async function createFixture(prisma: PrismaService) {
  const orderId = randomUUID();
  const contractId = randomUUID();
  const customerId = randomUUID();
  const productId = randomUUID();
  const productVersionId = randomUUID();
  const vehicleId = randomUUID();
  const applicationId = randomUUID();
  const quoteId = randomUUID();

  await prisma.$transaction(async (tx) => {
    await insertRuntimeOrderGraph(tx, {
      applicationId,
      customerId,
      label: `EXT-${orderId}`,
      orderId,
      productId,
      productVersionId,
      quoteId,
      vehicleId
    });
    await insertRuntimeContract(tx, {
      contractId,
      customerId,
      label: `EXT-${orderId}`,
      orderId,
      status: "ARCHIVED"
    });
    await tx.subscriptionOrder.update({
      data: {
        depositAmount: 0n,
        endDate: new Date("2026-09-02T00:00:00.000Z"),
        energyLimitCount: 2,
        finalPlanSnapshot: { subscriptionPlan: { planNo: "PLAN-EXT-1" } },
        mileageLimitKm: 1500,
        monthlyFeeAmount: 88000n,
        orderStatus: "ACTIVE",
        overMileageFeeAmount: 100n,
        quoteSnapshot: { quoteNo: "QUOTE-EXT-1" },
        startDate: new Date("2026-03-03T00:00:00.000Z"),
        vehiclePurchasePriceAmount: 20000000n
      },
      where: { id: orderId }
    });
    await tx.vehicle.update({
      data: {
        currentSalePriceAmount: 20000000n,
        purchasePriceAmount: 18000000n,
        status: "LEASED"
      },
      where: { id: vehicleId }
    });
  });

  return { contractId, customerId, orderId, productId, productVersionId, vehicleId };
}

async function cleanupFixture(prisma: PrismaService, orderId: string) {
  void prisma;
  void orderId;
}
