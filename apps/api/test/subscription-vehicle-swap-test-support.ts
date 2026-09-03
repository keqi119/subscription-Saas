import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { AssetFactsRepository } from "../src/asset-facts/asset-facts.repository";
import { AssetFactsService } from "../src/asset-facts/asset-facts.service";
import { AssetOperationsRepository } from "../src/asset-operations/asset-operations.repository";
import { AssetOperationsService } from "../src/asset-operations/asset-operations.service";
import { AuditService } from "../src/audit/audit.service";
import { OrderEntitlementService } from "../src/order/order-entitlement.service";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  SubscriptionVehicleSwapActivationService,
  type VehicleSwapActivationFailureInjector
} from "../src/subscription-change/subscription-vehicle-swap-activation.service";
import {
  insertRuntimeContract,
  insertRuntimeOrderGraph,
  insertRuntimeSubscriptionPlan,
  insertRuntimeVehicle
} from "./helpers/runtime-domain-fixture";

export type VehicleSwapTestFixture = Awaited<ReturnType<typeof createVehicleSwapFixture>>;

export function requiredVehicleSwapTestDatabaseUrl(value: string | undefined) {
  if (!value) throw new Error("DATABASE_URL is required for vehicle-swap activation tests");
  const url = new URL(value);
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)) {
    throw new Error("Vehicle-swap activation tests require a loopback PostgreSQL host");
  }
  if (!url.pathname.toLowerCase().includes("test")) {
    throw new Error("Vehicle-swap activation tests require a test-only database");
  }
  return value;
}

export async function connectVehicleSwapTestPrisma(databaseUrl: string) {
  const prisma = new PrismaService(new ConfigService({ DATABASE_URL: databaseUrl }));
  await prisma.onModuleInit();
  return prisma;
}

export function createVehicleSwapActivationService(
  prisma: PrismaService,
  injector?: VehicleSwapActivationFailureInjector
) {
  const audit = new AuditService(prisma);
  return new SubscriptionVehicleSwapActivationService(
    prisma,
    audit,
    new AssetOperationsService(prisma, new AssetOperationsRepository(), audit),
    new AssetFactsService(prisma, new AssetFactsRepository(), audit),
    new OrderEntitlementService(),
    injector
  );
}

export async function createVehicleSwapFixture(
  prisma: PrismaService,
  options: { depositDelta?: bigint; monthlyFeeDelta?: bigint } = {}
) {
  const ids = {
    baseContractFileId: randomUUID(),
    baseContractId: randomUUID(),
    changeId: randomUUID(),
    conditionFileIds: [randomUUID(), randomUUID()],
    customerId: randomUUID(),
    entitlementAccountId: randomUUID(),
    futureGrantId: randomUUID(),
    orderId: randomUUID(),
    productId: randomUUID(),
    productVersionId: randomUUID(),
    quoteId: randomUUID(),
    signedFileIds: [randomUUID(), randomUUID()],
    sourcePeriodId: randomUUID(),
    sourceSegmentId: randomUUID(),
    sourceVehicleId: randomUUID(),
    supplementContractFileId: randomUUID(),
    supplementContractId: randomUUID(),
    targetPlanId: randomUUID(),
    targetVehicleId: randomUUID(),
    vehiclePackageId: randomUUID()
  };
  const now = new Date();
  const targetDepositAmount = 1000n + (options.depositDelta ?? 0n);
  const targetMonthlyFeeAmount = 100000n + (options.monthlyFeeDelta ?? 0n);
  const plannedSwapAt = new Date(now.getTime() - 60_000);
  const futureGrantStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const futureGrantEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 0));

  await prisma.$transaction(async (tx) => {
    await insertRuntimeOrderGraph(tx, {
      applicationId: randomUUID(),
      customerId: ids.customerId,
      label: "VEHICLE-SWAP-ACTIVATION",
      orderId: ids.orderId,
      productId: ids.productId,
      productVersionId: ids.productVersionId,
      quoteId: randomUUID(),
      vehicleId: ids.sourceVehicleId
    });
    const targetVehicle = await insertRuntimeVehicle(
      tx,
      ids.targetVehicleId,
      "VEHICLE-SWAP-ACTIVATION-TARGET"
    );
    await insertRuntimeSubscriptionPlan(tx, {
      baseMonthlyFeeAmount: targetMonthlyFeeAmount,
      label: "VEHICLE-SWAP-ACTIVATION",
      modelDefinitionId: targetVehicle.modelDefinitionId,
      planId: ids.targetPlanId,
      productId: ids.productId,
      productVersionId: ids.productVersionId,
      vehiclePackageId: ids.vehiclePackageId
    });
    await tx.vehicle.update({
      data: {
        currentSalePriceAmount: 22000000n,
        currentSalePriceInitializedAt: new Date("2026-01-01T00:00:00.000Z"),
        currentSalePriceReviewedAt: new Date("2026-01-01T00:00:00.000Z"),
        salePriceStatus: "EFFECTIVE",
        status: "LEASED"
      },
      where: { id: ids.sourceVehicleId }
    });
    await tx.vehicle.update({
      data: {
        currentSalePriceAmount: 22000000n,
        currentSalePriceInitializedAt: new Date("2026-01-01T00:00:00.000Z"),
        currentSalePriceReviewedAt: new Date("2026-01-01T00:00:00.000Z"),
        salePriceStatus: "EFFECTIVE",
        status: "REVIEW_RESERVED"
      },
      where: { id: ids.targetVehicleId }
    });
    const fileIds = [
      ids.baseContractFileId,
      ids.supplementContractFileId,
      ...ids.conditionFileIds,
      ...ids.signedFileIds
    ];
    for (const [index, fileId] of fileIds.entries()) {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "file_object" (
          "id", "bucket", "object_key", "original_name", "mime_type", "size_bytes", "created_at"
        ) VALUES (
          ${fileId}::uuid,
          'test-private',
          ${`vehicle-swap/${ids.changeId}/${index}.pdf`},
          ${`vehicle-swap-${index}.pdf`},
          'application/pdf',
          128,
          clock_timestamp()
        )
      `);
    }
    await tx.subscriptionOrder.update({
      data: {
        actualDeliveryAt: new Date("2026-01-01T02:00:00.000Z"),
        depositAmount: 1000n,
        endDate: new Date("2027-12-31T00:00:00.000Z"),
        finalPlanSnapshot: { mileagePackage: { monthlyMileageKm: 1500 } },
        mileageLimitKm: 1500,
        monthlyFeeAmount: 100000n,
        orderStatus: "ACTIVE",
        overMileageFeeAmount: 100n,
        periodMonths: 24,
        quoteSnapshot: { quoteNo: "SWAP-SOURCE" },
        startDate: new Date("2026-01-01T00:00:00.000Z"),
        vehiclePurchasePriceAmount: 20000000n
      },
      where: { id: ids.orderId }
    });
    for (const [contractId, fileId, title] of [
      [ids.baseContractId, ids.baseContractFileId, "Base subscription contract"],
      [ids.supplementContractId, ids.supplementContractFileId, "Vehicle swap supplement"]
    ] as const) {
      await insertRuntimeContract(tx, {
        contractId,
        customerId: ids.customerId,
        label: title,
        orderId: ids.orderId
      });
      await tx.contract.update({
        data: {
          contractSnapshot: { signedArtifact: `${title}.pdf` },
          contractTitle: title,
          fileId
        },
        where: { id: contractId }
      });
    }
    await tx.$executeRaw(Prisma.sql`
      UPDATE "subscription_order"
      SET "contract_id" = ${ids.baseContractId}::uuid
      WHERE "id" = ${ids.orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "subscription_contract_segment" (
        "id", "segment_no", "order_id", "segment_type", "sequence_no", "status",
        "start_date", "end_date", "source_contract_id", "product_id",
        "product_version_id", "subscription_plan_id", "monthly_fee_amount",
        "mileage_limit_km", "over_mileage_fee_amount", "plan_snapshot",
        "quote_snapshot", "contract_snapshot", "activated_at", "created_at"
      ) VALUES (
        ${ids.sourceSegmentId}::uuid,
        ${businessNo("SEGSWAP", ids.sourceSegmentId)},
        ${ids.orderId}::uuid,
        'BASE',
        1,
        'ACTIVE',
        '2026-01-01'::date,
        '2027-12-31'::date,
        ${ids.baseContractId}::uuid,
        ${ids.productId}::uuid,
        ${ids.productVersionId}::uuid,
        ${ids.targetPlanId}::uuid,
        100000,
        1500,
        100,
        '{"mileagePackage":{"monthlyMileageKm":1500}}'::jsonb,
        '{"source":"BASE"}'::jsonb,
        '{"source":"BASE_CONTRACT"}'::jsonb,
        '2026-01-01T02:00:00Z'::timestamptz,
        clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "subscription_change_order" (
        "id", "change_no", "order_id", "change_type", "status", "source_segment_id",
        "contract_id", "completion_deadline_at",
        "customer_confirmation_published_at", "version", "created_at", "updated_at"
      ) VALUES (
        ${ids.changeId}::uuid,
        ${businessNo("SCOSWAP", ids.changeId)},
        ${ids.orderId}::uuid,
        'VEHICLE_SWAP',
        'SCHEDULED',
        ${ids.sourceSegmentId}::uuid,
        ${ids.supplementContractId}::uuid,
        ${new Date(now.getTime() + 86_400_000)},
        clock_timestamp(),
        1,
        clock_timestamp(),
        clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "subscription_change_quote" (
        "id", "quote_no", "change_order_id", "revision", "status", "pricing_mode",
        "product_id", "product_version_id", "subscription_plan_id", "monthly_fee_amount",
        "deposit_amount", "mileage_limit_km", "over_mileage_fee_amount",
        "plan_snapshot", "price_rule_snapshot", "quote_snapshot", "valid_until",
        "formalized_at", "confirmed_at", "created_at"
      ) VALUES (
        ${ids.quoteId}::uuid,
        ${businessNo("SCQSWAP", ids.quoteId)},
        ${ids.changeId}::uuid,
        1,
        'CUSTOMER_CONFIRMED',
        'CURRENT_VERSION',
        ${ids.productId}::uuid,
        ${ids.productVersionId}::uuid,
        ${ids.targetPlanId}::uuid,
        ${targetMonthlyFeeAmount},
        ${targetDepositAmount},
        2000,
        150,
        ${JSON.stringify({
          mileagePackage: { monthlyMileageKm: 2000 },
          subscriptionPlanId: ids.targetPlanId
        })}::jsonb,
        '{"source":"VEHICLE_SWAP_TEST"}'::jsonb,
        '{"source":"VEHICLE_SWAP_TEST"}'::jsonb,
        ${new Date(now.getTime() + 86_400_000)},
        clock_timestamp(),
        clock_timestamp(),
        clock_timestamp()
      )
    `);
    await tx.subscriptionChangeOrder.update({
      data: { confirmedQuoteId: ids.quoteId, currentQuoteId: ids.quoteId },
      where: { id: ids.changeId }
    });
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "subscription_vehicle_swap_change_detail" (
        "id", "change_order_id", "source_vehicle_id", "target_vehicle_id",
        "target_subscription_plan_id", "target_vehicle_package_id", "planned_swap_at",
        "commercial_snapshot", "commercial_snapshot_hash", "created_at", "updated_at"
      ) VALUES (
        ${randomUUID()}::uuid,
        ${ids.changeId}::uuid,
        ${ids.sourceVehicleId}::uuid,
        ${ids.targetVehicleId}::uuid,
        ${ids.targetPlanId}::uuid,
        ${ids.vehiclePackageId}::uuid,
        ${plannedSwapAt},
        ${JSON.stringify({
          classification: "OUT_OF_PACKAGE",
          deltas: { depositAmount: String(options.depositDelta ?? 0n) }
        })}::jsonb,
        ${"c".repeat(64)},
        clock_timestamp(),
        clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "vehicle_subscription_period" (
        "id", "vehicle_id", "order_id", "contract_id", "contract_segment_id",
        "customer_id", "started_at", "start_reason", "start_source_type",
        "start_source_id", "start_source_key", "start_snapshot", "start_confirmed_at",
        "created_at", "updated_at"
      ) VALUES (
        ${ids.sourcePeriodId}::uuid,
        ${ids.sourceVehicleId}::uuid,
        ${ids.orderId}::uuid,
        ${ids.baseContractId}::uuid,
        ${ids.sourceSegmentId}::uuid,
        ${ids.customerId}::uuid,
        '2026-01-01T02:00:00Z'::timestamptz,
        'LEASE_ACTIVATED',
        'VEHICLE_SWAP_TEST',
        ${ids.orderId}::uuid,
        'source-period',
        '{"source":"TEST"}'::jsonb,
        '2026-01-01T02:00:00Z'::timestamptz,
        clock_timestamp(),
        clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "order_entitlement_account" (
        "id", "account_no", "order_id", "customer_id", "subscription_plan_id",
        "account_status", "period_start", "period_end", "snapshot", "created_at", "updated_at"
      ) VALUES (
        ${ids.entitlementAccountId}::uuid,
        ${businessNo("EASWAP", ids.entitlementAccountId)},
        ${ids.orderId}::uuid,
        ${ids.customerId}::uuid,
        ${ids.targetPlanId}::uuid,
        'ACTIVE',
        '2026-01-01'::date,
        '2027-12-31'::date,
        '{"source":"TEST"}'::jsonb,
        clock_timestamp(),
        clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "order_entitlement_grant" (
        "id", "grant_no", "account_id", "order_id", "customer_id", "entitlement_type",
        "entitlement_name", "total_amount", "used_amount", "remaining_amount", "unit",
        "grant_source", "grant_period_start", "grant_period_end", "status", "snapshot",
        "created_at", "updated_at"
      ) VALUES (
        ${ids.futureGrantId}::uuid,
        ${businessNo("EGSWAP", ids.futureGrantId)},
        ${ids.entitlementAccountId}::uuid,
        ${ids.orderId}::uuid,
        ${ids.customerId}::uuid,
        'MILEAGE',
        'Source monthly mileage',
        1500,
        0,
        1500,
        'KM',
        'MONTHLY_RENEWAL',
        ${futureGrantStart},
        ${futureGrantEnd},
        'ACTIVE',
        '{"source":"TEST"}'::jsonb,
        clock_timestamp(),
        clock_timestamp()
      )
    `);
  });
  return {
    ...ids,
    depositDelta: options.depositDelta ?? 0n,
    futureGrantEnd,
    futureGrantStart,
    plannedSwapAt,
    targetDepositAmount,
    targetMonthlyFeeAmount
  };
}

export async function markVehicleSwapWorkOrdersReady(
  prisma: PrismaService,
  fixture: VehicleSwapTestFixture
) {
  const detail = await prisma.subscriptionVehicleSwapChangeDetail.findUniqueOrThrow({
    where: { changeOrderId: fixture.changeId }
  });
  const workOrderIds = [detail.inboundWorkOrderId, detail.outboundWorkOrderId];
  if (workOrderIds.some((id) => !id)) throw new Error("Swap work orders were not coordinated");
  const readiness = {
    accessoriesConfirmed: true,
    conditionConfirmed: true,
    keysConfirmed: true,
    mileageConfirmed: true,
    physicalControlConfirmed: true,
    registrationConfirmed: true
  };
  await prisma.$transaction(async (tx) => {
    for (const [index, workOrderId] of workOrderIds.entries()) {
      await tx.assetWorkOrder.update({
        data: {
          closedAt: new Date(),
          closeReason: "Vehicle swap handover confirmed",
          status: "CLOSED",
          version: { increment: 1 }
        },
        where: { id: workOrderId! }
      });
      const latest = await tx.assetWorkOrderEvent.aggregate({
        _max: { sequence: true },
        where: { workOrderId: workOrderId! }
      });
      await tx.assetWorkOrderEvent.create({
        data: {
          actorId: null,
          afterStatus: "CLOSED",
          beforeStatus: "PENDING",
          detailSnapshot: { swapReadiness: readiness },
          eventType: "CLOSED",
          occurredAt: new Date(),
          sequence: (latest._max.sequence ?? 0) + 1,
          sourceId: fixture.changeId,
          sourceKey: `ready:${index}`,
          sourceType: "VEHICLE_SWAP_TEST",
          workOrderId: workOrderId!
        }
      });
      for (const [evidenceIndex, evidenceType] of ["PHOTO", "DOCUMENT"].entries()) {
        const fileId =
          evidenceIndex === 0 ? fixture.conditionFileIds[index]! : fixture.signedFileIds[index]!;
        await tx.assetWorkOrderEvidence.create({
          data: {
            action: "ATTACH",
            capturedAt: new Date(),
            contentSha256: (index === 0 ? "a" : "b").repeat(64),
            evidenceType: evidenceType as "PHOTO" | "DOCUMENT",
            fileBucket: "test-private",
            fileId,
            fileMimeType: "application/pdf",
            fileObjectKey: `vehicle-swap/${fixture.changeId}/${index * 2 + evidenceIndex + 2}.pdf`,
            fileSizeBytes: 128n,
            sourceId: fixture.changeId,
            sourceKey: `evidence:${index}:${evidenceIndex}`,
            sourceType: "VEHICLE_SWAP_TEST",
            workOrderId: workOrderId!
          }
        });
      }
    }
  });
}

export async function cleanupVehicleSwapFixture(
  prisma: PrismaService,
  fixture: VehicleSwapTestFixture
) {
  if (!prisma || !fixture) throw new Error("Vehicle-swap cleanup requires its suite fixture");
  // The release database launcher drops the exact disposable database after the suite.
}

function businessNo(prefix: string, id: string) {
  return `${prefix}${id.replaceAll("-", "").slice(0, 24)}`;
}
