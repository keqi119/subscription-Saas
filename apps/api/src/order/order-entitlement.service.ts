import { BadRequestException, Injectable } from "@nestjs/common";
import {
  EntitlementAccountStatus,
  EntitlementGrantSource,
  EntitlementGrantStatus,
  EntitlementType,
  EntitlementUnit,
  Prisma
} from "@prisma/client";

import { createBusinessNo } from "../common/business-number";

type Tx = Prisma.TransactionClient;
type SnapshotRecord = Record<string, unknown>;

type GrantInput = {
  entitlementName: string;
  entitlementType: EntitlementType;
  remainingAmount: Prisma.Decimal | null;
  snapshot: Prisma.InputJsonValue;
  totalAmount: Prisma.Decimal | null;
  unit: EntitlementUnit;
  usedAmount: Prisma.Decimal | null;
};

@Injectable()
export class OrderEntitlementService {
  async ensureInitialEntitlements(
    tx: Tx,
    orderId: string,
    actorId: string
  ): Promise<void> {
    const lockedOrders = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "subscription_order"
      WHERE "id" = ${orderId}::uuid
      FOR UPDATE
    `);
    if (lockedOrders.length !== 1) {
      throw new BadRequestException("The entitlement order was not found.");
    }
    const order = await tx.subscriptionOrder.findUnique({
      include: {
        customer: { select: { grade: true, id: true, mobile: true, name: true } },
        quote: { select: { packageSnapshot: true } },
        vehicle: {
          select: {
            brand: true,
            id: true,
            plateNo: true,
            vehicleNo: true,
            vin: true
          }
        }
      },
      where: { id: orderId }
    });
    if (!order || order.deletedAt) {
      throw new BadRequestException("The entitlement order was not found.");
    }

    const sourceSnapshot = resolveSourceSnapshot(order);
    const packageSnapshot = normalizePackageSnapshot(sourceSnapshot);
    const grants = buildGrantInputs(packageSnapshot);
    if (grants.length === 0) {
      throw new BadRequestException(
        "The order package snapshot has no entitlement components."
      );
    }

    const periodStart = toBusinessDate(
      order.actualDeliveryAt ??
        order.startDate ??
        order.customerConfirmedAt ??
        order.finalPlanConfirmedAt ??
        order.createdAt
    );
    const periodEnd = addDaysUtc(addMonthsClampedUtc(periodStart, 1), -1);
    let account = await tx.orderEntitlementAccount.findFirst({
      orderBy: { createdAt: "desc" },
      where: { deletedAt: null, orderId }
    });

    if (!account) {
      account = await tx.orderEntitlementAccount.create({
        data: {
          accountNo: createBusinessNo("EA"),
          accountStatus: EntitlementAccountStatus.SUSPENDED,
          createdBy: actorId,
          customerId: order.customerId,
          orderId,
          periodEnd,
          periodStart,
          snapshot: jsonValue({
            customer: order.customer,
            order: {
              orderId: order.id,
              orderNo: order.orderNo,
              orderStatus: order.orderStatus,
              periodMonths: order.periodMonths
            },
            packageSnapshot,
            preparedAt: new Date().toISOString(),
            source: EntitlementGrantSource.ORDER_START,
            sourceSnapshot,
            vehicle: order.vehicle
          }),
          subscriptionPlanId: resolveSubscriptionPlanId(packageSnapshot),
          updatedBy: actorId
        }
      });
    } else if (
      order.actualDeliveryAt &&
      account.accountStatus === EntitlementAccountStatus.SUSPENDED &&
      (account.periodStart.getTime() !== periodStart.getTime() ||
        account.periodEnd?.getTime() !== periodEnd.getTime())
    ) {
      account = await tx.orderEntitlementAccount.update({
        data: { periodEnd, periodStart, updatedBy: actorId },
        where: { id: account.id }
      });
      await tx.orderEntitlementGrant.updateMany({
        data: {
          grantPeriodEnd: periodEnd,
          grantPeriodStart: periodStart,
          updatedBy: actorId
        },
        where: {
          accountId: account.id,
          deletedAt: null,
          grantSource: EntitlementGrantSource.ORDER_START
        }
      });
    }

    for (const grant of grants) {
      const existing = await tx.orderEntitlementGrant.findFirst({
        where: {
          accountId: account.id,
          deletedAt: null,
          entitlementName: grant.entitlementName,
          entitlementType: grant.entitlementType,
          grantPeriodStart: periodStart,
          grantSource: EntitlementGrantSource.ORDER_START,
          orderId,
          unit: grant.unit
        }
      });
      if (existing) continue;
      await tx.orderEntitlementGrant.create({
        data: {
          accountId: account.id,
          createdBy: actorId,
          customerId: order.customerId,
          entitlementName: grant.entitlementName,
          entitlementType: grant.entitlementType,
          grantNo: createBusinessNo("EG"),
          grantPeriodEnd: periodEnd,
          grantPeriodStart: periodStart,
          grantSource: EntitlementGrantSource.ORDER_START,
          orderId,
          remainingAmount: grant.remainingAmount,
          snapshot: grant.snapshot,
          status: EntitlementGrantStatus.ACTIVE,
          totalAmount: grant.totalAmount,
          unit: grant.unit,
          updatedBy: actorId,
          usedAmount: grant.usedAmount
        }
      });
    }
  }
}

function resolveSourceSnapshot(order: {
  finalPlanSnapshot: unknown;
  quote: { packageSnapshot: unknown };
  quoteSnapshot: unknown;
}) {
  const orderQuote = asRecord(order.quoteSnapshot);
  const candidates = [
    order.finalPlanSnapshot,
    orderQuote?.packageSnapshot,
    order.quoteSnapshot,
    order.quote.packageSnapshot
  ];
  for (const candidate of candidates) {
    const record = asRecord(candidate);
    if (!record) continue;
    const normalized = normalizePackageSnapshot(record);
    if (
      normalized.mileagePackage ||
      normalized.energyPackage ||
      normalized.benefitPackage
    ) {
      return record;
    }
  }
  throw new BadRequestException("The order is missing its package snapshot.");
}

function normalizePackageSnapshot(snapshot: unknown) {
  const record = asRecord(snapshot) ?? {};
  const source = asRecord(record.packageSnapshot) ?? record;
  return {
    benefitPackage: firstRecord(source.benefitPackage, record.benefitPackage),
    energyPackage: firstRecord(source.energyPackage, record.energyPackage),
    mileagePackage: firstRecord(source.mileagePackage, record.mileagePackage),
    subscriptionPlan: firstRecord(
      source.subscriptionPlan,
      record.subscriptionPlan
    ),
    subscriptionPlanId:
      firstString(source.subscriptionPlanId, record.subscriptionPlanId) ?? null
  };
}

function buildGrantInputs(
  snapshot: ReturnType<typeof normalizePackageSnapshot>
): GrantInput[] {
  const grants: GrantInput[] = [];
  const mileage = numberField(
    snapshot.mileagePackage,
    "monthlyMileageKm",
    "monthly_mileage_km"
  );
  if (mileage !== null && mileage > 0) {
    grants.push(
      amountGrant(
        "Monthly mileage allowance",
        EntitlementType.MILEAGE,
        EntitlementUnit.KM,
        mileage,
        { mileagePackage: snapshot.mileagePackage }
      )
    );
  }
  const energyKwh = numberField(
    snapshot.energyPackage,
    "monthlyEnergyKwh",
    "monthly_energy_kwh"
  );
  if (energyKwh !== null && energyKwh > 0) {
    grants.push(
      amountGrant(
        "Monthly energy allowance",
        EntitlementType.ENERGY,
        EntitlementUnit.KWH,
        energyKwh,
        { energyPackage: snapshot.energyPackage }
      )
    );
  }
  const energyCount = numberField(
    snapshot.energyPackage,
    "monthlyEnergyCount",
    "monthly_energy_count",
    "monthlyEnergyTimes"
  );
  if (energyCount !== null && energyCount > 0) {
    grants.push(
      amountGrant(
        "Monthly energy service count",
        EntitlementType.ENERGY,
        EntitlementUnit.TIMES,
        energyCount,
        { energyPackage: snapshot.energyPackage }
      )
    );
  }
  if (snapshot.benefitPackage) {
    const count = numberField(
      snapshot.benefitPackage,
      "benefitCount",
      "benefit_count"
    );
    const name =
      firstString(
        snapshot.benefitPackage.description,
        snapshot.benefitPackage.packageName,
        snapshot.benefitPackage.package_name,
        snapshot.benefitPackage.benefitType
      ) ?? "Service benefit";
    if (count !== null && count > 0) {
      grants.push(
        amountGrant(
          name.slice(0, 128),
          EntitlementType.BENEFIT,
          EntitlementUnit.TIMES,
          count,
          { benefitPackage: snapshot.benefitPackage }
        )
      );
    } else {
      grants.push({
        entitlementName: name.slice(0, 128),
        entitlementType: EntitlementType.BENEFIT,
        remainingAmount: null,
        snapshot: jsonValue({ benefitPackage: snapshot.benefitPackage }),
        totalAmount: null,
        unit: EntitlementUnit.TEXT,
        usedAmount: null
      });
    }
  }
  return grants;
}

function amountGrant(
  name: string,
  type: EntitlementType,
  unit: EntitlementUnit,
  amount: number,
  snapshot: unknown
): GrantInput {
  const value = new Prisma.Decimal(amount);
  return {
    entitlementName: name,
    entitlementType: type,
    remainingAmount: value,
    snapshot: jsonValue(snapshot),
    totalAmount: value,
    unit,
    usedAmount: new Prisma.Decimal(0)
  };
}

function resolveSubscriptionPlanId(
  snapshot: ReturnType<typeof normalizePackageSnapshot>
) {
  return snapshot.subscriptionPlanId ?? firstString(snapshot.subscriptionPlan?.id);
}

function numberField(record: SnapshotRecord | null, ...keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function firstRecord(...values: unknown[]) {
  for (const value of values) {
    const record = asRecord(value);
    if (record) return record;
  }
  return null;
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function asRecord(value: unknown): SnapshotRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as SnapshotRecord)
    : null;
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_key, entry) =>
      typeof entry === "bigint" ? entry.toString() : entry
    )
  ) as Prisma.InputJsonValue;
}

function addMonthsClampedUtc(date: Date, months: number) {
  const first = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1)
  );
  const lastDay = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)
  ).getUTCDate();
  return new Date(
    Date.UTC(
      first.getUTCFullYear(),
      first.getUTCMonth(),
      Math.min(date.getUTCDate(), lastDay)
    )
  );
}

function addDaysUtc(date: Date, days: number) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days)
  );
}

function toBusinessDate(value: Date) {
  return new Date(`${value.toISOString().slice(0, 10)}T00:00:00.000Z`);
}
