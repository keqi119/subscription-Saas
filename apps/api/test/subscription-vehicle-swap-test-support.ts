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
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "customer" (
        "id", "customer_no", "name", "mobile", "status", "created_at", "updated_at"
      ) VALUES (
        ${ids.customerId}::uuid,
        ${businessNo("CUSSWAP", ids.customerId)},
        'Vehicle swap test customer',
        ${`139${ids.customerId.replaceAll("-", "").slice(0, 8)}`},
        'ACTIVE',
        clock_timestamp(),
        clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "product" (
        "id", "product_no", "name", "product_type", "status", "created_at", "updated_at"
      ) VALUES (
        ${ids.productId}::uuid,
        ${businessNo("PRDSWAP", ids.productId)},
        'Vehicle swap test product',
        'SUBSCRIPTION',
        'ACTIVE',
        clock_timestamp(),
        clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "product_version" (
        "id", "product_id", "version_no", "effective_from", "status", "created_at", "updated_at"
      ) VALUES (
        ${ids.productVersionId}::uuid,
        ${ids.productId}::uuid,
        'V1.0',
        '2026-01-01'::date,
        'ACTIVE',
        clock_timestamp(),
        clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "subscription_plan" (
        "id", "plan_no", "plan_name", "product_id", "product_version_id",
        "vehicle_package_id", "mileage_package_id", "energy_package_id",
        "base_monthly_fee_amount", "min_period_months", "max_period_months",
        "status", "effective_from", "created_at", "updated_at"
      ) VALUES (
        ${ids.targetPlanId}::uuid,
        ${businessNo("PLNSWAP", ids.targetPlanId)},
        'Vehicle swap target plan',
        ${ids.productId}::uuid,
        ${ids.productVersionId}::uuid,
        ${ids.vehiclePackageId}::uuid,
        ${randomUUID()}::uuid,
        ${randomUUID()}::uuid,
        ${targetMonthlyFeeAmount},
        1,
        36,
        'ACTIVE',
        '2026-01-01'::date,
        clock_timestamp(),
        clock_timestamp()
      )
    `);
    for (const [index, vehicleId] of [ids.sourceVehicleId, ids.targetVehicleId].entries()) {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "vehicle" (
          "id", "vehicle_no", "brand", "model_definition_id", "purchase_price_amount",
          "current_sale_price_amount", "current_sale_price_initialized_at",
          "current_sale_price_reviewed_at", "sale_price_status", "status",
          "created_at", "updated_at"
        ) VALUES (
          ${vehicleId}::uuid,
          ${businessNo(`VEHSWAP${index}`, vehicleId)},
          'NIO',
          ${randomUUID()}::uuid,
          20000000,
          22000000,
          clock_timestamp(),
          clock_timestamp(),
          'EFFECTIVE',
          ${index === 0 ? "LEASED" : "REVIEW_RESERVED"}::vehicle_status,
          clock_timestamp(),
          clock_timestamp()
        )
      `);
    }
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
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "subscription_order" (
        "id", "order_no", "customer_id", "application_id", "quote_id",
        "contract_id", "vehicle_id", "product_id", "product_version_id",
        "vehicle_purchase_price_amount", "monthly_fee_amount", "deposit_amount",
        "period_months", "mileage_limit_km", "over_mileage_fee_amount",
        "model_definition_id_snapshot", "model_code_snapshot",
        "model_display_name_snapshot", "quote_snapshot", "final_plan_snapshot",
        "order_status", "start_date", "end_date", "actual_delivery_at",
        "created_at", "updated_at"
      ) VALUES (
        ${ids.orderId}::uuid,
        ${businessNo("ORDSWAP", ids.orderId)},
        ${ids.customerId}::uuid,
        ${randomUUID()}::uuid,
        ${randomUUID()}::uuid,
        NULL,
        ${ids.sourceVehicleId}::uuid,
        ${ids.productId}::uuid,
        ${ids.productVersionId}::uuid,
        20000000,
        100000,
        1000,
        24,
        1500,
        100,
        ${randomUUID()}::uuid,
        'NIO_ET5_2026',
        'NIO ET5',
        '{"quoteNo":"SWAP-SOURCE"}'::jsonb,
        '{"mileagePackage":{"monthlyMileageKm":1500}}'::jsonb,
        'ACTIVE',
        '2026-01-01'::date,
        '2027-12-31'::date,
        '2026-01-01T02:00:00Z'::timestamptz,
        clock_timestamp(),
        clock_timestamp()
      )
    `);
    for (const [contractId, fileId, title] of [
      [ids.baseContractId, ids.baseContractFileId, "Base subscription contract"],
      [ids.supplementContractId, ids.supplementContractFileId, "Vehicle swap supplement"]
    ] as const) {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "contract" (
          "id", "contract_no", "order_id", "customer_id", "business_type",
          "contract_version_id", "contract_title", "contract_snapshot", "file_id",
          "status", "signed_at", "archived_at", "created_at", "updated_at"
        ) VALUES (
          ${contractId}::uuid,
          ${businessNo("CONSWAP", contractId)},
          ${ids.orderId}::uuid,
          ${ids.customerId}::uuid,
          'SUBSCRIPTION',
          ${randomUUID()}::uuid,
          ${title},
          ${JSON.stringify({ signedArtifact: `${title}.pdf` })}::jsonb,
          ${fileId}::uuid,
          'ARCHIVED',
          clock_timestamp(),
          clock_timestamp(),
          clock_timestamp(),
          clock_timestamp()
        )
      `);
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
        "current_quote_id", "confirmed_quote_id", "contract_id", "completion_deadline_at",
        "customer_confirmation_published_at", "version", "created_at", "updated_at"
      ) VALUES (
        ${ids.changeId}::uuid,
        ${businessNo("SCOSWAP", ids.changeId)},
        ${ids.orderId}::uuid,
        'VEHICLE_SWAP',
        'SCHEDULED',
        ${ids.sourceSegmentId}::uuid,
        ${ids.quoteId}::uuid,
        ${ids.quoteId}::uuid,
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
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "audit_log"
      WHERE "entity_id" IN (
        ${fixture.changeId}::uuid,
        ${fixture.orderId}::uuid,
        ${fixture.sourcePeriodId}::uuid,
        ${fixture.sourceSegmentId}::uuid
      ) OR "entity_id" IN (
        SELECT "id" FROM "asset_work_order" WHERE "create_source_id" = ${fixture.changeId}::uuid
      ) OR "entity_id" IN (
        SELECT "id" FROM "asset_work_order_event" WHERE "source_id" = ${fixture.changeId}::uuid
      ) OR "entity_id" IN (
        SELECT "id" FROM "asset_work_order_evidence" WHERE "source_id" = ${fixture.changeId}::uuid
      ) OR "entity_id" IN (
        SELECT "id" FROM "vehicle_operational_restriction" WHERE "start_source_id" = ${fixture.changeId}::uuid
      ) OR "entity_id" IN (
        SELECT "id" FROM "subscription_contract_segment" WHERE "source_change_order_id" = ${fixture.changeId}::uuid
      ) OR "entity_id" IN (
        SELECT "id" FROM "vehicle_subscription_period" WHERE "start_source_id" = ${fixture.changeId}::uuid
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "vehicle_operational_restriction"
      WHERE "start_source_id" = ${fixture.changeId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "asset_work_order_evidence"
      WHERE "work_order_id" IN (
        SELECT "id" FROM "asset_work_order" WHERE "create_source_id" = ${fixture.changeId}::uuid
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "asset_work_order_event"
      WHERE "work_order_id" IN (
        SELECT "id" FROM "asset_work_order" WHERE "create_source_id" = ${fixture.changeId}::uuid
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "subscription_vehicle_swap_change_detail"
      WHERE "change_order_id" = ${fixture.changeId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "asset_work_order" WHERE "create_source_id" = ${fixture.changeId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "vehicle_subscription_period" WHERE "order_id" = ${fixture.orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "order_entitlement_usage" WHERE "order_id" = ${fixture.orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "order_entitlement_grant" WHERE "order_id" = ${fixture.orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "order_entitlement_account" WHERE "order_id" = ${fixture.orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "receivable_bill" WHERE "order_id" = ${fixture.orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "subscription_change_quote" WHERE "change_order_id" = ${fixture.changeId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "subscription_contract_segment" WHERE "order_id" = ${fixture.orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "subscription_change_order" WHERE "id" = ${fixture.changeId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "contract" WHERE "order_id" = ${fixture.orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "subscription_order" WHERE "id" = ${fixture.orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "vehicle"
      WHERE "id" IN (${fixture.sourceVehicleId}::uuid, ${fixture.targetVehicleId}::uuid)
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "file_object"
      WHERE "id" IN (
        ${fixture.baseContractFileId}::uuid,
        ${fixture.supplementContractFileId}::uuid,
        ${fixture.conditionFileIds[0]}::uuid,
        ${fixture.conditionFileIds[1]}::uuid,
        ${fixture.signedFileIds[0]}::uuid,
        ${fixture.signedFileIds[1]}::uuid
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "subscription_plan" WHERE "id" = ${fixture.targetPlanId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "product_version" WHERE "id" = ${fixture.productVersionId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "product" WHERE "id" = ${fixture.productId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "customer" WHERE "id" = ${fixture.customerId}::uuid
    `);
  });
}

function businessNo(prefix: string, id: string) {
  return `${prefix}${id.replaceAll("-", "").slice(0, 24)}`;
}
