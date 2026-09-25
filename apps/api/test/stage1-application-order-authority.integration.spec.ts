import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit.service";
import type { RequestUser } from "../src/auth/auth.types";
import { CustomerService } from "../src/customer/customer.service";
import { OrderEntitlementService } from "../src/order/order-entitlement.service";
import { OrderService } from "../src/order/order.service";
import { PortalApplicationService } from "../src/portal/portal-application.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { commercialPlanHash } from "../src/subscription-journey/subscription-journey-json";
import { SubscriptionJourneySignalService } from "../src/subscription-journey/subscription-journey-signal.service";
import { SubscriptionJourneyRuntimeConfig } from "../src/subscription-journey/subscription-journey.config";
import { SubscriptionJourneyRepository } from "../src/subscription-journey/subscription-journey.repository";
import { SubscriptionJourneyService } from "../src/subscription-journey/subscription-journey.service";
import type { ClaimedJourneyJob } from "../src/subscription-journey/subscription-journey.types";
import { requiredReleaseDatabaseTestContext } from "./helpers/release-database-test-context";
import {
  insertRuntimeCustomer,
  insertRuntimeSubscriptionPlan,
  insertRuntimeUser,
  insertRuntimeVehicle
} from "./helpers/runtime-domain-fixture";

const database = requiredReleaseDatabaseTestContext(
  "apps/api/test/stage1-application-order-authority.integration.spec.ts"
);
const context = { ipAddress: "127.0.0.1", userAgent: "stage1-authority-test" };

describe("Stage 1 application and order authority", () => {
  let prisma: PrismaService;
  let audit: AuditService;
  let signals: SubscriptionJourneySignalService;
  let repository: SubscriptionJourneyRepository;
  let customer: CustomerService;
  let journey: SubscriptionJourneyService;

  beforeAll(async () => {
    prisma = new PrismaService(
      new ConfigService({ DATABASE_POOL_MAX: "10", DATABASE_URL: database.databaseUrl })
    );
    await prisma.onModuleInit();
    audit = new AuditService(prisma);
    repository = new SubscriptionJourneyRepository();
    signals = new SubscriptionJourneySignalService(
      repository,
      new SubscriptionJourneyRuntimeConfig(new ConfigService({}))
    );
    customer = customerService(prisma);
    journey = new SubscriptionJourneyService(
      repository,
      prisma,
      customer,
      new OrderService(audit, prisma),
      new OrderEntitlementService()
    );
    await prisma.contractVersion.create({
      data: {
        templateName: `authority-${randomUUID()}`,
        versionNo: "1",
        contentTemplate: "Synthetic authority test contract",
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
        status: "ACTIVE"
      }
    });
  });

  afterAll(async () => prisma?.onModuleDestroy());

  function customerService(client: PrismaService) {
    // Risk assessment and object storage are not reached by these already-reviewed flows.
    return new CustomerService(audit, client, {} as never, {} as never, undefined, signals);
  }

  async function confirmedApplication() {
    const userId = randomUUID();
    const customerId = randomUUID();
    const vehicleId = randomUUID();
    const planId = randomUUID();
    const applicationId = randomUUID();
    const actor: RequestUser = {
      id: userId,
      menus: [],
      name: "Authority test",
      permissions: [],
      roles: ["ADMIN"],
      username: `authority-${userId}`
    };
    await prisma.$transaction(
      async (tx) => {
        await insertRuntimeUser(tx, userId, "authority");
        await insertRuntimeCustomer(tx, customerId, "authority");
        await tx.customerIdentity.create({ data: { customerId, idCardNo: "110101199001010015" } });
        const { modelDefinitionId } = await insertRuntimeVehicle(tx, vehicleId, "authority");
        await tx.vehicle.update({
          where: { id: vehicleId },
          data: { status: "REVIEW_RESERVED", currentSalePriceAmount: 1000000n }
        });
        const product = await tx.product.create({
          data: { productNo: `authority-${randomUUID()}`, name: "Authority", status: "ACTIVE" }
        });
        const version = await tx.productVersion.create({
          data: {
            productId: product.id,
            versionNo: "1",
            effectiveFrom: new Date("2026-01-01T00:00:00Z"),
            status: "ACTIVE"
          }
        });
        const vehiclePackageId = randomUUID();
        const packages = await insertRuntimeSubscriptionPlan(tx, {
          label: "authority",
          modelDefinitionId,
          planId,
          productId: product.id,
          productVersionId: version.id,
          vehiclePackageId
        });
        await tx.vehiclePackage.update({
          where: { id: vehiclePackageId },
          data: { status: "ACTIVE", modelMembers: { create: { modelDefinitionId } } }
        });
        await tx.mileagePackage.update({
          where: { id: packages.mileagePackageId },
          data: { status: "ACTIVE", priceAmount: 1000n }
        });
        await tx.energyPackage.update({
          where: { id: packages.energyPackageId },
          data: { status: "ACTIVE", priceAmount: 2000n }
        });
        await tx.subscriptionPlan.update({
          where: { id: planId },
          data: { monthlyFeeMode: "FIXED_AMOUNT" }
        });
        await tx.application.create({
          data: {
            id: applicationId,
            applicationNo: `authority-${randomUUID()}`,
            applicationSource: "SELF_SERVICE",
            customerId,
            salesUserId: userId,
            status: "APPROVED",
            materialReviewStatus: "APPROVED",
            creditReviewStatus: "APPROVED",
            productReviewStatus: "APPROVED",
            vehicleReviewStatus: "APPROVED",
            depositStatus: "CONFIRMED",
            finalDepositAmount: 100000n,
            finalVehicleId: vehicleId,
            softReservedVehicleId: vehicleId,
            finalSubscriptionPlanId: planId,
            finalPeriodMonths: 6
          }
        });
      },
      { timeout: 30000 }
    );

    // Production snapshot generation and portal confirmation; fixture starts at the reviewed boundary.
    await customer.finalizeApplicationPlan(applicationId, actor, context);
    const published = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
    const hash = commercialPlanHash(published.finalPlanSnapshot);
    await prisma.application.update({
      where: { id: applicationId },
      data: { finalPlanRevision: 1, finalPlanCommercialHash: hash }
    });
    const current = await prisma.subscriptionJourney.create({
      data: {
        applicationId,
        currentStepCode: "ORDER_AND_CONTRACT_CREATION",
        steps: { create: { code: "ORDER_AND_CONTRACT_CREATION" } }
      },
      include: { steps: true }
    });
    const portal = new PortalApplicationService(
      audit,
      new ConfigService({}),
      customer,
      prisma,
      {} as never
    );
    await portal.confirmFinalPlan(
      applicationId,
      { revision: 1, commercialHash: hash },
      {
        accountStatus: "ACTIVE",
        customerAccountId: randomUUID(),
        customerId,
        phone: "13000000000"
      },
      context
    );
    const job = await prisma.subscriptionJourneyJob.create({
      data: {
        journeyId: current.id,
        stepId: current.steps[0]!.id,
        jobType: "CREATE_ORDER_AND_CONTRACT",
        sourceKey: `journey:${current.id}:step:ORDER_AND_CONTRACT_CREATION:revision:1`,
        payload: { finalPlanRevision: 1 },
        status: "PROCESSING",
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 120000)
      }
    });
    return {
      actor,
      applicationId,
      vehicleId,
      journeyId: current.id,
      job: job as ClaimedJourneyJob
    };
  }

  async function facts(fixture: Awaited<ReturnType<typeof confirmedApplication>>) {
    const [application, vehicle, current, orders, contracts, quotes] = await Promise.all([
      prisma.application.findUniqueOrThrow({ where: { id: fixture.applicationId } }),
      prisma.vehicle.findUniqueOrThrow({ where: { id: fixture.vehicleId } }),
      prisma.subscriptionJourney.findUniqueOrThrow({ where: { id: fixture.journeyId } }),
      prisma.subscriptionOrder.findMany({ where: { applicationId: fixture.applicationId } }),
      prisma.contract.findMany({ where: { order: { applicationId: fixture.applicationId } } }),
      prisma.subscriptionQuote.findMany({ where: { applicationId: fixture.applicationId } })
    ]);
    return { application, vehicle, current, orders, contracts, quotes };
  }

  async function expectOrdered(fixture: Awaited<ReturnType<typeof confirmedApplication>>) {
    const state = await facts(fixture);
    expect(state.application.status).toBe("APPROVED");
    expect(state.vehicle.status).toBe("RESERVED");
    expect(state.orders).toHaveLength(1);
    expect(state.contracts).toHaveLength(1);
    expect(state.quotes).toHaveLength(1);
    expect(state.current.orderId).toBe(state.orders[0]!.id);
    expect(state.current.currentStepCode).toBe("FADADA_SIGNING_AND_ARCHIVE");
    expect(state.orders[0]!.monthlyFeeAmount).toBe(13000n);
    expect(state.orders[0]!.mileageLimitKm).toBe(1500);
    expect(state.orders[0]!.periodMonths).toBe(6);
    expect(state.orders[0]!.quoteSnapshot).toEqual(state.application.finalQuoteSnapshot);
    return state;
  }

  async function bootstrap(fixture: Awaited<ReturnType<typeof confirmedApplication>>) {
    await journey.createOrderAndContractJob(fixture.job);
    // Materialize the successor step through the real signal consumer, without calling the provider.
    await prisma.$transaction(async (tx) => {
      const claimed = await repository.claimSignalOutbox(tx, 100, 120000);
      const completed = claimed.find(
        (row) => row.eventKey === `${fixture.job.sourceKey}:completed:outbox`
      );
      expect(completed).toBeDefined();
      await journey.dispatchSignalOutbox(tx, completed!);
      await repository.completeOutbox(tx, completed!.id, completed!.leaseToken);
    });
  }

  it("bootstraps a confirmed application through real order, contract and entitlement services", async () => {
    const fixture = await confirmedApplication();
    await bootstrap(fixture);
    await expectOrdered(fixture);
  });

  for (const action of ["cancelApplication", "rejectApplication"] as const) {
    it(`${action} cannot use a pre-bootstrap read after the real bootstrap commits`, async () => {
      const fixture = await confirmedApplication();
      const entered = deferred();
      const release = deferred();
      // Pause before the caller's real transaction, after its outside read. All database operations remain real.
      const pausedClient = new Proxy(prisma, {
        get(target, key) {
          if (key === "$transaction")
            return async (run: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
              entered.resolve();
              await release.promise;
              return target.$transaction(run);
            };
          return Reflect.get(target, key, target);
        }
      });
      const cancellation = customerService(pausedClient)
        [action](fixture.applicationId, { reason: "Synthetic test" }, fixture.actor, context)
        .then(
          () => ({ rejected: false }),
          (error: Error) => ({ rejected: true, message: error.message })
        );
      try {
        await entered.promise;
        await bootstrap(fixture);
      } finally {
        release.resolve();
      }
      expect.soft(await cancellation).toEqual({
        rejected: true,
        message: "该进件已生成订单，请勿重复处理。"
      });
      await expectOrdered(fixture);
    });

    it(`bootstrap cannot create facts after ${action} commits`, async () => {
      const fixture = await confirmedApplication();
      await customer[action](
        fixture.applicationId,
        { reason: "Synthetic test" },
        fixture.actor,
        context
      );
      await expect(journey.createOrderAndContractJob(fixture.job)).rejects.toBeDefined();
      const state = await facts(fixture);
      expect(state.application.status).toBe(
        action === "cancelApplication" ? "CANCELLED" : "REJECTED"
      );
      expect(state.vehicle.status).toBe("AVAILABLE");
      expect(state.current.status).toBe("CANCELLED");
      expect(state.current.orderId).toBeNull();
      expect(state.orders).toHaveLength(0);
      expect(state.contracts).toHaveLength(0);
      expect(state.quotes).toHaveLength(0);
    });
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
