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
      new OrderEntitlementService(),
      undefined, undefined, undefined, undefined, undefined, audit
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

  async function confirmedApplication(confirmNow = true) {
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
    const confirm = (client = prisma, revision = 1, commercialHash = hash) =>
      new PortalApplicationService(
        audit,
        new ConfigService({}),
        customer,
        client,
        {} as never
      ).confirmFinalPlan(
        applicationId,
        { revision, commercialHash },
        {
          accountStatus: "ACTIVE",
          customerAccountId: randomUUID(),
          customerId,
          phone: "13000000000"
        },
        context
      );
    if (confirmNow) await confirm();
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
      confirm,
      planId,
      vehicleId,
      journeyId: current.id,
      job: job as ClaimedJourneyJob
    };
  }

  async function facts(fixture: Awaited<ReturnType<typeof confirmedApplication>>) {
    const [application, vehicle, current, orders, contracts, quotes, accounts, grants, audits] =
      await Promise.all([
        prisma.application.findUniqueOrThrow({ where: { id: fixture.applicationId } }),
        prisma.vehicle.findUniqueOrThrow({ where: { id: fixture.vehicleId } }),
        prisma.subscriptionJourney.findUniqueOrThrow({ where: { id: fixture.journeyId } }),
        prisma.subscriptionOrder.findMany({ where: { applicationId: fixture.applicationId } }),
        prisma.contract.findMany({ where: { order: { applicationId: fixture.applicationId } } }),
        prisma.subscriptionQuote.findMany({ where: { applicationId: fixture.applicationId } }),
        prisma.orderEntitlementAccount.findMany({
          where: { order: { applicationId: fixture.applicationId } }
        }),
        prisma.orderEntitlementGrant.findMany({
          where: { order: { applicationId: fixture.applicationId } }
        }),
        prisma.auditLog.findMany({
          where: { entityId: fixture.applicationId, entityType: "application" }
        })
      ]);
    return { application, vehicle, current, orders, contracts, quotes, accounts, grants, audits };
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
    expect(state.accounts).toHaveLength(1);
    expect(state.accounts[0]!.accountStatus).toBe("SUSPENDED");
    expect(
      state.grants.map(({ entitlementType, totalAmount, remainingAmount }) => ({
        entitlementType,
        total: totalAmount?.toString(),
        remaining: remainingAmount?.toString()
      }))
    ).toEqual(
      expect.arrayContaining([
        { entitlementType: "MILEAGE", total: "1500", remaining: "1500" },
        { entitlementType: "ENERGY", total: "100", remaining: "100" }
      ])
    );
    expect(state.grants).toHaveLength(2);
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

  async function changeCommercialFact(
    fixture: Awaited<ReturnType<typeof confirmedApplication>>,
    fact: string
  ) {
    const plan = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { id: fixture.planId } });
    switch (fact) {
      case "vehicle price":
        await prisma.vehicle.update({ where: { id: fixture.vehicleId }, data: { currentSalePriceAmount: 1200000n } });
        break;
      case "mileage price":
        await prisma.mileagePackage.update({ where: { id: plan.mileagePackageId }, data: { priceAmount: { increment: 1000n } } });
        break;
      case "energy price":
        await prisma.energyPackage.update({ where: { id: plan.energyPackageId }, data: { priceAmount: 3000n } });
        break;
      case "mileage quota":
        await prisma.mileagePackage.update({ where: { id: plan.mileagePackageId }, data: { monthlyMileageKm: 2000 } });
        break;
      case "energy quota":
        await prisma.energyPackage.update({ where: { id: plan.energyPackageId }, data: { monthlyEnergyKwh: 200 } });
        break;
      case "over mileage fee":
        await prisma.mileagePackage.update({ where: { id: plan.mileagePackageId }, data: { overMileageFeeAmount: { increment: 100n } } });
        break;
      case "period":
        await prisma.application.update({ where: { id: fixture.applicationId }, data: { finalPeriodMonths: 12 } });
        break;
      case "vehicle identity":
        await prisma.vehicle.update({ where: { id: fixture.vehicleId }, data: { vin: `F1${randomUUID().replaceAll("-", "").slice(0, 15)}` } });
        break;
      default:
        throw new Error(`Unknown commercial fact: ${fact}`);
    }
  }

  async function expectRequote(
    fixture: Awaited<ReturnType<typeof confirmedApplication>>,
    before: Awaited<ReturnType<typeof facts>>
  ) {
    const state = await facts(fixture);
    expect(state.application.finalPlanSnapshot).toEqual(before.application.finalPlanSnapshot);
    expect(state.application.finalQuoteSnapshot).toEqual(before.application.finalQuoteSnapshot);
    expect(state.application.finalPlanCommercialHash).toBe(before.application.finalPlanCommercialHash);
    expect(state.application.customerConfirmedPlanRevision).toBe(before.application.customerConfirmedPlanRevision);
    expect(state.application.planConfirmStatus).toBe("CONFIRMED");
    expect(state.application.finalPlanConfirmedAt).toEqual(before.application.finalPlanConfirmedAt);
    expect(state.vehicle.status).toBe("REVIEW_RESERVED");
    expect(state.orders).toHaveLength(0);
    expect(state.quotes).toHaveLength(0);
    expect(state.contracts).toHaveLength(0);
    expect(state.accounts).toHaveLength(0);
    expect(state.grants).toHaveLength(0);
    expect(state.current).toMatchObject({ currentStepCode: "FINAL_PLAN_DECISION", status: "WAITING_MANUAL", orderId: null });
    const tasks = await prisma.subscriptionJourneyManualTask.findMany({
      where: { journeyId: fixture.journeyId, status: "OPEN" }
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ taskType: "FINAL_PLAN_DECISION", inputSnapshot: { reason: "FINAL_PLAN_REVISION_STALE", finalPlanRevision: before.application.finalPlanRevision } });
    return state;
  }

  it.each([
    "vehicle price", "mileage price", "energy price", "mileage quota",
    "energy quota", "over mileage fee", "period", "vehicle identity"
  ])("returns to manual pricing without writing an order after confirmed %s changes", async (fact) => {
    const fixture = await confirmedApplication();
    const before = await facts(fixture);
    await changeCommercialFact(fixture, fact);
    await expect(journey.createOrderAndContractJob(fixture.job)).resolves.toMatchObject({ action: "ORDER_AND_CONTRACT_WAITING_REQUOTE" });
    await expectRequote(fixture, before);
  });

  it("allows operational vehicle observations to change without replacing confirmed commercial facts", async () => {
    const fixture = await confirmedApplication();
    await prisma.vehicle.update({
      where: { id: fixture.vehicleId },
      data: { assetLocation: "Synthetic preparation bay", currentMileageKm: { increment: 10 } }
    });
    await bootstrap(fixture);
    await expectOrdered(fixture);
  });

  it("rejects commercial drift through the public direct creation entry before any writes", async () => {
    const fixture = await confirmedApplication();
    const before = await facts(fixture);
    await changeCommercialFact(fixture, "mileage quota");
    await expect(customer.createOrderFromApplication(fixture.applicationId, fixture.actor, context))
      .rejects.toThrow("FINAL_PLAN_REVISION_STALE");
    const after = await facts(fixture);
    expect(after.orders).toHaveLength(0);
    expect(after.quotes).toHaveLength(0);
    expect(after.vehicle.status).toBe("REVIEW_RESERVED");
    expect(after.application.finalPlanSnapshot).toEqual(before.application.finalPlanSnapshot);
  });

  async function dispatchPendingSignals(journeyId: string) {
    for (let round = 0; round < 20; round += 1) {
      const pending = await prisma.subscriptionJourneyOutbox.count({
        where: { journeyId, status: "PENDING", aggregateType: { not: "JOURNEY_NOTIFICATION" } }
      });
      if (pending === 0) return;
      await prisma.$transaction(async (tx) => {
        const rows = await repository.claimSignalOutbox(tx, 1000, 120000);
        for (const row of rows.filter((value) => value.journeyId === journeyId)) {
          await journey.dispatchSignalOutbox(tx, row);
          await repository.completeOutbox(tx, row.id, row.leaseToken);
        }
      });
    }
    throw new Error("Journey signal drain did not settle");
  }

  it("reopens pricing twice, requires each new customer confirmation, and safely replays an unacknowledged old job", async () => {
    const fixture = await confirmedApplication();
    let currentJob = fixture.job;
    for (const revision of [2, 3]) {
      const before = await facts(fixture);
      await changeCommercialFact(fixture, "mileage price");
      const result = await journey.createOrderAndContractJob(currentJob);
      expect(result).toMatchObject({ action: "ORDER_AND_CONTRACT_WAITING_REQUOTE" });
      const waiting = await expectRequote(fixture, before);
      // Response loss before job acknowledgement must not create another task or technical exception.
      await expect(journey.createOrderAndContractJob(currentJob)).resolves.toEqual(result);
      expect((await facts(fixture)).current.version).toBe(waiting.current.version);
      await prisma.$transaction((tx) => repository.completeJob(tx, currentJob.id, currentJob.leaseToken, result));
      expect(await prisma.subscriptionJourneyJob.findUniqueOrThrow({ where: { id: currentJob.id } }))
        .toMatchObject({ status: "COMPLETED", attemptCount: 0, lastErrorCode: null });
      await journey.decideFinalPlan(fixture.journeyId, {
        version: waiting.current.version,
        finalPeriodMonths: 6,
        finalSubscriptionPlanId: fixture.planId,
        finalVehicleId: fixture.vehicleId
      }, fixture.actor, context);
      await dispatchPendingSignals(fixture.journeyId);
      const published = await facts(fixture);
      expect(published.application).toMatchObject({ finalPlanRevision: revision, customerConfirmedPlanRevision: null, planConfirmStatus: "PENDING", finalPlanConfirmedAt: null });
      expect(published.application.finalPlanCommercialHash).not.toBe(before.application.finalPlanCommercialHash);
      expect(published.current.currentStepCode).toBe("CUSTOMER_PLAN_CONFIRMATION");
      expect(published.orders).toHaveLength(0);
      await expect(journey.createOrderAndContractJob(currentJob)).resolves.toEqual(result);
      await expect(fixture.confirm()).rejects.toThrow();
      await fixture.confirm(prisma, revision, published.application.finalPlanCommercialHash!);
      await dispatchPendingSignals(fixture.journeyId);
      const job = await prisma.subscriptionJourneyJob.findUniqueOrThrow({
        where: { sourceKey: `journey:${fixture.journeyId}:step:ORDER_AND_CONTRACT_CREATION:revision:${revision}` }
      });
      // Claim the actual queued revision via the production repository.
      const claimed = await prisma.$transaction((tx) => repository.claimJobs(tx, 1000, 120000));
      currentJob = claimed.find(({ id }) => id === job.id)!;
      expect(currentJob).toBeDefined();
    }
    await bootstrap({ ...fixture, job: currentJob });
    const final = await facts(fixture);
    expect(final.orders).toHaveLength(1);
    expect(final.quotes).toHaveLength(1);
    expect(final.contracts).toHaveLength(1);
    expect(final.orders[0]).toMatchObject({ monthlyFeeAmount: 15000n, periodMonths: 6, mileageLimitKm: 1500, energyLimitKwh: 100 });
    expect(final.quotes[0]).toMatchObject({ monthlyFeeAmount: 15000n, mileagePackagePriceAmount: 3000n, periodMonths: 6 });
    expect(final.orders[0]!.quoteSnapshot).toEqual(final.application.finalQuoteSnapshot);
    expect(final.application).toMatchObject({ finalPlanRevision: 3, customerConfirmedPlanRevision: 3, planConfirmStatus: "CONFIRMED" });
    expect(final.grants).toHaveLength(2);
    expect(final.grants.map(({ totalAmount }) => totalAmount?.toString()).sort()).toEqual(["100", "1500"]);
    expect(await prisma.subscriptionJourneyManualTask.count({ where: { journeyId: fixture.journeyId, status: "COMPLETED" } })).toBe(2);
    expect(await prisma.subscriptionJourneyException.count({ where: { journeyId: fixture.journeyId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { entityId: fixture.applicationId, entityType: "subscription_journey" } })).toBe(2);
  });

  it("bootstraps a confirmed application through real order, contract and entitlement services", async () => {
    const fixture = await confirmedApplication();
    await bootstrap(fixture);
    await expectOrdered(fixture);
    await expect(journey.createOrderAndContractJob(fixture.job)).resolves.toMatchObject({
      action: "ORDER_AND_CONTRACT_ALREADY_COMPLETED"
    });
    await expectOrdered(fixture);
  });

  it.each(["portal confirmation", "material review"])(
    "serializes %s before cancellation without a database deadlock",
    async (firstAction) => {
      const fixture = await confirmedApplication(firstAction === "material review");
      const updatedApplication = deferred();
      const releaseConfirmation = deferred();
      const cancellationEntered = deferred();
      let confirmingPid = 0;
      let cancellingPid = 0;
      const confirmingClient = instrumentTransactions(async (tx) => {
        const [backend] = await tx.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pg_backend_pid() AS pid`;
        confirmingPid = backend!.pid;
        return new Proxy(tx, {
          get(target, key) {
            if (key === "application")
              return new Proxy(target.application, {
                get(delegate, operation) {
                  if (operation === "update")
                    return async (...args: Parameters<typeof delegate.update>) => {
                      const result = await delegate.update(...args);
                      updatedApplication.resolve();
                      await releaseConfirmation.promise;
                      return result;
                    };
                  if (operation === "updateMany")
                    return async (...args: Parameters<typeof delegate.updateMany>) => {
                      const result = await delegate.updateMany(...args);
                      updatedApplication.resolve();
                      await releaseConfirmation.promise;
                      return result;
                    };
                  return Reflect.get(delegate, operation, delegate);
                }
              });
            return Reflect.get(target, key, target);
          }
        });
      });
      const cancellingClient = instrumentTransactions(async (tx) => {
        const [backend] = await tx.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pg_backend_pid() AS pid`;
        cancellingPid = backend!.pid;
        cancellationEntered.resolve();
        return tx;
      });
      const first =
        firstAction === "portal confirmation"
          ? fixture.confirm(confirmingClient)
          : customerService(confirmingClient).reviewApplication(
              fixture.applicationId,
              "material",
              {
                action: "APPROVED",
                comment: "Synthetic review"
              },
              fixture.actor,
              context
            );
      const confirmation = first.then(() => "updated", databaseFailureLabel);
      let cancellation: Promise<unknown> | undefined;
      try {
        await updatedApplication.promise;
        cancellation = customerService(cancellingClient)
          .cancelApplication(
            fixture.applicationId,
            { reason: "Synthetic test" },
            fixture.actor,
            context
          )
          .then(() => "cancelled", databaseFailureLabel);
        await cancellationEntered.promise;
        // Observe an actual lock wait, then release the first transaction. No timing-dependent sleep.
        const deadline = Date.now() + 5000;
        let blocked = false;
        while (!blocked && Date.now() < deadline) {
          const [row] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT ${confirmingPid}::integer = ANY(pg_blocking_pids(${cancellingPid}::integer)) AS blocked
        `;
          blocked = row!.blocked;
        }
        expect(blocked).toBe(true);
      } finally {
        releaseConfirmation.resolve();
      }
      expect(await confirmation).toBe("updated");
      expect(await cancellation).toBe("cancelled");
      const state = await facts(fixture);
      expect(state.application.status).toBe("CANCELLED");
      expect(state.current.status).toBe("CANCELLED");
      expect(state.vehicle.status).toBe("AVAILABLE");
      expect(state.orders).toHaveLength(0);
      expect(state.audits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            beforeSnapshot: expect.objectContaining({
              planConfirmStatus: "CONFIRMED",
              status: firstAction === "portal confirmation" ? "APPROVED" : "SUBMITTED"
            }),
            afterSnapshot: expect.objectContaining({ status: "CANCELLED" })
          })
        ])
      );
    }
  );

  it("does not confirm a final plan after cancellation commits", async () => {
    const fixture = await confirmedApplication(false);
    const entered = deferred();
    const release = deferred();
    const client = instrumentTransactions(async (tx) => {
      entered.resolve();
      await release.promise;
      return tx;
    });
    const confirmation = fixture.confirm(client).then(
      () => "confirmed",
      (error: Error) => error.message
    );
    try {
      await entered.promise;
      await customer.cancelApplication(
        fixture.applicationId,
        { reason: "Synthetic test" },
        fixture.actor,
        context
      );
    } finally {
      release.resolve();
    }
    expect(await confirmation).toBe("最终方案状态已变化，请刷新后重试。");
    const state = await facts(fixture);
    expect(state.application.status).toBe("CANCELLED");
    expect(state.application.planConfirmStatus).toBe("PENDING");
    expect(state.current.status).toBe("CANCELLED");
    expect(state.orders).toHaveLength(0);
  });

  it("lets an existing-group upload finish while material review waits without an FK deadlock", async () => {
    const fixture = await confirmedApplication();
    const actor = {
      ...fixture.actor,
      permissions: ["application:review", "application:material_upload"]
    };
    const oldFile = await prisma.fileObject.create({
      data: {
        bucket: "synthetic-authority",
        objectKey: randomUUID(),
        originalName: "before.txt",
        sizeBytes: 1n
      }
    });
    const group = await prisma.applicationMaterialGroup.create({
      data: {
        applicationId: fixture.applicationId,
        materialType: "ID_CARD",
        required: true,
        files: {
          create: {
            applicationId: fixture.applicationId,
            fileId: oldFile.id,
            fileName: "before.txt",
            materialType: "ID_CARD",
            sizeBytes: 1n,
            uploadedBy: actor.id
          }
        }
      }
    });
    const groupLocked = deferred();
    const releaseUpload = deferred();
    const reviewEntered = deferred();
    let uploadPid = 0;
    let reviewPid = 0;
    const uploadClient = instrumentTransactions(async (tx) => {
      const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      uploadPid = backend!.pid;
      return new Proxy(tx, {
        get(target, key) {
          if (key === "applicationMaterialGroup")
            return new Proxy(target.applicationMaterialGroup, {
              get(delegate, operation) {
                if (operation === "upsert")
                  return async (...args: Parameters<typeof delegate.upsert>) => {
                    const result = await delegate.upsert(...args);
                    groupLocked.resolve();
                    await releaseUpload.promise;
                    return result;
                  };
                return Reflect.get(delegate, operation, delegate);
              }
            });
          return Reflect.get(target, key, target);
        }
      });
    });
    const reviewClient = instrumentTransactions(async (tx) => {
      const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      reviewPid = backend!.pid;
      reviewEntered.resolve();
      return tx;
    });
    // Synthetic object-store boundary; upload/review services and every database write remain real.
    const uploadingCustomer = new CustomerService(
      audit,
      uploadClient,
      {} as never,
      {
        putApplicationMaterial: async () => ({
          bucket: "synthetic-authority",
          objectKey: randomUUID()
        })
      } as never,
      undefined,
      signals
    );
    const upload = uploadingCustomer
      .uploadMaterial(
        fixture.applicationId,
        { materialType: "ID_CARD" },
        [
          {
            buffer: Buffer.from("x"),
            originalname: "after.txt",
            mimetype: "text/plain",
            size: 1
          }
        ],
        actor,
        context
      )
      .then(() => "uploaded", databaseFailureLabel);
    let review: Promise<unknown> | undefined;
    try {
      await groupLocked.promise;
      review = customerService(reviewClient)
        .reviewMaterialGroup(
          fixture.applicationId,
          group.id,
          {
            status: "APPROVED",
            comment: "Synthetic review"
          },
          actor,
          context
        )
        .then(() => "reviewed", databaseFailureLabel);
      await reviewEntered.promise;
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (!blocked && Date.now() < deadline) {
        const [row] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT ${uploadPid}::integer = ANY(pg_blocking_pids(${reviewPid}::integer)) AS blocked
        `;
        blocked = row!.blocked;
      }
      expect(blocked).toBe(true);
    } finally {
      releaseUpload.resolve();
    }
    expect(await upload).toBe("uploaded");
    expect(await review).toBe("reviewed");
    const persisted = await prisma.applicationMaterialGroup.findUniqueOrThrow({
      where: { id: group.id },
      include: { files: true }
    });
    expect(persisted.reviewStatus).toBe("APPROVED");
    expect(persisted.files).toHaveLength(2);
    expect(
      await prisma.applicationActionLog.count({
        where: {
          applicationId: fixture.applicationId,
          materialGroupId: group.id
        }
      })
    ).toBe(2);
  });

  function instrumentTransactions(
    inspect: (tx: Prisma.TransactionClient) => Promise<Prisma.TransactionClient>
  ) {
    return new Proxy(prisma, {
      get(target, key) {
        if (key === "$transaction")
          return (run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
            target.$transaction(async (tx) => run(await inspect(tx)), { timeout: 15000 });
        return Reflect.get(target, key, target);
      }
    });
  }

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
      expect(state.accounts).toHaveLength(0);
      expect(state.grants).toHaveLength(0);
      expect(state.audits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            beforeSnapshot: expect.objectContaining({ status: "APPROVED" }),
            afterSnapshot: expect.objectContaining({ status: state.application.status })
          })
        ])
      );
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

function databaseFailureLabel(error: Error) {
  return /deadlock detected/i.test(error.message) ? "PostgreSQL deadlock detected" : error.message;
}
