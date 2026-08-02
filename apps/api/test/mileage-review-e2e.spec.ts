import { ConfigService } from "@nestjs/config";
import {
  BillStatus,
  BillType,
  EntitlementAccountStatus,
  EntitlementGrantSource,
  EntitlementGrantStatus,
  EntitlementType,
  EntitlementUnit,
  EntitlementUsageStatus,
  OrderMileageReviewStatus,
  VehicleMileageReadingStatus,
  VehicleMileageSourceType,
  Prisma
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { RequestUser } from "../src/auth/auth.types";
import { MileageReviewRepository } from "../src/mileage-review/mileage-review.repository";
import { MileageReviewSettlementService } from "../src/mileage-review/mileage-review-settlement.service";
import { MileageReviewService } from "../src/mileage-review/mileage-review.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { StorageService } from "../src/storage/storage.service";
import { VehicleMileageService } from "../src/vehicle-mileage/vehicle-mileage.service";

const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://subscription:subscription@127.0.0.1:5432/subscription_saas?schema=public";

describe("monthly mileage review PostgreSQL end-to-end", () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(
      new ConfigService({
        DATABASE_POOL_MAX: "5",
        DATABASE_URL: TEST_DATABASE_URL
      })
    );
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it("runs delivery baseline, portal settlement, void/reopen, and admin correction without duplicate ledgers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T05:00:00.000Z"));
    const ids = {
      application: randomUUID(),
      customer: randomUUID(),
      modelDefinition: randomUUID(),
      order: randomUUID(),
      product: randomUUID(),
      productVersion: randomUUID(),
      quote: randomUUID(),
      user: randomUUID(),
      vehicle: randomUUID()
    };
    const actualDeliveryAt = new Date("2026-08-31T04:30:00.000Z");
    const actor: RequestUser = {
      id: ids.user,
      menus: [],
      name: "Mileage E2E operator",
      permissions: [],
      roles: ["SYSTEM_ADMIN"],
      username: `mileage-e2e-${ids.user.slice(0, 8)}`
    };
    const storage = {
      getObject: vi.fn(async () => ({
        contentLength: 10,
        contentType: "image/jpeg",
        stream: Readable.from(jpegBuffer())
      }))
    } as unknown as StorageService;
    const repository = new MileageReviewRepository(prisma);
    const vehicleMileage = new VehicleMileageService(prisma);
    const settlement = new MileageReviewSettlementService(prisma, vehicleMileage);
    const service = new MileageReviewService(prisma, repository, storage, settlement);

    try {
      await prisma.user.create({
        data: {
          id: ids.user,
          name: actor.name,
          passwordHash: "not-used-in-e2e",
          username: actor.username
        }
      });
      await prisma.customer.create({
        data: {
          customerNo: `CUSE2E${ids.customer.replaceAll("-", "").slice(0, 18)}`,
          id: ids.customer,
          mobile: `138${ids.customer.replaceAll("-", "").slice(0, 8)}`,
          name: "Mileage E2E customer",
          status: "ACTIVE"
        }
      });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
        await tx.$executeRaw`
          INSERT INTO "vehicle" (
            "id", "vehicle_no", "vin", "plate_no", "brand",
            "model", "model_definition_id", "purchase_price_amount",
            "status", "current_mileage_km", "created_at", "updated_at"
          ) VALUES (
            ${ids.vehicle}::uuid,
            ${`VEHE2E${ids.vehicle.replaceAll("-", "").slice(0, 18)}`},
            ${`VINE2E${ids.vehicle.replaceAll("-", "").slice(0, 18)}`},
            ${`E2E${ids.vehicle.replaceAll("-", "").slice(0, 5)}`},
            'NIO',
            'ET5',
            ${ids.modelDefinition}::uuid,
            20000000,
            'LEASED',
            0,
            clock_timestamp(),
            clock_timestamp()
          )
        `;
        await tx.$executeRaw`
          INSERT INTO "subscription_order" (
            "id", "order_no", "customer_id", "application_id", "quote_id",
            "vehicle_id", "product_id", "product_version_id",
            "vehicle_purchase_price_amount", "monthly_fee_amount", "deposit_amount",
            "period_months", "mileage_limit_km", "over_mileage_fee_amount",
            "model_definition_id_snapshot", "model_code_snapshot",
            "model_display_name_snapshot", "quote_snapshot", "order_status",
            "actual_delivery_at", "created_at", "updated_at"
          ) VALUES (
            ${ids.order}::uuid,
            ${`ORDE2E${ids.order.replaceAll("-", "").slice(0, 20)}`},
            ${ids.customer}::uuid,
            ${ids.application}::uuid,
            ${ids.quote}::uuid,
            ${ids.vehicle}::uuid,
            ${ids.product}::uuid,
            ${ids.productVersion}::uuid,
            20000000,
            300000,
            100000,
            12,
            1500,
            100,
            ${ids.modelDefinition}::uuid,
            'NIO_ET5_2024',
            'NIO ET5',
            '{}'::jsonb,
            'ACTIVE',
            ${actualDeliveryAt},
            clock_timestamp(),
            clock_timestamp()
          )
        `;
      });

      const firstReview = await prisma.$transaction(async (tx) => {
        const baseline = await vehicleMileage.appendConfirmedReading(tx, {
          confirmedBy: ids.user,
          evidenceSnapshot: { source: "DELIVERY_E2E" },
          mileageKm: 1000,
          orderId: ids.order,
          recordedAt: actualDeliveryAt,
          sourceRecordId: `delivery-e2e:${ids.order}`,
          sourceType: VehicleMileageSourceType.DELIVERY_BASELINE,
          vehicleId: ids.vehicle
        });
        return service.createFirstReview(tx, {
          actorId: ids.user,
          actualDeliveryAt,
          deliveryReadingId: baseline.id,
          orderId: ids.order,
          vehicleId: ids.vehicle
        });
      });
      const entitlementAccount = await prisma.orderEntitlementAccount.create({
        data: {
          accountNo: `EAE2E${ids.order.replaceAll("-", "").slice(0, 20)}`,
          accountStatus: EntitlementAccountStatus.ACTIVE,
          customerId: ids.customer,
          orderId: ids.order,
          periodStart: new Date("2026-08-31T00:00:00.000Z"),
          snapshot: { source: "MILEAGE_E2E" }
        }
      });
      const existingGrant = await prisma.orderEntitlementGrant.create({
        data: {
          accountId: entitlementAccount.id,
          customerId: ids.customer,
          entitlementName: "Monthly mileage allowance",
          entitlementType: EntitlementType.MILEAGE,
          grantNo: `EGE2E${ids.order.replaceAll("-", "").slice(0, 20)}`,
          grantPeriodEnd: new Date("2026-09-29T00:00:00.000Z"),
          grantPeriodStart: new Date("2026-08-31T00:00:00.000Z"),
          grantSource: EntitlementGrantSource.ORDER_START,
          orderId: ids.order,
          remainingAmount: new Prisma.Decimal(1500),
          status: EntitlementGrantStatus.EXPIRED,
          totalAmount: new Prisma.Decimal(1500),
          unit: EntitlementUnit.KM,
          usedAmount: new Prisma.Decimal(0)
        }
      });

      await expect(service.activateDueReviews(firstReview.scheduledReviewAt)).resolves.toEqual({
        activatedCount: 1
      });
      let portalReview = await service.getCustomerReview(firstReview.id, ids.customer);
      portalReview = await service.saveCustomerDraft(
        firstReview.id,
        {
          lockVersion: portalReview.lockVersion,
          readingAt: "2026-09-30T04:30:00.000Z",
          submittedMileageKm: 3000
        },
        ids.customer
      );
      portalReview = await service.attachCustomerEvidence(
        firstReview.id,
        {
          bucket: "private-e2e",
          capturedAt: "2026-09-30T04:29:00.000Z",
          lockVersion: portalReview.lockVersion,
          mimeType: "image/jpeg",
          objectKey: `mileage-e2e/${firstReview.id}/portal.jpg`,
          originalName: "portal.jpg",
          sizeBytes: 10n
        },
        ids.customer
      );
      portalReview = await service.submitCustomerReview(
        firstReview.id,
        { lockVersion: portalReview.lockVersion },
        ids.customer
      );
      const conflictingBill = await prisma.receivableBill.create({
        data: {
          amount: 1n,
          billNo: `BILE2E${randomUUID().replaceAll("-", "").slice(0, 20)}`,
          billStatus: BillStatus.PENDING,
          billType: BillType.OVER_MILEAGE,
          customerId: ids.customer,
          dueDate: new Date("2026-10-05T04:30:00.000Z"),
          orderId: ids.order,
          paidAmount: 0n,
          remainingAmount: 1n,
          sourceKey: `over-mileage:${firstReview.id}:v1`
        }
      });
      await expect(
        service.confirmReview(
          firstReview.id,
          {
            idempotencyKey: `portal-confirm:${firstReview.id}`,
            lockVersion: portalReview.lockVersion
          },
          actor
        )
      ).rejects.toThrow("Over-mileage bill idempotency key is already in use.");
      await expect(
        prisma.orderMileageReview.findUniqueOrThrow({
          where: { id: firstReview.id }
        })
      ).resolves.toMatchObject({
        status: OrderMileageReviewStatus.PENDING_REVIEW
      });
      await expect(
        prisma.vehicle.findUniqueOrThrow({ where: { id: ids.vehicle } })
      ).resolves.toMatchObject({ currentMileageKm: 1000 });
      await expect(
        prisma.vehicleMileageReading.count({
          where: {
            orderId: ids.order,
            sourceType: VehicleMileageSourceType.MONTHLY_REVIEW
          }
        })
      ).resolves.toBe(0);
      await expect(
        prisma.orderEntitlementUsage.count({ where: { orderId: ids.order } })
      ).resolves.toBe(0);
      await expect(
        prisma.orderEntitlementGrant.findUniqueOrThrow({
          where: { id: existingGrant.id }
        })
      ).resolves.toMatchObject({
        remainingAmount: new Prisma.Decimal(1500),
        status: EntitlementGrantStatus.EXPIRED,
        usedAmount: new Prisma.Decimal(0)
      });
      await prisma.receivableBill.delete({ where: { id: conflictingBill.id } });

      const confirmation = {
        idempotencyKey: `portal-confirm:${firstReview.id}`,
        lockVersion: portalReview.lockVersion
      };
      const concurrentResults = await Promise.allSettled([
        service.confirmReview(firstReview.id, confirmation, actor),
        service.confirmReview(firstReview.id, confirmation, actor)
      ]);
      expect(concurrentResults.filter((result) => result.status === "fulfilled")).not.toHaveLength(
        0
      );
      const portalConfirmed = await service.getReview(firstReview.id);

      expect(portalConfirmed).toMatchObject({
        allowanceKm: 1500,
        consumedAllowanceKm: 1500,
        overMileageAmount: "50000",
        overMileageKm: 500,
        status: OrderMileageReviewStatus.CONFIRMED
      });
      await expect(
        prisma.orderEntitlementGrant.count({ where: { orderId: ids.order } })
      ).resolves.toBe(1);
      expect(
        await prisma.orderMileageReview.findUniqueOrThrow({
          where: { id: firstReview.id }
        })
      ).toMatchObject({ entitlementGrantId: existingGrant.id });
      await expect(
        prisma.vehicle.findUniqueOrThrow({ where: { id: ids.vehicle } })
      ).resolves.toMatchObject({ currentMileageKm: 3000 });
      await expect(
        prisma.receivableBill.count({
          where: {
            billStatus: BillStatus.PENDING,
            billType: BillType.OVER_MILEAGE,
            orderId: ids.order
          }
        })
      ).resolves.toBe(1);
      await expect(
        prisma.orderMileageReview.count({
          where: {
            cycleNo: 2,
            deletedAt: null,
            orderId: ids.order,
            status: OrderMileageReviewStatus.SCHEDULED
          }
        })
      ).resolves.toBe(1);

      const reopened = await service.voidAndReopenReview(
        firstReview.id,
        {
          lockVersion: portalConfirmed.lockVersion,
          reason: "E2E correction"
        },
        actor
      );
      const voidedReview = await prisma.orderMileageReview.findUniqueOrThrow({
        where: { id: firstReview.id }
      });
      const replacementReview = await prisma.orderMileageReview.findUniqueOrThrow({
        where: {
          orderId_cycleNo_version: {
            cycleNo: 1,
            orderId: ids.order,
            version: 2
          }
        }
      });
      expect(voidedReview.status).toBe(OrderMileageReviewStatus.VOIDED);
      expect(replacementReview).toMatchObject({
        cycleNo: 1,
        status: OrderMileageReviewStatus.PENDING_SUBMISSION,
        version: 2
      });
      await expect(
        prisma.vehicle.findUniqueOrThrow({ where: { id: ids.vehicle } })
      ).resolves.toMatchObject({ currentMileageKm: 1000 });

      const adminFile = await prisma.fileObject.create({
        data: {
          bucket: "private-e2e",
          mimeType: "image/jpeg",
          objectKey: `mileage-e2e/${firstReview.id}/admin.jpg`,
          originalName: "admin.jpg",
          sizeBytes: 10n,
          uploadedBy: ids.user
        }
      });
      let adminReview = await service.saveAdminDraft(
        replacementReview.id,
        {
          lockVersion: reopened.replacementReview.lockVersion,
          readingAt: "2026-09-30T04:45:00.000Z",
          submittedMileageKm: 2800
        },
        actor
      );
      adminReview = await service.attachEvidence(
        replacementReview.id,
        { fileId: adminFile.id, lockVersion: adminReview.lockVersion },
        actor
      );
      adminReview = await service.submitReview(
        replacementReview.id,
        { lockVersion: adminReview.lockVersion },
        actor
      );
      const adminConfirmed = await service.confirmReview(
        replacementReview.id,
        {
          idempotencyKey: `admin-confirm:${replacementReview.id}`,
          lockVersion: adminReview.lockVersion
        },
        actor
      );
      await expect(
        service.confirmReview(
          replacementReview.id,
          {
            idempotencyKey: `admin-confirm:${replacementReview.id}`,
            lockVersion: adminReview.lockVersion
          },
          actor
        )
      ).resolves.toMatchObject({ lockVersion: adminConfirmed.lockVersion });

      expect(adminConfirmed).toMatchObject({
        overMileageAmount: "30000",
        overMileageKm: 300,
        status: OrderMileageReviewStatus.CONFIRMED
      });
      for (const billStatus of [BillStatus.CANCELLED, BillStatus.PENDING]) {
        await expect(
          prisma.receivableBill.count({
            where: {
              billStatus,
              billType: BillType.OVER_MILEAGE,
              orderId: ids.order
            }
          })
        ).resolves.toBe(1);
      }
      for (const usageStatus of [
        EntitlementUsageStatus.CANCELLED,
        EntitlementUsageStatus.CONFIRMED
      ]) {
        await expect(
          prisma.orderEntitlementUsage.count({
            where: { orderId: ids.order, usageStatus }
          })
        ).resolves.toBe(1);
      }
      for (const status of [
        VehicleMileageReadingStatus.ACTIVE,
        VehicleMileageReadingStatus.VOIDED
      ]) {
        await expect(
          prisma.vehicleMileageReading.count({
            where: {
              orderId: ids.order,
              sourceType: VehicleMileageSourceType.MONTHLY_REVIEW,
              status
            }
          })
        ).resolves.toBe(1);
      }
      await expect(
        prisma.vehicle.findUniqueOrThrow({ where: { id: ids.vehicle } })
      ).resolves.toMatchObject({ currentMileageKm: 2800 });
      await expect(
        prisma.orderMileageReview.findFirstOrThrow({
          where: {
            baselineMileageKm: 2800,
            cycleNo: 2,
            deletedAt: null,
            orderId: ids.order,
            status: OrderMileageReviewStatus.SCHEDULED
          }
        })
      ).resolves.toMatchObject({ version: 2 });
    } finally {
      const files = await prisma.fileObject
        .findMany({
          select: { id: true },
          where: { objectKey: { startsWith: "mileage-e2e/" } }
        })
        .catch(() => []);
      await prisma.orderMileageReviewEvidence.deleteMany({
        where: { review: { orderId: ids.order } }
      });
      await prisma.orderMileageReview.deleteMany({
        where: { orderId: ids.order }
      });
      await prisma.orderEntitlementUsage.deleteMany({
        where: { orderId: ids.order }
      });
      await prisma.orderEntitlementGrant.deleteMany({
        where: { orderId: ids.order }
      });
      await prisma.orderEntitlementAccount.deleteMany({
        where: { orderId: ids.order }
      });
      await prisma.receivableBill.deleteMany({ where: { orderId: ids.order } });
      await prisma.vehicleMileageReading.deleteMany({
        where: { orderId: ids.order }
      });
      await prisma.fileObject.deleteMany({
        where: { id: { in: files.map((file) => file.id) } }
      });
      await prisma.subscriptionOrder.deleteMany({ where: { id: ids.order } });
      await prisma.vehicle.deleteMany({ where: { id: ids.vehicle } });
      await prisma.customer.deleteMany({ where: { id: ids.customer } });
      await prisma.user.deleteMany({ where: { id: ids.user } });
      vi.useRealTimers();
    }
  }, 20_000);
});

function jpegBuffer() {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
}
