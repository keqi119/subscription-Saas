import { Injectable } from "@nestjs/common";
import { Prisma, SubscriptionChangeStatus } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";

export const subscriptionChangeInclude = Prisma.validator<Prisma.SubscriptionChangeOrderInclude>()({
  automationJobs: { orderBy: { createdAt: "desc" } },
  confirmedQuote: true,
  contract: true,
  currentQuote: true,
  earlyTerminationDetail: true,
  extensionDetail: { include: { sourceSegment: true } },
  managedOtherDetail: true,
  order: { select: { id: true, orderNo: true } },
  quotes: { orderBy: { revision: "desc" } },
  targetSegment: true,
  vehicleSwapDetail: true
});

export type SubscriptionChangeRecord = Prisma.SubscriptionChangeOrderGetPayload<{
  include: typeof subscriptionChangeInclude;
}>;

const ACTIVE_CHANGE_STATUSES: SubscriptionChangeStatus[] = [
  SubscriptionChangeStatus.DRAFT,
  SubscriptionChangeStatus.QUOTED,
  SubscriptionChangeStatus.CUSTOMER_CONFIRMED,
  SubscriptionChangeStatus.SIGNING_OR_PAYMENT,
  SubscriptionChangeStatus.SCHEDULED,
  SubscriptionChangeStatus.EXECUTING,
  SubscriptionChangeStatus.MANUAL_TAKEOVER
];

type DatabaseClient = Prisma.TransactionClient | PrismaService;

@Injectable()
export class SubscriptionChangeRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.prisma.$transaction(operation, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    });
  }

  async lockCreationScope(tx: Prisma.TransactionClient, orderId: string) {
    if (typeof tx.$queryRaw !== "function") return;
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "subscription_order"
      WHERE "id" = ${orderId}::uuid
      FOR UPDATE
    `);
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "subscription_contract_segment"
      WHERE "order_id" = ${orderId}::uuid
        AND "status" IN ('ACTIVE', 'SCHEDULED')
      ORDER BY "sequence_no", "id"
      FOR UPDATE
    `);
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "subscription_change_order"
      WHERE "order_id" = ${orderId}::uuid
        AND "status" IN (
          'DRAFT', 'QUOTED', 'CUSTOMER_CONFIRMED', 'SIGNING_OR_PAYMENT',
          'SCHEDULED', 'EXECUTING', 'MANUAL_TAKEOVER'
        )
      ORDER BY "created_at", "id"
      FOR UPDATE
    `);
  }

  async lockVehicleSwapResources(
    tx: Prisma.TransactionClient,
    input: {
      sourceVehicleId: string;
      targetSubscriptionPlanId: string;
      targetVehicleId: string;
      targetVehiclePackageId: string;
    }
  ) {
    if (typeof tx.$queryRaw !== "function") return;
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "subscription_plan"
      WHERE "id" = ${input.targetSubscriptionPlanId}::uuid
      FOR UPDATE
    `);
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "vehicle_package"
      WHERE "id" = ${input.targetVehiclePackageId}::uuid
      FOR UPDATE
    `);
    const vehicleIds = [input.sourceVehicleId, input.targetVehicleId].sort();
    for (const vehicleId of vehicleIds) {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "vehicle"
        WHERE "id" = ${vehicleId}::uuid
        FOR UPDATE
      `);
    }
  }

  async lockChange(tx: Prisma.TransactionClient, id: string) {
    if (typeof tx.$queryRaw !== "function") return;
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "subscription_change_order"
      WHERE "id" = ${id}::uuid
      FOR UPDATE
    `);
  }

  findOrder(tx: DatabaseClient, orderId: string) {
    return tx.subscriptionOrder.findUnique({
      include: { vehicle: true },
      where: { id: orderId }
    });
  }

  findTargetPlan(tx: DatabaseClient, planId: string) {
    return tx.subscriptionPlan.findUnique({
      select: { id: true, vehiclePackageId: true },
      where: { id: planId }
    });
  }

  findActiveChange(tx: DatabaseClient, orderId: string) {
    return tx.subscriptionChangeOrder.findFirst({
      where: { orderId, status: { in: ACTIVE_CHANGE_STATUSES } }
    });
  }

  findCommand(actorId: string, operation: string, idempotencyKey: string) {
    return this.prisma.subscriptionChangeCommand.findUnique({
      where: {
        actorId_operation_idempotencyKey: { actorId, idempotencyKey, operation }
      }
    });
  }

  createCommand(
    tx: Prisma.TransactionClient,
    input: {
      actorId: string;
      idempotencyKey: string;
      operation: string;
      requestHash: string;
    }
  ) {
    return tx.subscriptionChangeCommand.create({ data: input });
  }

  completeCommand(
    tx: Prisma.TransactionClient,
    commandId: string,
    resourceId: string,
    completedAt: Date
  ) {
    return tx.subscriptionChangeCommand.update({
      data: { completedAt, resourceId, resourceType: "CHANGE" },
      where: { id: commandId }
    });
  }

  createChange(tx: Prisma.TransactionClient, data: Prisma.SubscriptionChangeOrderCreateInput) {
    return tx.subscriptionChangeOrder.create({ data, include: subscriptionChangeInclude });
  }

  updateChange(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.SubscriptionChangeOrderUpdateInput
  ) {
    return tx.subscriptionChangeOrder.update({
      data,
      include: subscriptionChangeInclude,
      where: { id }
    });
  }

  findChange(id: string): Promise<SubscriptionChangeRecord | null>;
  findChange(id: string, tx: Prisma.TransactionClient): Promise<SubscriptionChangeRecord | null>;
  findChange(id: string, tx: DatabaseClient = this.prisma) {
    return tx.subscriptionChangeOrder.findUnique({
      include: subscriptionChangeInclude,
      where: { id }
    });
  }

  listForOrder(orderId: string) {
    return this.prisma.subscriptionChangeOrder.findMany({
      include: subscriptionChangeInclude,
      orderBy: { createdAt: "desc" },
      where: { orderId }
    });
  }
}
