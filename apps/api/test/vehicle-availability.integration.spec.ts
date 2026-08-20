import { ConflictException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Prisma,
  SalePriceStatus,
  SubscriptionJourneyJobStatus,
  SubscriptionJourneyJobType,
  SubscriptionJourneyStatus,
  SubscriptionJourneyStepCode,
  SubscriptionJourneyStepStatus,
  VehicleOperationalRestrictionScope,
  VehicleOperationalRestrictionSeverity,
  VehicleOperationalRestrictionStatus,
  VehicleOperationalRestrictionType,
  VehicleStatus
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ASSET_OPERATION_SERVICE_CODE,
  AssetOperationsService
} from "../src/asset-operations/asset-operations.service";
import { AssetOperationsRepository } from "../src/asset-operations/asset-operations.repository";
import {
  evaluateVehicleAvailability,
  VehicleAvailabilityPurpose
} from "../src/asset-operations/vehicle-availability";
import { AuditService } from "../src/audit/audit.service";
import { CustomerService } from "../src/customer/customer.service";
import { HandoverWorkOrderService } from "../src/handover-work-order/handover-work-order.service";
import { LeaseActivationEngine } from "../src/lease/lease-activation.engine";
import { PortalCatalogService } from "../src/portal/portal-catalog.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { ProductService } from "../src/product/product.service";
import { SubscriptionJourneyRepository } from "../src/subscription-journey/subscription-journey.repository";
import { SubscriptionJourneyService } from "../src/subscription-journey/subscription-journey.service";

const TEST_DATABASE_URL = requiredTestDatabaseUrl();
const FIXTURE_PREFIX = `S1CBA${randomUUID().replaceAll("-", "").slice(0, 10)}`;
const AS_OF = new Date("2026-08-20T06:00:00.000Z");

const purposeCases = [
  {
    blockedScope: VehicleOperationalRestrictionScope.ALLOCATION,
    initialStatus: VehicleStatus.AVAILABLE,
    purpose: VehicleAvailabilityPurpose.ALLOCATION
  },
  {
    blockedScope: VehicleOperationalRestrictionScope.DELIVERY,
    initialStatus: VehicleStatus.RESERVED,
    purpose: VehicleAvailabilityPurpose.DELIVERY
  },
  {
    blockedScope: VehicleOperationalRestrictionScope.INVENTORY_RELEASE,
    initialStatus: VehicleStatus.RETURNED,
    purpose: VehicleAvailabilityPurpose.MARK_AVAILABLE
  }
] as const;

describe("authoritative vehicle availability PostgreSQL boundaries", () => {
  let prisma: PrismaService;
  let repository: AssetOperationsRepository;
  let service: AssetOperationsService;
  let handoverService: HandoverWorkOrderService;
  let leaseActivationEngine: LeaseActivationEngine;
  let portalCatalogService: PortalCatalogService;
  let userId: string;

  beforeAll(async () => {
    prisma = new PrismaService(new ConfigService({ DATABASE_URL: TEST_DATABASE_URL }));
    await prisma.onModuleInit();
    repository = new AssetOperationsRepository();
    service = new AssetOperationsService(prisma, repository, new AuditService(prisma));
    handoverService = new HandoverWorkOrderService(
      prisma,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service
    );
    leaseActivationEngine = new LeaseActivationEngine(
      new AuditService(prisma),
      prisma,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service
    );
    portalCatalogService = new PortalCatalogService(prisma);
    userId = await createUserFixture(prisma);
  });

  afterAll(async () => {
    try {
      await deleteFixtures(prisma);
    } finally {
      await prisma.onModuleDestroy();
    }
  });

  it.each(purposeCases)(
    "keeps repository, pure evaluator and $purpose command behavior in parity",
    async ({ blockedScope, initialStatus, purpose }) => {
      const vehicleId = await createVehicleFixture(prisma, initialStatus, `parity-${purpose}`);
      await createRestriction(prisma, vehicleId, {
        scope: blockedScope,
        severity: VehicleOperationalRestrictionSeverity.ADVISORY
      });
      await createRestriction(prisma, vehicleId, {
        scope: VehicleOperationalRestrictionScope.CUSTOMER_USE,
        severity: VehicleOperationalRestrictionSeverity.BLOCKING
      });
      const releasedId = await createRestriction(prisma, vehicleId, {
        scope: blockedScope,
        severity: VehicleOperationalRestrictionSeverity.BLOCKING
      });
      await releaseRestriction(prisma, releasedId, userId);

      await readCommitted(prisma, async (tx) => {
        const snapshot = await repository.loadAvailabilitySnapshot(tx, vehicleId, AS_OF);
        const pure = evaluateVehicleAvailability({ ...snapshot, purpose });
        const command = await service.assertVehicleAvailable(tx, vehicleId, purpose, AS_OF);
        expect(command).toEqual(pure);
        expect(command.available).toBe(true);
      });

      if (purpose === VehicleAvailabilityPurpose.ALLOCATION) {
        await expect(listAvailableVehicleIds(prisma, AS_OF)).resolves.toContain(vehicleId);
      }

      await createRestriction(prisma, vehicleId, {
        scope: blockedScope,
        severity: VehicleOperationalRestrictionSeverity.BLOCKING
      });

      await readCommitted(prisma, async (tx) => {
        const snapshot = await repository.loadAvailabilitySnapshot(tx, vehicleId, AS_OF);
        const pure = evaluateVehicleAvailability({ ...snapshot, purpose });
        const error = await rejected(service.assertVehicleAvailable(tx, vehicleId, purpose, AS_OF));
        expect(pure.available).toBe(false);
        expectConflict(error, ASSET_OPERATION_SERVICE_CODE.VEHICLE_OPERATIONALLY_RESTRICTED);
        expect((error as ConflictException).getResponse()).toMatchObject({ reasons: pure.reasons });
      });

      if (purpose === VehicleAvailabilityPurpose.ALLOCATION) {
        await expect(listAvailableVehicleIds(prisma, AS_OF)).resolves.not.toContain(vehicleId);
      }
    }
  );

  it.each(purposeCases)(
    "serializes a held restriction create before $purpose and never commits the boundary write",
    async ({ blockedScope, initialStatus, purpose }) => {
      const vehicleId = await createVehicleFixture(prisma, initialStatus, `create-${purpose}`);
      const reached = deferred<void>();
      const release = deferred<void>();
      const holder = readCommitted(prisma, async (tx) => {
        await lockVehicleForRestriction(tx, vehicleId);
        await createRestriction(tx, vehicleId, {
          scope: blockedScope,
          severity: VehicleOperationalRestrictionSeverity.BLOCKING
        });
        reached.resolve();
        await release.promise;
      });
      void holder.catch(reached.reject);
      await reached.promise;
      const boundary = settled(runBoundary(prisma, service, vehicleId, purpose));
      try {
        expect(await waitForBoundaryLock(prisma)).toBe(true);
      } finally {
        release.resolve();
      }
      await holder;

      const result = await boundary;
      expect(result.status).toBe("rejected");
      expectConflict(
        rejectedValue(result),
        ASSET_OPERATION_SERVICE_CODE.VEHICLE_OPERATIONALLY_RESTRICTED
      );
      await expect(prisma.vehicle.findUnique({ where: { id: vehicleId } })).resolves.toMatchObject({
        brand: "NIO",
        status: initialStatus
      });
    }
  );

  it.each(purposeCases)(
    "serializes a held restriction release before $purpose and commits only after release",
    async ({ blockedScope, initialStatus, purpose }) => {
      const vehicleId = await createVehicleFixture(prisma, initialStatus, `release-${purpose}`);
      const restrictionId = await createRestriction(prisma, vehicleId, {
        scope: blockedScope,
        severity: VehicleOperationalRestrictionSeverity.BLOCKING
      });
      const reached = deferred<void>();
      const release = deferred<void>();
      const holder = readCommitted(prisma, async (tx) => {
        await lockVehicleForRestriction(tx, vehicleId);
        await releaseRestriction(tx, restrictionId, userId);
        reached.resolve();
        await release.promise;
      });
      void holder.catch(reached.reject);
      await reached.promise;
      const boundary = runBoundary(prisma, service, vehicleId, purpose);
      try {
        expect(await waitForBoundaryLock(prisma)).toBe(true);
      } finally {
        release.resolve();
      }
      await holder;
      await boundary;

      const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
      expect(vehicle).toMatchObject(
        purpose === VehicleAvailabilityPurpose.ALLOCATION
          ? { status: VehicleStatus.REVIEW_RESERVED }
          : purpose === VehicleAvailabilityPurpose.MARK_AVAILABLE
            ? { status: VehicleStatus.AVAILABLE }
            : { brand: `${FIXTURE_PREFIX}-delivered`, status: VehicleStatus.RESERVED }
      );
    }
  );

  it.each([
    {
      invoke: (workOrderId: string) => handoverService.startFieldWork(workOrderId, userId),
      label: "direct field-work start"
    },
    {
      invoke: (workOrderId: string) =>
        handoverService.startFieldAccessibleWorkOrder(workOrderId, "13800138000", userId),
      label: "field-session start"
    },
    {
      invoke: (workOrderId: string) =>
        handoverService.updateFieldFacts(workOrderId, { handoverMileageKm: 1234 }, userId),
      label: "DRAFT field-facts transition"
    }
  ])(
    "runs the guarded $label through the production READ COMMITTED boundary",
    async ({ invoke }) => {
      const vehicleId = await createVehicleFixture(
        prisma,
        VehicleStatus.RESERVED,
        "handover-allowed"
      );
      const { workOrderId } = await createHandoverFixture(prisma, vehicleId);

      const result = await invoke(workOrderId);

      expect(result).toMatchObject({ reviewVersion: 1, status: "FIELD_IN_PROGRESS" });
      await expect(prisma.vehicleHandoverEvent.count({ where: { workOrderId } })).resolves.toBe(1);
    }
  );

  it.each([
    {
      invoke: (workOrderId: string) => handoverService.startFieldWork(workOrderId, userId),
      label: "direct field-work start"
    },
    {
      invoke: (workOrderId: string) =>
        handoverService.startFieldAccessibleWorkOrder(workOrderId, "13800138000", userId),
      label: "field-session start"
    },
    {
      invoke: (workOrderId: string) =>
        handoverService.updateFieldFacts(workOrderId, { handoverMileageKm: 1234 }, userId),
      label: "DRAFT field-facts transition"
    }
  ])("blocks the production $label before its first write", async ({ invoke }) => {
    const vehicleId = await createVehicleFixture(
      prisma,
      VehicleStatus.RESERVED,
      "handover-blocked"
    );
    const { workOrderId } = await createHandoverFixture(prisma, vehicleId);
    await createRestriction(prisma, vehicleId, {
      scope: VehicleOperationalRestrictionScope.DELIVERY,
      severity: VehicleOperationalRestrictionSeverity.BLOCKING
    });

    expectConflict(
      await rejected(invoke(workOrderId)),
      ASSET_OPERATION_SERVICE_CODE.VEHICLE_OPERATIONALLY_RESTRICTED
    );
    await expect(
      prisma.vehicleHandoverWorkOrder.findUnique({ where: { id: workOrderId } })
    ).resolves.toMatchObject({ reviewVersion: 0, status: "DRAFT" });
    await expect(prisma.vehicleHandoverEvent.count({ where: { workOrderId } })).resolves.toBe(0);
  });

  it("blocks the central production LeaseActivation boundary before any activation write", async () => {
    const vehicleId = await createVehicleFixture(prisma, VehicleStatus.RESERVED, "lease-blocked");
    const { orderId } = await createHandoverFixture(prisma, vehicleId);
    await createRestriction(prisma, vehicleId, {
      scope: VehicleOperationalRestrictionScope.DELIVERY,
      severity: VehicleOperationalRestrictionSeverity.BLOCKING
    });

    const before = await activationResidue(prisma, orderId);
    const error = await rejected(
      readCommitted(prisma, (tx) =>
        leaseActivationEngine.activateFromAuthoritativeHandover(tx, { actorId: userId, orderId })
      )
    );

    expectConflict(error, ASSET_OPERATION_SERVICE_CODE.VEHICLE_OPERATIONALLY_RESTRICTED);
    await expect(activationResidue(prisma, orderId)).resolves.toEqual(before);
    await expect(prisma.vehicle.findUnique({ where: { id: vehicleId } })).resolves.toMatchObject({
      status: VehicleStatus.RESERVED
    });
  });

  it("persists the production Journey activation business wait without completing its step", async () => {
    const vehicleId = await createVehicleFixture(prisma, VehicleStatus.RESERVED, "journey-paused");
    const fixture = await createHandoverFixture(prisma, vehicleId);
    const journey = await createActivationJourneyFixture(
      prisma,
      fixture.applicationId,
      fixture.orderId,
      userId
    );
    const repository = new SubscriptionJourneyRepository();
    const restrictedEngine = {
      activateFromAuthoritativeHandover: async () => {
        throw new ConflictException({
          code: ASSET_OPERATION_SERVICE_CODE.VEHICLE_OPERATIONALLY_RESTRICTED,
          reasons: [{ code: "OPERATIONAL_RESTRICTION_ACTIVE" }]
        });
      }
    };
    const journeyService = new SubscriptionJourneyService(
      repository,
      prisma,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      restrictedEngine as never
    );

    const outcome = await journeyService.activateSubscriptionJob({
      attemptCount: 1,
      availableAt: new Date(),
      completedAt: null,
      createdAt: new Date(),
      id: `${FIXTURE_PREFIX}-activation-job`,
      jobType: SubscriptionJourneyJobType.ACTIVATE_SUBSCRIPTION,
      journeyId: journey.journeyId,
      lastErrorCode: null,
      lastErrorMessage: null,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      leaseToken: `${FIXTURE_PREFIX}-lease`,
      maxAttempts: 5,
      payload: { finalPlanRevision: 7, orderId: fixture.orderId },
      sourceKey: `${FIXTURE_PREFIX}:activation`,
      status: SubscriptionJourneyJobStatus.PROCESSING,
      stepId: journey.stepId,
      updatedAt: new Date()
    });

    expect(outcome).toMatchObject({
      action: "SUBSCRIPTION_ACTIVATION_WAITING_OPERATIONAL_CLEARANCE",
      journeyId: journey.journeyId,
      orderId: fixture.orderId
    });
    await expect(
      prisma.subscriptionJourney.findUnique({ where: { id: journey.journeyId } })
    ).resolves.toMatchObject({
      currentStepStatus: SubscriptionJourneyStepStatus.RUNNING,
      pausedFromStatus: SubscriptionJourneyStatus.RUNNING,
      status: SubscriptionJourneyStatus.PAUSED,
      version: 1
    });
    await expect(
      prisma.subscriptionJourneyStep.findUnique({ where: { id: journey.stepId } })
    ).resolves.toMatchObject({ status: SubscriptionJourneyStepStatus.RUNNING });
    await expect(
      prisma.subscriptionJourneyEvent.count({
        where: { eventType: "JOURNEY_PAUSED", journeyId: journey.journeyId }
      })
    ).resolves.toBe(1);
    await expect(
      prisma.subscriptionJourneyOutbox.count({
        where: { eventType: "JOURNEY_PAUSED", journeyId: journey.journeyId }
      })
    ).resolves.toBe(1);
  });

  it("filters blockers and open periods at the production Portal catalog boundary", async () => {
    const allowedId = await createVehicleFixture(prisma, VehicleStatus.AVAILABLE, "portal-allowed");
    const blockedId = await createVehicleFixture(prisma, VehicleStatus.AVAILABLE, "portal-blocked");
    const occupiedId = await createVehicleFixture(
      prisma,
      VehicleStatus.AVAILABLE,
      "portal-occupied"
    );
    await createRestriction(prisma, blockedId, {
      scope: VehicleOperationalRestrictionScope.ALLOCATION,
      severity: VehicleOperationalRestrictionSeverity.BLOCKING
    });
    const occupiedOrder = await createHandoverFixture(prisma, occupiedId);
    await createOpenPeriod(prisma, occupiedId, occupiedOrder.orderId);

    const vehicles = await portalCatalogService.listVehicles();
    const expectedFixtureIds: string[] = [allowedId, blockedId, occupiedId];
    const fixtureIds = vehicles.map(({ id }) => id).filter((id) => expectedFixtureIds.includes(id));

    expect(fixtureIds).toEqual([allowedId]);
    await expect(portalCatalogService.getVehicle(blockedId)).rejects.toMatchObject({ status: 404 });
    await expect(portalCatalogService.getVehicle(occupiedId)).rejects.toMatchObject({
      status: 404
    });
  });

  it("re-evaluates a held restriction create at the production Customer writer", async () => {
    const vehicleId = await createVehicleFixture(
      prisma,
      VehicleStatus.AVAILABLE,
      "customer-held-create"
    );
    const customerBoundary = await createCustomerBoundary(prisma, service, vehicleId, userId);
    const reached = deferred<void>();
    const release = deferred<void>();
    const holder = readCommitted(prisma, async (tx) => {
      await lockVehicleForRestriction(tx, vehicleId);
      await createRestriction(tx, vehicleId, {
        scope: VehicleOperationalRestrictionScope.ALLOCATION,
        severity: VehicleOperationalRestrictionSeverity.BLOCKING
      });
      reached.resolve();
      await release.promise;
    });
    void holder.catch(reached.reject);
    await reached.promise;

    const boundary = settled(customerBoundary.invoke());
    try {
      const waiting = await waitForVehicleAuthorityLock(prisma);
      if (!waiting) {
        const early = await Promise.race([
          boundary,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 20))
        ]);
        throw new Error(
          `Customer boundary settled before authority lock: ${describeSettlement(early)}`
        );
      }
    } finally {
      release.resolve();
    }
    await holder;

    const result = await boundary;
    expect(result.status).toBe("rejected");
    expectConflict(
      rejectedValue(result),
      ASSET_OPERATION_SERVICE_CODE.VEHICLE_OPERATIONALLY_RESTRICTED
    );
    expect(customerBoundary.writeCount()).toBe(0);
    await expect(prisma.vehicle.findUnique({ where: { id: vehicleId } })).resolves.toMatchObject({
      status: VehicleStatus.AVAILABLE
    });
  });

  it("blocks an open period at the production Product writer before quote or vehicle writes", async () => {
    const vehicleId = await createVehicleFixture(
      prisma,
      VehicleStatus.AVAILABLE,
      "product-open-period"
    );
    const { orderId } = await createHandoverFixture(prisma, vehicleId);
    await createOpenPeriod(prisma, vehicleId, orderId);
    const productBoundary = createProductBoundary(prisma, service, vehicleId, userId);

    expectConflict(
      await rejected(productBoundary.invoke()),
      ASSET_OPERATION_SERVICE_CODE.VEHICLE_NOT_AVAILABLE
    );
    expect(productBoundary.writeCount()).toBe(0);
    await expect(prisma.vehicle.findUnique({ where: { id: vehicleId } })).resolves.toMatchObject({
      status: VehicleStatus.AVAILABLE
    });
  });

  it("commits the production Product writer only after a held restriction release", async () => {
    const vehicleId = await createVehicleFixture(
      prisma,
      VehicleStatus.AVAILABLE,
      "product-held-release"
    );
    const restrictionId = await createRestriction(prisma, vehicleId, {
      scope: VehicleOperationalRestrictionScope.ALLOCATION,
      severity: VehicleOperationalRestrictionSeverity.BLOCKING
    });
    const productBoundary = createProductBoundary(prisma, service, vehicleId, userId);
    const reached = deferred<void>();
    const release = deferred<void>();
    const holder = readCommitted(prisma, async (tx) => {
      await lockVehicleForRestriction(tx, vehicleId);
      await releaseRestriction(tx, restrictionId, userId);
      reached.resolve();
      await release.promise;
    });
    void holder.catch(reached.reject);
    await reached.promise;

    const boundary = productBoundary.invoke();
    try {
      expect(await waitForVehicleAuthorityLock(prisma)).toBe(true);
    } finally {
      release.resolve();
    }
    await holder;
    await boundary;

    expect(productBoundary.writeCount()).toBe(1);
    await expect(prisma.vehicle.findUnique({ where: { id: vehicleId } })).resolves.toMatchObject({
      status: VehicleStatus.RESERVED
    });
  });

  it.each(["cancel", "reject"] as const)(
    "blocks the production Customer %s release before application and vehicle writes",
    async (operation) => {
      const vehicleId = await createVehicleFixture(
        prisma,
        VehicleStatus.REVIEW_RESERVED,
        `customer-${operation}-release`
      );
      await createRestriction(prisma, vehicleId, {
        scope: VehicleOperationalRestrictionScope.INVENTORY_RELEASE,
        severity: VehicleOperationalRestrictionSeverity.BLOCKING
      });
      const boundary = createCustomerReleaseBoundary(prisma, service, vehicleId, userId, operation);

      expectConflict(
        await rejected(boundary.invoke()),
        ASSET_OPERATION_SERVICE_CODE.VEHICLE_OPERATIONALLY_RESTRICTED
      );
      expect(boundary.writeCount()).toBe(0);
      await expect(prisma.vehicle.findUnique({ where: { id: vehicleId } })).resolves.toMatchObject({
        status: VehicleStatus.REVIEW_RESERVED
      });
    }
  );

  it.each([
    { initialStatus: VehicleStatus.REVIEW_RESERVED, surface: "journey-order" },
    { initialStatus: VehicleStatus.AVAILABLE, surface: "journey-allocation" },
    { initialStatus: VehicleStatus.AVAILABLE, surface: "self-service-application" }
  ] as const)(
    "blocks the production Customer $surface boundary before its first write",
    async ({ initialStatus, surface }) => {
      const vehicleId = await createVehicleFixture(prisma, initialStatus, `customer-${surface}`);
      await createRestriction(prisma, vehicleId, {
        scope: VehicleOperationalRestrictionScope.ALLOCATION,
        severity: VehicleOperationalRestrictionSeverity.BLOCKING
      });
      const boundary = await createCustomerGuardSurfaceBoundary(
        prisma,
        service,
        vehicleId,
        userId,
        surface
      );

      expectConflict(
        await rejected(boundary.invoke()),
        ASSET_OPERATION_SERVICE_CODE.VEHICLE_OPERATIONALLY_RESTRICTED
      );
      expect(boundary.writeCount()).toBe(0);
      await expect(prisma.vehicle.findUnique({ where: { id: vehicleId } })).resolves.toMatchObject({
        status: initialStatus
      });
    }
  );

  it.each([
    { initialStatus: VehicleStatus.REVIEW_RESERVED, stage: "pre-order" },
    { initialStatus: VehicleStatus.RESERVED, stage: "post-order" }
  ] as const)(
    "blocks the production Journey $stage cancellation before business writes",
    async ({ initialStatus, stage }) => {
      const boundary = await createJourneyCancellationBoundary(
        prisma,
        service,
        userId,
        stage,
        initialStatus
      );

      expectConflict(
        await rejected(boundary.invoke()),
        ASSET_OPERATION_SERVICE_CODE.VEHICLE_OPERATIONALLY_RESTRICTED
      );
      expect(boundary.writeCount()).toBe(0);
      await expect(
        prisma.vehicle.findUnique({ where: { id: boundary.vehicleId } })
      ).resolves.toMatchObject({ status: initialStatus });
    }
  );
});

async function runBoundary(
  prisma: PrismaService,
  service: AssetOperationsService,
  vehicleId: string,
  purpose: VehicleAvailabilityPurpose
) {
  return readCommitted(prisma, async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      /* vehicle-availability-boundary-lock */
      SELECT "id" FROM "vehicle" WHERE "id" = ${vehicleId}::uuid FOR UPDATE
    `);
    await service.assertVehicleAvailable(tx, vehicleId, purpose, AS_OF);
    return tx.vehicle.update({
      data:
        purpose === VehicleAvailabilityPurpose.ALLOCATION
          ? { status: VehicleStatus.REVIEW_RESERVED }
          : purpose === VehicleAvailabilityPurpose.MARK_AVAILABLE
            ? { status: VehicleStatus.AVAILABLE }
            : { brand: `${FIXTURE_PREFIX}-delivered` },
      where: { id: vehicleId }
    });
  });
}

async function createVehicleFixture(prisma: PrismaService, status: VehicleStatus, label: string) {
  const id = randomUUID();
  const modelDefinitionId = randomUUID();
  const token = randomUUID().replaceAll("-", "").slice(0, 8);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "vehicle_model_definition" (
        "id", "model_code", "brand", "model_name", "display_name",
        "enabled", "portal_visible", "created_at", "updated_at"
      ) VALUES (
        ${modelDefinitionId}::uuid, ${`${FIXTURE_PREFIX}-${label}-${token}`}, 'NIO',
        'Stage 1C-B fixture', 'Stage 1C-B fixture', true, true,
        clock_timestamp(), clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "vehicle" (
        "id", "vehicle_no", "plate_no", "brand", "model_definition_id",
        "purchase_price_amount", "current_sale_price_amount", "sale_price_status",
        "status", "created_at", "updated_at"
      ) VALUES (
        ${id}::uuid, ${`${FIXTURE_PREFIX}-${label}-${token}`}, ${`沪C${token}`}, 'NIO',
        ${modelDefinitionId}::uuid, 20000000, 18000000, ${SalePriceStatus.EFFECTIVE}::"sale_price_status",
        ${status}::"vehicle_status", clock_timestamp(), clock_timestamp()
      )
    `);
  });
  return id;
}

async function createOpenPeriod(prisma: PrismaService, vehicleId: string, orderId: string) {
  const id = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "vehicle_subscription_period" (
        "id", "vehicle_id", "order_id", "customer_id", "started_at", "start_reason",
        "start_source_type", "start_source_id", "start_source_key", "start_snapshot",
        "created_at", "updated_at"
      ) VALUES (
        ${id}::uuid, ${vehicleId}::uuid, ${orderId}::uuid, ${randomUUID()}::uuid,
        clock_timestamp() - interval '1 hour', 'DELIVERY_CONFIRMED'::"vehicle_subscription_period_start_reason",
        'STAGE1C_TASK6_TEST', ${randomUUID()}::uuid, ${`${FIXTURE_PREFIX}:period:${id}`},
        '{}'::jsonb, clock_timestamp(), clock_timestamp()
      )
    `);
  });
}

async function createHandoverFixture(prisma: PrismaService, vehicleId: string) {
  const orderId = randomUUID();
  const applicationId = randomUUID();
  const workOrderId = randomUUID();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "subscription_order" (
        "id", "order_no", "customer_id", "application_id", "quote_id",
        "product_id", "product_version_id", "vehicle_id",
        "vehicle_purchase_price_amount", "monthly_fee_amount", "deposit_amount",
        "period_months", "mileage_limit_km", "over_mileage_fee_amount",
        "model_definition_id_snapshot", "model_code_snapshot", "model_display_name_snapshot",
        "quote_snapshot", "created_at", "updated_at"
      ) VALUES (
        ${orderId}::uuid, ${`${FIXTURE_PREFIX}-order-${suffix}`}, ${randomUUID()}::uuid,
        ${applicationId}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
        ${randomUUID()}::uuid, ${vehicleId}::uuid, 20000000, 500000, 1000000,
        12, 20000, 100, ${randomUUID()}::uuid, 'S1CB', 'Stage 1C-B fixture',
        '{}'::jsonb, clock_timestamp(), clock_timestamp()
      )
    `);
    await tx.vehicleHandoverWorkOrder.create({
      data: {
        externalOperatorName: "Task 6 Field Operator",
        externalOperatorPhone: "13800138000",
        fieldOperatorName: "Task 6 Field Operator",
        fieldOperatorPhone: "13800138000",
        handoverType: "DELIVERY_OUTBOUND",
        id: workOrderId,
        operatorType: "EXTERNAL",
        orderId,
        status: "DRAFT"
      }
    });
  });
  return { applicationId, orderId, workOrderId };
}

async function createActivationJourneyFixture(
  prisma: PrismaService,
  applicationId: string,
  orderId: string,
  salesUserId: string
) {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "application" (
        "id", "application_no", "customer_id", "sales_user_id", "final_plan_revision",
        "created_at", "updated_at"
      ) VALUES (
        ${applicationId}::uuid, ${`${FIXTURE_PREFIX}-application-${suffix}`}, ${randomUUID()}::uuid,
        ${salesUserId}::uuid, 7, clock_timestamp(), clock_timestamp()
      )
    `);
  });
  const created = await prisma.subscriptionJourney.create({
    data: {
      applicationId,
      currentStepCode: SubscriptionJourneyStepCode.AUTHORITATIVE_ACTIVATION,
      currentStepStatus: SubscriptionJourneyStepStatus.RUNNING,
      orderId,
      status: SubscriptionJourneyStatus.RUNNING,
      steps: {
        create: {
          code: SubscriptionJourneyStepCode.AUTHORITATIVE_ACTIVATION,
          startedAt: new Date(),
          status: SubscriptionJourneyStepStatus.RUNNING
        }
      }
    },
    include: { steps: true }
  });
  return { journeyId: created.id, stepId: created.steps[0]!.id };
}

async function activationResidue(prisma: PrismaService, orderId: string) {
  const [auditLogs, leases, mileageReadings, mileageReviews, periods] = await Promise.all([
    prisma.auditLog.count({ where: { entityId: orderId } }),
    prisma.lease.count({ where: { orderId } }),
    prisma.vehicleMileageReading.count({ where: { orderId } }),
    prisma.orderMileageReview.count({ where: { orderId } }),
    prisma.vehicleSubscriptionPeriod.count({ where: { orderId } })
  ]);
  return { auditLogs, leases, mileageReadings, mileageReviews, periods };
}

async function createCustomerBoundary(
  prisma: PrismaService,
  assetOperationsService: AssetOperationsService,
  vehicleId: string,
  actorId: string
) {
  const vehicle = await prisma.vehicle.findUniqueOrThrow({
    include: { modelDefinition: true },
    where: { id: vehicleId }
  });
  const applicationId = randomUUID();
  const application = {
    applicationNo: `${FIXTURE_PREFIX}-customer-boundary`,
    applicationSource: "SALES_ASSISTED",
    creditReviewStatus: "APPROVED",
    customerGrade: "A",
    customerId: randomUUID(),
    customerSelectedSnapshot: null,
    deletedAt: null,
    depositRuleSnapshot: {},
    depositStatus: "CONFIRMED",
    finalDepositAmount: 100000n,
    finalPeriodMonths: 12,
    finalPlanConfirmedAt: new Date(),
    finalPlanSnapshot: { subscriptionPlanId: "plan", vehicleId },
    finalSubscriptionPlanId: "plan",
    finalVehicleId: vehicleId,
    id: applicationId,
    intentPeriodMonths: 12,
    intentSubscriptionPlanId: "plan",
    intentVehicleId: vehicleId,
    materialReviewStatus: "APPROVED",
    orders: [],
    planConfirmStatus: "CONFIRMED",
    productReviewStatus: "APPROVED",
    salesUserId: actorId,
    softReservedVehicleId: null,
    status: "APPROVED",
    vehicleReviewStatus: "APPROVED"
  };
  const plan = buildBoundaryPlan(vehicle);
  let writes = 0;
  const prismaFacade = {
    application: { findUnique: async () => application },
    $transaction: <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) =>
      prisma.$transaction((realTx) =>
        callback(
          transactionProxy(realTx, {
            subscriptionPlan: { findUnique: async () => plan },
            subscriptionOrder: {
              create: async () => {
                writes += 1;
                throw new Error("Unexpected order write in blocked Customer boundary.");
              }
            },
            subscriptionQuote: {
              create: async () => {
                writes += 1;
                throw new Error("Unexpected quote write in blocked Customer boundary.");
              }
            }
          })
        )
      )
  };
  const customerService = new CustomerService(
    { write: async () => undefined } as never,
    prismaFacade as never,
    {} as never,
    {} as never,
    undefined,
    undefined,
    assetOperationsService
  );
  const user = boundaryUser(actorId);
  return {
    invoke: () =>
      customerService.createOrderFromApplication(applicationId, user as never, {
        ipAddress: "127.0.0.1",
        userAgent: "vitest"
      }),
    writeCount: () => writes
  };
}

function buildBoundaryPlan(vehicle: { modelDefinition: unknown; modelDefinitionId: string }) {
  const packageBase = {
    deletedAt: null,
    productId: "product",
    productVersionId: "version",
    status: "ACTIVE"
  };
  return {
    baseMonthlyFeeAmount: null,
    benefitPackage: null,
    benefitPackageId: null,
    deletedAt: null,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: null,
    energyPackage: {
      ...packageBase,
      id: "energy",
      monthlyEnergyCount: 6,
      monthlyEnergyKwh: null,
      packageName: "Energy",
      packageNo: "ENERGY",
      priceAmount: 80000n
    },
    energyPackageId: "energy",
    id: "plan",
    maxPeriodMonths: 36,
    mileagePackage: {
      ...packageBase,
      id: "mileage",
      monthlyMileageKm: 1500,
      overMileageFeeAmount: 100n,
      packageName: "Mileage",
      packageNo: "MILEAGE",
      priceAmount: 120000n
    },
    mileagePackageId: "mileage",
    minPeriodMonths: 6,
    monthlyFeeCapRate: null,
    monthlyFeeMode: "RATE_FORMULA",
    monthlyFeeRate: new Prisma.Decimal("0.035"),
    planName: "Plan",
    planNo: "PLAN",
    product: {
      deletedAt: null,
      id: "product",
      productType: "SUBSCRIPTION",
      status: "ACTIVE"
    },
    productId: "product",
    productVersion: {
      deletedAt: null,
      id: "version",
      productId: "product",
      status: "ACTIVE"
    },
    productVersionId: "version",
    status: "ACTIVE",
    vehiclePackage: {
      ...packageBase,
      configName: "Standard",
      id: "vehicle-package",
      maxPurchasePriceAmount: null,
      minPurchasePriceAmount: null,
      modelDefinition: vehicle.modelDefinition,
      modelDefinitionId: vehicle.modelDefinitionId,
      monthlyFeeRate: new Prisma.Decimal("0.035"),
      packageName: "Vehicle",
      packageNo: "VEHICLE"
    },
    vehiclePackageId: "vehicle-package"
  };
}

function createProductBoundary(
  prisma: PrismaService,
  assetOperationsService: AssetOperationsService,
  vehicleId: string,
  actorId: string
) {
  const now = new Date();
  const quote = {
    application: {
      applicationNo: "APP",
      id: randomUUID(),
      salesUserId: actorId,
      status: "APPROVED"
    },
    applicationId: randomUUID(),
    benefitPackage: null,
    benefitPackageId: null,
    benefitPackagePriceAmount: null,
    cancelledAt: null,
    confirmedAt: null as Date | null,
    confirmedBy: null as string | null,
    confirmer: null,
    createdAt: now,
    customer: { grade: "A", id: randomUUID(), mobile: "13800000000", name: "Customer" },
    customerId: randomUUID(),
    customerSelectedSnapshot: null,
    deletedAt: null,
    depositAmount: 500000n,
    depositRuleSnapshot: null,
    energyLimitCount: null,
    energyLimitKwh: null,
    energyPackage: null,
    energyPackageId: null,
    energyPackagePriceAmount: null,
    expiredAt: null,
    id: randomUUID(),
    mileageLimitKm: 1500,
    mileagePackage: null,
    mileagePackageId: null,
    mileagePackagePriceAmount: null,
    modelCodeSnapshot: "S1CB",
    modelDefinitionIdSnapshot: randomUUID(),
    modelDisplayNameSnapshot: "Stage 1C-B",
    monthlyFeeAmount: 420000n,
    monthlyFeeCapAmount: 420000n,
    monthlyFeeRate: new Prisma.Decimal("0.035"),
    order: null,
    overMileageFeeAmount: 100n,
    packageSnapshot: null,
    periodMonths: 12,
    productId: randomUUID(),
    productVersion: { id: randomUUID(), product: {}, versionNo: "V1" },
    productVersionId: randomUUID(),
    quoteNo: `${FIXTURE_PREFIX}-quote`,
    riskResultId: null,
    status: "DRAFT",
    subscriptionPlan: null,
    subscriptionPlanId: null,
    updatedAt: now,
    updatedBy: actorId,
    vehicle: null,
    vehicleBaseFeeAmount: null,
    vehicleBaseFeeCapAmount: null,
    vehicleId,
    vehiclePackage: null,
    vehiclePackageId: null,
    vehiclePurchasePriceAmount: 12000000n,
    vehicleSalePriceAmount: null,
    vehicleSnapshot: null
  };
  let writes = 0;
  const subscriptionQuote = {
    findUnique: async () => quote,
    update: async ({ data }: { data: Record<string, unknown> }) => {
      writes += 1;
      Object.assign(quote, data);
      return quote;
    }
  };
  const prismaFacade = {
    subscriptionQuote,
    $transaction: <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) =>
      prisma.$transaction((realTx) => callback(transactionProxy(realTx, { subscriptionQuote })))
  };
  const productService = new ProductService(
    { write: async () => undefined } as never,
    prismaFacade as never,
    assetOperationsService
  );
  return {
    invoke: () =>
      productService.confirmQuote(quote.id, boundaryUser(actorId) as never, {
        ipAddress: "127.0.0.1",
        userAgent: "vitest"
      }),
    writeCount: () => writes
  };
}

function createCustomerReleaseBoundary(
  prisma: PrismaService,
  assetOperationsService: AssetOperationsService,
  vehicleId: string,
  actorId: string,
  operation: "cancel" | "reject"
) {
  const application = {
    applicationNo: `${FIXTURE_PREFIX}-${operation}`,
    customerId: randomUUID(),
    deletedAt: null,
    id: randomUUID(),
    orders: [],
    salesUserId: actorId,
    softReservedVehicleId: vehicleId,
    status: "SUBMITTED"
  };
  let writes = 0;
  const blockedWrites = {
    update: async () => {
      writes += 1;
      throw new Error(`Unexpected ${operation} write after blocked release.`);
    }
  };
  const prismaFacade = {
    application: { findUnique: async () => application },
    $transaction: <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) =>
      prisma.$transaction((realTx) =>
        callback(
          transactionProxy(realTx, {
            application: blockedWrites,
            applicationActionLog: { create: blockedWrites.update },
            customer: blockedWrites
          })
        )
      )
  };
  const customerService = new CustomerService(
    { write: async () => undefined } as never,
    prismaFacade as never,
    {} as never,
    {} as never,
    undefined,
    undefined,
    assetOperationsService
  );
  const user = boundaryUser(actorId) as never;
  const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };
  return {
    invoke: () =>
      operation === "cancel"
        ? customerService.cancelApplication(application.id, { reason: "Task 6" }, user, context)
        : customerService.rejectApplication(application.id, { reason: "Task 6" }, user, context),
    writeCount: () => writes
  };
}

async function createCustomerGuardSurfaceBoundary(
  prisma: PrismaService,
  assetOperationsService: AssetOperationsService,
  vehicleId: string,
  actorId: string,
  surface: "journey-allocation" | "journey-order" | "self-service-application"
) {
  const vehicle = await prisma.vehicle.findUniqueOrThrow({
    include: { modelDefinition: true },
    where: { id: vehicleId }
  });
  const applicationId = randomUUID();
  const customerId = randomUUID();
  const application = {
    applicationNo: `${FIXTURE_PREFIX}-${surface}`,
    applicationSource: "SELF_SERVICE",
    creditReviewStatus: "APPROVED",
    customerConfirmedPlanRevision: 1,
    customerGrade: "A",
    customerId,
    customerSelectedSnapshot: null,
    deletedAt: null,
    depositRuleSnapshot: {},
    depositStatus: "CONFIRMED",
    finalDepositAmount: 100000n,
    finalPeriodMonths: 12,
    finalPlanConfirmedAt: new Date(),
    finalPlanRevision: 1,
    finalPlanSnapshot: { subscriptionPlanId: "plan", vehicleId },
    finalSubscriptionPlanId: "plan",
    finalVehicleId: vehicleId,
    id: applicationId,
    intentPeriodMonths: 12,
    intentSubscriptionPlanId: "plan",
    intentVehicleId: vehicleId,
    materialReviewStatus: "APPROVED",
    orders: [],
    planConfirmStatus: "CONFIRMED",
    productReviewStatus: "APPROVED",
    salesUserId: actorId,
    softReservedAt: null,
    softReservedVehicleId: surface === "journey-order" ? vehicleId : null,
    status: "APPROVED",
    vehicleReviewStatus: "APPROVED"
  };
  const customer = {
    deletedAt: null,
    id: customerId,
    identity: { idCardNo: "11010519491231002X" },
    mobile: "13800000000",
    name: "Task 6 Customer",
    ownerUserId: actorId,
    profile: {
      emergencyContactMobile: "13900000000",
      emergencyContactName: "Emergency Contact",
      residenceCity: "Shanghai",
      residenceDetail: "1554 Lane",
      residenceDistrict: "Minhang",
      residenceProvince: "Shanghai"
    },
    status: "LEAD"
  };
  const plan = buildBoundaryPlan(vehicle);
  let writes = 0;
  const blockedWrite = async () => {
    writes += 1;
    throw new Error(`Unexpected write in blocked ${surface} boundary.`);
  };
  const txOverrides = {
    application: {
      create: blockedWrite,
      findUnique: async () => application,
      update: blockedWrite
    },
    applicationActionLog: { create: blockedWrite },
    customer: {
      findUniqueOrThrow: async () => customer,
      update: blockedWrite
    },
    subscriptionOrder: {
      count: async () => 0,
      create: blockedWrite,
      findUnique: async () => null
    },
    subscriptionPlan: { findUnique: async () => plan },
    subscriptionQuote: { create: blockedWrite }
  };
  const prismaFacade = {
    application: { findUnique: async () => application },
    customer: { findUnique: async () => customer },
    subscriptionPlan: { findUnique: async () => plan },
    vehicle: prisma.vehicle,
    $transaction: <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) =>
      prisma.$transaction((realTx) => callback(transactionProxy(realTx, txOverrides)))
  };
  if (surface !== "self-service-application") {
    await createRawApplicationFixture(prisma, applicationId, customerId, actorId, surface);
  }
  const customerService = new CustomerService(
    { write: async () => undefined } as never,
    prismaFacade as never,
    {} as never,
    {} as never,
    undefined,
    undefined,
    assetOperationsService
  );
  const user = boundaryUser(actorId) as never;
  const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };
  return {
    invoke: () => {
      if (surface === "self-service-application") {
        return customerService.createSelfServiceApplication(
          {
            customerId,
            periodMonths: 12,
            subscriptionPlanId: "plan",
            vehicleId
          },
          user,
          context
        );
      }
      if (surface === "journey-order") {
        return prismaFacade.$transaction((tx) =>
          customerService.createOrderFromApplicationInTransaction(tx, applicationId, user, context)
        );
      }
      return prismaFacade.$transaction((tx) =>
        customerService.allocateJourneyVehicle(tx, applicationId, vehicleId, user, context)
      );
    },
    writeCount: () => writes
  };
}

async function createRawApplicationFixture(
  prisma: PrismaService,
  applicationId: string,
  customerId: string,
  salesUserId: string,
  label: string
) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "application" (
        "id", "application_no", "customer_id", "sales_user_id", "created_at", "updated_at"
      ) VALUES (
        ${applicationId}::uuid, ${`${FIXTURE_PREFIX}-application-${label}-${randomUUID().slice(0, 8)}`},
        ${customerId}::uuid, ${salesUserId}::uuid, clock_timestamp(), clock_timestamp()
      )
    `);
  });
}

async function createJourneyCancellationBoundary(
  prisma: PrismaService,
  assetOperationsService: AssetOperationsService,
  actorId: string,
  stage: "post-order" | "pre-order",
  initialStatus: VehicleStatus
) {
  const vehicleId = await createVehicleFixture(prisma, initialStatus, `journey-${stage}-cancel`);
  let applicationId: string;
  let orderId: string | null = null;
  if (stage === "post-order") {
    const fixture = await createHandoverFixture(prisma, vehicleId);
    applicationId = fixture.applicationId;
    orderId = fixture.orderId;
  } else {
    applicationId = randomUUID();
  }
  const customerId = randomUUID();
  await createRawApplicationFixture(prisma, applicationId, customerId, actorId, `journey-${stage}`);
  const journey = await prisma.subscriptionJourney.create({
    data: {
      applicationId,
      currentStepCode: SubscriptionJourneyStepCode.APPLICATION_VALIDATION,
      currentStepStatus: SubscriptionJourneyStepStatus.RUNNING,
      orderId,
      status: SubscriptionJourneyStatus.RUNNING
    }
  });
  await createRestriction(prisma, vehicleId, {
    scope: VehicleOperationalRestrictionScope.INVENTORY_RELEASE,
    severity: VehicleOperationalRestrictionSeverity.BLOCKING
  });
  const adminJourney = {
    application: {
      applicationNo: `${FIXTURE_PREFIX}-journey-${stage}`,
      applicationSource: "SELF_SERVICE",
      customerId,
      finalPlanRevision: 1,
      finalPlanSnapshot: {},
      finalVehicleId: vehicleId,
      id: applicationId,
      softReservedVehicleId: stage === "pre-order" ? vehicleId : null,
      status: "APPROVED"
    },
    applicationId,
    currentStepCode: SubscriptionJourneyStepCode.APPLICATION_VALIDATION,
    currentStepStatus: SubscriptionJourneyStepStatus.RUNNING,
    events: [],
    exceptions: [],
    id: journey.id,
    jobs: [],
    manualTasks: [],
    order:
      stage === "post-order"
        ? {
            contract: null,
            id: orderId,
            orderNo: `${FIXTURE_PREFIX}-order`,
            orderStatus: "PENDING_CONTRACT",
            vehicleId
          }
        : null,
    orderId,
    pausedFromStatus: null,
    status: SubscriptionJourneyStatus.RUNNING,
    steps: [],
    version: 0
  };
  let writes = 0;
  const blockedWrite = async () => {
    writes += 1;
    throw new Error(`Unexpected write in blocked Journey ${stage} cancellation.`);
  };
  const subscriptionJourney = {
    findUnique: async () => adminJourney,
    updateMany: blockedWrite
  };
  const prismaFacade = {
    $transaction: <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) =>
      prisma.$transaction((realTx) =>
        callback(
          transactionProxy(realTx, {
            application: { update: blockedWrite },
            contract: { updateMany: blockedWrite },
            subscriptionJourney,
            subscriptionOrder: {
              count: async () => 0,
              update: blockedWrite
            },
            vehicle: realVehicleProxy(realTx, blockedWrite)
          })
        )
      )
  };
  const journeyService = new SubscriptionJourneyService(
    new SubscriptionJourneyRepository(),
    prismaFacade as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    assetOperationsService
  );
  return {
    invoke: () =>
      journeyService.cancelJourney(
        journey.id,
        { reason: "Task 6 blocked cancellation", version: 0 },
        boundaryUser(actorId) as never,
        { ipAddress: "127.0.0.1", userAgent: "vitest" }
      ),
    vehicleId,
    writeCount: () => writes
  };
}

function realVehicleProxy(tx: Prisma.TransactionClient, blockedWrite: () => Promise<never>) {
  return new Proxy(tx.vehicle, {
    get(target, property, receiver) {
      if (property === "update" || property === "updateMany") return blockedWrite;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function transactionProxy(tx: Prisma.TransactionClient, overrides: Record<string, unknown>) {
  return new Proxy(tx, {
    get(target, property, receiver) {
      if (typeof property === "string" && property in overrides) return overrides[property];
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function boundaryUser(actorId: string) {
  return {
    id: actorId,
    menus: [],
    name: "Task 6 Operator",
    permissions: [],
    roles: ["ADMIN"],
    username: `${FIXTURE_PREFIX}-operator`
  };
}

async function createRestriction(
  db: Prisma.TransactionClient | PrismaService,
  vehicleId: string,
  options: {
    scope: VehicleOperationalRestrictionScope;
    severity: VehicleOperationalRestrictionSeverity;
  }
) {
  const id = randomUUID();
  return (
    await db.vehicleOperationalRestriction.create({
      data: {
        conditionsSnapshot: { fixture: FIXTURE_PREFIX },
        id,
        restrictionType: VehicleOperationalRestrictionType.OTHER,
        scopes: [options.scope],
        severity: options.severity,
        startSourceId: randomUUID(),
        startSourceKey: `${FIXTURE_PREFIX}:${id}`,
        startSourceType: "STAGE1C_TASK6_TEST",
        startedAt: new Date("2026-08-20T05:00:00.000Z"),
        vehicleId
      }
    })
  ).id;
}

async function releaseRestriction(
  db: Prisma.TransactionClient | PrismaService,
  restrictionId: string,
  releasedBy: string
) {
  return db.vehicleOperationalRestriction.update({
    data: {
      releaseReason: "Task 6 concurrency release",
      releaseSnapshot: { fixture: FIXTURE_PREFIX },
      releaseSourceId: randomUUID(),
      releaseSourceKey: `${FIXTURE_PREFIX}:release:${restrictionId}`,
      releaseSourceType: "STAGE1C_TASK6_TEST",
      releasedAt: new Date("2026-08-20T05:30:00.000Z"),
      releasedBy,
      status: VehicleOperationalRestrictionStatus.RELEASED
    },
    where: { id: restrictionId }
  });
}

async function createUserFixture(prisma: PrismaService) {
  return (
    await prisma.user.create({
      data: {
        name: "Task 6 Availability Operator",
        passwordHash: "not-used-by-test",
        username: `${FIXTURE_PREFIX.toLowerCase()}_operator`
      }
    })
  ).id;
}

async function lockVehicleForRestriction(tx: Prisma.TransactionClient, vehicleId: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "vehicle" WHERE "id" = ${vehicleId}::uuid FOR SHARE
  `);
}

async function listAvailableVehicleIds(prisma: PrismaService, asOf: Date) {
  const vehicles = await prisma.vehicle.findMany({
    select: { id: true },
    where: {
      currentSalePriceAmount: { gt: 0 },
      deletedAt: null,
      operationalRestrictions: {
        none: {
          scopes: { has: VehicleOperationalRestrictionScope.ALLOCATION },
          severity: VehicleOperationalRestrictionSeverity.BLOCKING,
          startedAt: { lte: asOf },
          status: VehicleOperationalRestrictionStatus.ACTIVE
        }
      },
      salePriceStatus: SalePriceStatus.EFFECTIVE,
      status: VehicleStatus.AVAILABLE,
      subscriptionPeriods: {
        none: {
          OR: [{ endedAt: null }, { endedAt: { gt: asOf } }],
          startedAt: { lte: asOf }
        }
      },
      vehicleNo: { startsWith: FIXTURE_PREFIX }
    }
  });
  return vehicles.map(({ id }) => id);
}

function readCommitted<T>(
  prisma: PrismaService,
  work: (tx: Prisma.TransactionClient) => Promise<T>
) {
  return prisma.$transaction(work, {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    maxWait: 5_000,
    timeout: 15_000
  });
}

async function waitForBoundaryLock(prisma: PrismaService) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [status] = await prisma.$queryRaw<Array<{ waiting: boolean }>>(Prisma.sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE "pid" <> pg_backend_pid()
          AND "datname" = current_database()
          AND "state" = 'active'
          AND "wait_event_type" = 'Lock'
          AND "query" ILIKE '%vehicle-availability-boundary-lock%'
      ) AS "waiting"
    `);
    if (status?.waiting) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function waitForVehicleAuthorityLock(prisma: PrismaService) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [status] = await prisma.$queryRaw<Array<{ waiting: boolean }>>(Prisma.sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE "pid" <> pg_backend_pid()
          AND "datname" = current_database()
          AND "state" = 'active'
          AND "wait_event_type" = 'Lock'
      ) AS "waiting"
    `);
    if (status?.waiting) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function deleteFixtures(prisma: PrismaService) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw`
      DELETE FROM "subscription_journey_outbox"
      WHERE "journey_id" IN (
        SELECT "id" FROM "subscription_journey" WHERE "application_id" IN (
          SELECT "id" FROM "application" WHERE "application_no" LIKE ${`${FIXTURE_PREFIX}%`}
        )
      )
    `;
    await tx.$executeRaw`
      DELETE FROM "subscription_journey_event"
      WHERE "journey_id" IN (
        SELECT "id" FROM "subscription_journey" WHERE "application_id" IN (
          SELECT "id" FROM "application" WHERE "application_no" LIKE ${`${FIXTURE_PREFIX}%`}
        )
      )
    `;
    await tx.$executeRaw`
      DELETE FROM "subscription_journey_step"
      WHERE "journey_id" IN (
        SELECT "id" FROM "subscription_journey" WHERE "application_id" IN (
          SELECT "id" FROM "application" WHERE "application_no" LIKE ${`${FIXTURE_PREFIX}%`}
        )
      )
    `;
    await tx.$executeRaw`
      DELETE FROM "subscription_journey"
      WHERE "application_id" IN (
        SELECT "id" FROM "application" WHERE "application_no" LIKE ${`${FIXTURE_PREFIX}%`}
      )
    `;
    await tx.$executeRaw`
      DELETE FROM "vehicle_handover_event"
      WHERE "order_id" IN (
        SELECT "id" FROM "subscription_order" WHERE "order_no" LIKE ${`${FIXTURE_PREFIX}%`}
      )
    `;
    await tx.$executeRaw`
      DELETE FROM "vehicle_handover_work_order"
      WHERE "order_id" IN (
        SELECT "id" FROM "subscription_order" WHERE "order_no" LIKE ${`${FIXTURE_PREFIX}%`}
      )
    `;
    await tx.$executeRaw`
      DELETE FROM "vehicle_subscription_period"
      WHERE "start_source_key" LIKE ${`${FIXTURE_PREFIX}%`}
    `;
    await tx.$executeRaw`
      DELETE FROM "subscription_order"
      WHERE "order_no" LIKE ${`${FIXTURE_PREFIX}%`}
    `;
    await tx.$executeRaw`
      DELETE FROM "application"
      WHERE "application_no" LIKE ${`${FIXTURE_PREFIX}%`}
    `;
    await tx.$executeRaw`
      DELETE FROM "vehicle_operational_restriction"
      WHERE "start_source_key" LIKE ${`${FIXTURE_PREFIX}%`}
    `;
    await tx.$executeRaw`
      DELETE FROM "vehicle"
      WHERE "vehicle_no" LIKE ${`${FIXTURE_PREFIX}%`}
    `;
    await tx.$executeRaw`
      DELETE FROM "vehicle_model_definition"
      WHERE "model_code" LIKE ${`${FIXTURE_PREFIX}%`}
    `;
    await tx.$executeRaw`
      DELETE FROM "user"
      WHERE "username" LIKE ${`${FIXTURE_PREFIX.toLowerCase()}%`}
    `;
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function settled<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (reason) {
    return { reason, status: "rejected" };
  }
}

async function rejected(promise: Promise<unknown>) {
  const result = await settled(promise);
  return rejectedValue(result);
}

function rejectedValue(result: PromiseSettledResult<unknown>) {
  if (result.status === "fulfilled") throw new Error("Expected rejection.");
  return result.reason;
}

function describeSettlement(result: PromiseSettledResult<unknown> | null) {
  if (!result) return "still pending";
  if (result.status === "fulfilled") return "fulfilled";
  const reason = result.reason;
  if (reason instanceof Error) return `${reason.constructor.name}: ${reason.message}`;
  return String(reason);
}

function expectConflict(error: unknown, code: string) {
  expect(error).toBeInstanceOf(ConflictException);
  expect((error as ConflictException).getResponse()).toMatchObject({ code });
}

function requiredTestDatabaseUrl(value = process.env.DATABASE_URL) {
  if (!value)
    throw new Error("DATABASE_URL is required for vehicle availability integration tests");
  const url = new URL(value);
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error("Vehicle availability integration tests require a loopback PostgreSQL host");
  }
  if (decodeURIComponent(url.pathname.slice(1)) !== "subscription_saas_codex") {
    throw new Error("Vehicle availability integration tests require the dedicated codex database");
  }
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.toString();
}

function isLoopbackHostname(hostname: string) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}
