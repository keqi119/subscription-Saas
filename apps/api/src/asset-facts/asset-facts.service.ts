import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import {
  AuditAction,
  LeaseStatus,
  OrderStatus,
  Prisma,
  VehicleOwnershipPeriodEndReason,
  VehicleOwnershipPeriodStartReason,
  VehicleStatus,
  VehicleSubscriptionPeriodEndReason,
  VehicleSubscriptionPeriodStartReason,
  type VehicleOwnershipPeriod,
  type VehicleSubscriptionPeriod
} from "@prisma/client";
import { isDeepStrictEqual } from "node:util";

import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { AssetFactsRepository } from "./asset-facts.repository";
import type { ImmutableFactSnapshot } from "./asset-facts.types";
import type {
  CloseOwnershipPeriodDto,
  CloseSubscriptionPeriodDto,
  OpenOwnershipPeriodDto,
  OpenSubscriptionPeriodDto
} from "./dto/asset-facts.dto";

export const ASSET_FACT_SERVICE_CODE = {
  ASSET_OWNER_NOT_FOUND: "ASSET_OWNER_NOT_FOUND",
  CONTRACT_NOT_FOUND: "ASSET_FACT_CONTRACT_NOT_FOUND",
  CONTRACT_SEGMENT_NOT_FOUND: "ASSET_FACT_CONTRACT_SEGMENT_NOT_FOUND",
  CUSTOMER_NOT_FOUND: "ASSET_FACT_CUSTOMER_NOT_FOUND",
  INVALID_CONFIRMATION_TIME: "ASSET_FACT_INVALID_CONFIRMATION_TIME",
  INVALID_END_REASON: "ASSET_FACT_INVALID_END_REASON",
  INVALID_SOURCE: "ASSET_FACT_INVALID_SOURCE",
  INVALID_START_REASON: "ASSET_FACT_INVALID_START_REASON",
  INVALID_TIME: "ASSET_FACT_INVALID_TIME",
  INVALID_TIME_RANGE: "ASSET_FACT_INVALID_TIME_RANGE",
  ORDER_NOT_FOUND: "ASSET_FACT_ORDER_NOT_FOUND",
  OWNERSHIP_PERIOD_NOT_FOUND: "OWNERSHIP_PERIOD_NOT_FOUND",
  SUBSCRIPTION_AGGREGATE_MISMATCH: "SUBSCRIPTION_AGGREGATE_MISMATCH",
  SUBSCRIPTION_PERIOD_NOT_FOUND: "SUBSCRIPTION_PERIOD_NOT_FOUND",
  VEHICLE_NOT_FOUND: "ASSET_FACT_VEHICLE_NOT_FOUND"
} as const;

export type AssetFactDiscrepancyFlag =
  | "LEASE_WITHOUT_CURRENT_SUBSCRIPTION"
  | "OPEN_SUBSCRIPTION_LEASE_MISSING"
  | "OPEN_SUBSCRIPTION_LEASE_STATUS_MISMATCH"
  | "OPEN_SUBSCRIPTION_ORDER_CUSTOMER_MISMATCH"
  | "OPEN_SUBSCRIPTION_ORDER_MISSING"
  | "OPEN_SUBSCRIPTION_ORDER_STATUS_MISMATCH"
  | "OPEN_SUBSCRIPTION_ORDER_VEHICLE_MISMATCH"
  | "OPEN_SUBSCRIPTION_VEHICLE_MISSING"
  | "OPEN_SUBSCRIPTION_VEHICLE_STATUS_MISMATCH"
  | "ORDER_WITHOUT_CURRENT_SUBSCRIPTION"
  | "VEHICLE_WITHOUT_CURRENT_SUBSCRIPTION";

export interface AssetFactCommandContext {
  readonly actorId: string | null;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

const VEHICLE_SELECT = {
  id: true,
  vehicleNo: true,
  vin: true,
  plateNo: true,
  status: true,
  deletedAt: true
} satisfies Prisma.VehicleSelect;

const ORDER_SELECT = {
  id: true,
  orderNo: true,
  customerId: true,
  vehicleId: true,
  contractId: true,
  orderStatus: true,
  deletedAt: true
} satisfies Prisma.SubscriptionOrderSelect;

const CUSTOMER_SELECT = {
  id: true,
  customerNo: true,
  name: true,
  status: true,
  deletedAt: true
} satisfies Prisma.CustomerSelect;

const CONTRACT_SELECT = {
  id: true,
  contractNo: true,
  orderId: true,
  customerId: true,
  status: true,
  deletedAt: true
} satisfies Prisma.ContractSelect;

const CONTRACT_SEGMENT_SELECT = {
  id: true,
  segmentNo: true,
  orderId: true,
  sourceContractId: true,
  status: true
} satisfies Prisma.SubscriptionContractSegmentSelect;

const ASSET_OWNER_SELECT = {
  id: true,
  ownerNo: true,
  name: true,
  ownerType: true,
  status: true
} satisfies Prisma.AssetOwnerSelect;

const LEASE_SELECT = {
  id: true,
  orderId: true,
  status: true,
  activatedAt: true,
  deletedAt: true
} satisfies Prisma.LeaseSelect;

type VehicleAuthority = Prisma.VehicleGetPayload<{ select: typeof VEHICLE_SELECT }>;
type OrderAuthority = Prisma.SubscriptionOrderGetPayload<{ select: typeof ORDER_SELECT }>;
type CustomerAuthority = Prisma.CustomerGetPayload<{ select: typeof CUSTOMER_SELECT }>;
type ContractAuthority = Prisma.ContractGetPayload<{ select: typeof CONTRACT_SELECT }>;
type ContractSegmentAuthority = Prisma.SubscriptionContractSegmentGetPayload<{
  select: typeof CONTRACT_SEGMENT_SELECT;
}>;
type AssetOwnerAuthority = Prisma.AssetOwnerGetPayload<{ select: typeof ASSET_OWNER_SELECT }>;
type LeaseAuthority = Prisma.LeaseGetPayload<{ select: typeof LEASE_SELECT }>;

type SubscriptionAuthority = {
  contract: ContractAuthority | null;
  contractSegment: ContractSegmentAuthority | null;
  customer: CustomerAuthority;
  order: OrderAuthority;
  vehicle: VehicleAuthority;
};

type OwnershipAuthority = {
  assetOwner: AssetOwnerAuthority;
  vehicle: VehicleAuthority;
};

@Injectable()
export class AssetFactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: AssetFactsRepository,
    private readonly auditService: AuditService
  ) {}

  async openSubscriptionPeriod(
    dto: OpenSubscriptionPeriodDto,
    context: AssetFactCommandContext
  ) {
    const startedAt = parseDate(dto.startedAt);
    const confirmedAt = parseDate(dto.confirmedAt);
    assertStartReason(dto.reason, "subscription");
    assertConfirmationTime(confirmedAt, startedAt);
    const metadata = normalizeMetadata(dto.snapshot);
    assertSource(dto.source);

    return this.runCommand(async (tx) => {
      await this.repository.lockCommandSource(tx, "subscription", "start", dto.source);
      await lockSubscriptionAuthorityRows(tx, dto);
      const authority = await loadSubscriptionAuthority(tx, dto);
      const replay = await findSubscriptionStartReplay(tx, dto);
      const snapshot = replaySnapshot(replay?.startSnapshot, metadata) ??
        buildSubscriptionSnapshot(authority, metadata);
      const outcome = await this.repository.openSubscriptionPeriodWithOutcome(tx, {
        actorId: context.actorId,
        confirmedAt,
        contractId: authority.contract?.id ?? null,
        contractSegmentId: authority.contractSegment?.id ?? null,
        customerId: authority.customer.id,
        orderId: authority.order.id,
        reason: dto.reason,
        snapshot,
        source: dto.source,
        startedAt,
        vehicleId: authority.vehicle.id
      });
      if (outcome.wrote) {
        await this.writeAudit(tx, AuditAction.CREATE, "vehicle_subscription_period", outcome.fact, context);
      }
      return outcome.fact;
    });
  }

  async closeSubscriptionPeriod(
    dto: CloseSubscriptionPeriodDto,
    context: AssetFactCommandContext
  ) {
    const endedAt = parseDate(dto.endedAt);
    const confirmedAt = parseDate(dto.confirmedAt);
    assertEndReason(dto.reason, "subscription");
    assertConfirmationTime(confirmedAt, endedAt);
    const metadata = normalizeMetadata(dto.snapshot);
    assertSource(dto.source);

    return this.runCommand(async (tx) => {
      await this.repository.lockCommandSource(tx, "subscription", "end", dto.source);
      await lockPeriodRow(tx, "vehicle_subscription_period", dto.periodId);
      const period = await tx.vehicleSubscriptionPeriod.findFirst({
        where: { id: dto.periodId }
      });
      if (!period) {
        throw notFound(
          ASSET_FACT_SERVICE_CODE.SUBSCRIPTION_PERIOD_NOT_FOUND,
          "Subscription period not found."
        );
      }
      assertEndAfterStart(period.startedAt, endedAt);
      await lockSubscriptionAuthorityRows(tx, period);
      const authority = await loadSubscriptionAuthority(tx, {
        contractId: period.contractId,
        contractSegmentId: period.contractSegmentId,
        customerId: period.customerId,
        orderId: period.orderId,
        vehicleId: period.vehicleId
      });
      const replay = await findSubscriptionEndReplay(tx, dto);
      const snapshot = replaySnapshot(replay?.endSnapshot, metadata) ??
        buildSubscriptionSnapshot(authority, metadata);
      const outcome = await this.repository.closeSubscriptionPeriodWithOutcome(tx, {
        actorId: context.actorId,
        confirmedAt,
        endedAt,
        periodId: dto.periodId,
        reason: dto.reason,
        snapshot,
        source: dto.source
      });
      if (outcome.wrote) {
        await this.writeAudit(
          tx,
          AuditAction.UPDATE,
          "vehicle_subscription_period",
          outcome.fact,
          context,
          period
        );
      }
      return outcome.fact;
    });
  }

  async openOwnershipPeriod(
    dto: OpenOwnershipPeriodDto,
    context: AssetFactCommandContext
  ) {
    const startedAt = parseDate(dto.startedAt);
    const confirmedAt = parseDate(dto.confirmedAt);
    assertStartReason(dto.reason, "ownership");
    assertConfirmationTime(confirmedAt, startedAt);
    const metadata = normalizeMetadata(dto.snapshot);
    assertSource(dto.source);

    return this.runCommand(async (tx) => {
      await this.repository.lockCommandSource(tx, "ownership", "start", dto.source);
      await lockOwnershipAuthorityRows(tx, dto);
      const authority = await loadOwnershipAuthority(tx, dto);
      const replay = await findOwnershipStartReplay(tx, dto);
      const snapshot = replaySnapshot(replay?.startSnapshot, metadata) ??
        buildOwnershipSnapshot(authority, metadata);
      const outcome = await this.repository.openOwnershipPeriodWithOutcome(tx, {
        actorId: context.actorId,
        assetOwnerId: authority.assetOwner.id,
        confirmedAt,
        reason: dto.reason,
        snapshot,
        source: dto.source,
        startedAt,
        vehicleId: authority.vehicle.id
      });
      if (outcome.wrote) {
        await this.writeAudit(tx, AuditAction.CREATE, "vehicle_ownership_period", outcome.fact, context);
      }
      return outcome.fact;
    });
  }

  async closeOwnershipPeriod(
    dto: CloseOwnershipPeriodDto,
    context: AssetFactCommandContext
  ) {
    const endedAt = parseDate(dto.endedAt);
    const confirmedAt = parseDate(dto.confirmedAt);
    assertEndReason(dto.reason, "ownership");
    assertConfirmationTime(confirmedAt, endedAt);
    const metadata = normalizeMetadata(dto.snapshot);
    assertSource(dto.source);

    return this.runCommand(async (tx) => {
      await this.repository.lockCommandSource(tx, "ownership", "end", dto.source);
      await lockPeriodRow(tx, "vehicle_ownership_period", dto.periodId);
      const period = await tx.vehicleOwnershipPeriod.findFirst({ where: { id: dto.periodId } });
      if (!period) {
        throw notFound(
          ASSET_FACT_SERVICE_CODE.OWNERSHIP_PERIOD_NOT_FOUND,
          "Ownership period not found."
        );
      }
      assertEndAfterStart(period.startedAt, endedAt);
      await lockOwnershipAuthorityRows(tx, period);
      const authority = await loadOwnershipAuthority(tx, {
        assetOwnerId: period.assetOwnerId,
        vehicleId: period.vehicleId
      });
      const replay = await findOwnershipEndReplay(tx, dto);
      const snapshot = replaySnapshot(replay?.endSnapshot, metadata) ??
        buildOwnershipSnapshot(authority, metadata);
      const outcome = await this.repository.closeOwnershipPeriodWithOutcome(tx, {
        actorId: context.actorId,
        confirmedAt,
        endedAt,
        periodId: dto.periodId,
        reason: dto.reason,
        snapshot,
        source: dto.source
      });
      if (outcome.wrote) {
        await this.writeAudit(
          tx,
          AuditAction.UPDATE,
          "vehicle_ownership_period",
          outcome.fact,
          context,
          period
        );
      }
      return outcome.fact;
    });
  }

  async getByVehicle(vehicleId: string) {
    const [vehicle, subscriptionRows, ownershipRows] = await Promise.all([
      this.prisma.vehicle.findFirst({
        select: VEHICLE_SELECT,
        where: { deletedAt: null, id: vehicleId }
      }),
      this.prisma.vehicleSubscriptionPeriod.findMany({ where: { vehicleId } }),
      this.prisma.vehicleOwnershipPeriod.findMany({ where: { vehicleId } })
    ]);
    if (!vehicle) {
      throw notFound(ASSET_FACT_SERVICE_CODE.VEHICLE_NOT_FOUND, "Vehicle not found.");
    }
    const subscription = projectSubscriptionRows(subscriptionRows);
    const ownership = projectOwnershipRows(ownershipRows);
    const [currentOrder, vehicleOrders] = await Promise.all([
      subscription.current
        ? this.prisma.subscriptionOrder.findFirst({
            select: ORDER_SELECT,
            where: { deletedAt: null, id: subscription.current.orderId }
          })
        : null,
      this.prisma.subscriptionOrder.findMany({
        orderBy: [{ orderNo: "asc" }, { id: "asc" }],
        select: ORDER_SELECT,
        where: {
          deletedAt: null,
          vehicleId
        }
      })
    ]);
    const orderIds = [
      ...new Set([
        ...vehicleOrders.map(({ id }) => id),
        ...(currentOrder ? [currentOrder.id] : [])
      ])
    ];
    const leases = orderIds.length
      ? await this.prisma.lease.findMany({
          orderBy: [{ activatedAt: "desc" }, { id: "asc" }],
          select: LEASE_SELECT,
          where: { deletedAt: null, orderId: { in: orderIds } }
        })
      : [];
    const runtimeOrder = currentOrder ??
      vehicleOrders.find(({ orderStatus }) => orderExpectsSubscription(orderStatus)) ??
      vehicleOrders.find(({ id }) =>
        leases.some(
          ({ orderId, status }) => orderId === id && leaseExpectsSubscription(status)
        )
      ) ??
      vehicleOrders[0] ??
      null;
    const currentLease = currentOrder
      ? leases.find(({ orderId }) => orderId === currentOrder.id) ?? null
      : null;
    const runtimeLease = runtimeOrder
      ? leases.find(({ orderId }) => orderId === runtimeOrder.id) ?? null
      : null;

    return {
      discrepancyFlags: vehicleDiscrepancies(
        vehicle,
        subscription.current,
        currentOrder,
        currentLease,
        vehicleOrders,
        leases
      ),
      ownership,
      runtime: {
        leaseStatus: runtimeLease?.status ?? null,
        orderStatus: runtimeOrder?.orderStatus ?? null,
        vehicleStatus: vehicle.status
      },
      subscription,
      vehicle: projectVehicle(vehicle)
    };
  }

  async getByOrder(orderId: string) {
    const order = await this.prisma.subscriptionOrder.findFirst({
      select: ORDER_SELECT,
      where: { deletedAt: null, id: orderId }
    });
    if (!order) {
      throw notFound(ASSET_FACT_SERVICE_CODE.ORDER_NOT_FOUND, "Order not found.");
    }
    const [rows, vehicle, lease] = await Promise.all([
      this.prisma.vehicleSubscriptionPeriod.findMany({ where: { orderId } }),
      order.vehicleId
        ? this.prisma.vehicle.findFirst({
            select: VEHICLE_SELECT,
            where: { deletedAt: null, id: order.vehicleId }
          })
        : null,
      this.prisma.lease.findFirst({
        select: LEASE_SELECT,
        where: { deletedAt: null, orderId }
      })
    ]);
    const subscription = projectSubscriptionRows(rows);

    return {
      discrepancyFlags: orderDiscrepancies(order, subscription.current, vehicle, lease),
      order: projectOrder(order),
      runtime: {
        leaseStatus: lease?.status ?? null,
        orderStatus: order.orderStatus,
        vehicleStatus: vehicle?.status ?? null
      },
      subscription
    };
  }

  private runCommand<T>(work: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.prisma.$transaction(work, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted
    });
  }

  private writeAudit(
    tx: Prisma.TransactionClient,
    action: AuditAction,
    entityType: string,
    after: VehicleOwnershipPeriod | VehicleSubscriptionPeriod,
    context: AssetFactCommandContext,
    before?: VehicleOwnershipPeriod | VehicleSubscriptionPeriod
  ) {
    return this.auditService.write(
      {
        action,
        after,
        before,
        entityId: after.id,
        entityType,
        ipAddress: context.ipAddress,
        module: "asset_facts",
        operatorId: context.actorId ?? undefined,
        userAgent: context.userAgent
      },
      tx
    );
  }
}

type AuthorityTable =
  | "asset_owner"
  | "contract"
  | "customer"
  | "subscription_contract_segment"
  | "subscription_order"
  | "vehicle";

async function lockSubscriptionAuthorityRows(
  tx: Prisma.TransactionClient,
  input: {
    contractId?: string | null;
    contractSegmentId?: string | null;
    customerId: string;
    orderId: string;
    vehicleId: string;
  }
) {
  await lockAuthorityRows(tx, [
    input.contractId ? { id: input.contractId, table: "contract" } : null,
    input.contractSegmentId
      ? { id: input.contractSegmentId, table: "subscription_contract_segment" }
      : null,
    { id: input.customerId, table: "customer" },
    { id: input.orderId, table: "subscription_order" },
    { id: input.vehicleId, table: "vehicle" }
  ]);
}

async function lockOwnershipAuthorityRows(
  tx: Prisma.TransactionClient,
  input: { assetOwnerId: string; vehicleId: string }
) {
  await lockAuthorityRows(tx, [
    { id: input.assetOwnerId, table: "asset_owner" },
    { id: input.vehicleId, table: "vehicle" }
  ]);
}

async function lockAuthorityRows(
  tx: Prisma.TransactionClient,
  rows: ReadonlyArray<{ id: string; table: AuthorityTable } | null>
) {
  const orderedRows = rows
    .filter((row): row is { id: string; table: AuthorityTable } => row !== null)
    .sort((left, right) =>
      left.table === right.table
        ? compareLockKey(left.id, right.id)
        : compareLockKey(left.table, right.table)
    );
  for (const row of orderedRows) {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${row.table}"`)} WHERE "id" = ${row.id}::uuid FOR SHARE`
    );
  }
}

function compareLockKey(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function lockPeriodRow(
  tx: Prisma.TransactionClient,
  table: "vehicle_ownership_period" | "vehicle_subscription_period",
  periodId: string
) {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${table}"`)} WHERE "id" = ${periodId}::uuid FOR UPDATE`
  );
}

async function loadSubscriptionAuthority(
  tx: Prisma.TransactionClient,
  input: {
    contractId?: string | null;
    contractSegmentId?: string | null;
    customerId: string;
    orderId: string;
    vehicleId: string;
  }
): Promise<SubscriptionAuthority> {
  const [vehicle, order, customer, contract, contractSegment] = await Promise.all([
    tx.vehicle.findFirst({ select: VEHICLE_SELECT, where: { deletedAt: null, id: input.vehicleId } }),
    tx.subscriptionOrder.findFirst({
      select: ORDER_SELECT,
      where: { deletedAt: null, id: input.orderId }
    }),
    tx.customer.findFirst({
      select: CUSTOMER_SELECT,
      where: { deletedAt: null, id: input.customerId }
    }),
    input.contractId
      ? tx.contract.findFirst({
          select: CONTRACT_SELECT,
          where: { deletedAt: null, id: input.contractId }
        })
      : null,
    input.contractSegmentId
      ? tx.subscriptionContractSegment.findFirst({
          select: CONTRACT_SEGMENT_SELECT,
          where: { id: input.contractSegmentId }
        })
      : null
  ]);
  if (!vehicle) throw notFound(ASSET_FACT_SERVICE_CODE.VEHICLE_NOT_FOUND, "Vehicle not found.");
  if (!order) throw notFound(ASSET_FACT_SERVICE_CODE.ORDER_NOT_FOUND, "Order not found.");
  if (!customer) throw notFound(ASSET_FACT_SERVICE_CODE.CUSTOMER_NOT_FOUND, "Customer not found.");
  if (input.contractId && !contract) {
    throw notFound(ASSET_FACT_SERVICE_CODE.CONTRACT_NOT_FOUND, "Contract not found.");
  }
  if (input.contractSegmentId && !contractSegment) {
    throw notFound(
      ASSET_FACT_SERVICE_CODE.CONTRACT_SEGMENT_NOT_FOUND,
      "Contract segment not found."
    );
  }
  if (
    order.vehicleId !== vehicle.id ||
    order.customerId !== customer.id ||
    (contract && (contract.orderId !== order.id || contract.customerId !== customer.id)) ||
    (contractSegment && contractSegment.orderId !== order.id) ||
    (contractSegment?.sourceContractId !== null &&
      contractSegment?.sourceContractId !== undefined &&
      contractSegment.sourceContractId !== contract?.id)
  ) {
    throw new ConflictException({
      code: ASSET_FACT_SERVICE_CODE.SUBSCRIPTION_AGGREGATE_MISMATCH,
      message: "Subscription period references do not identify one consistent live aggregate."
    });
  }
  return { contract, contractSegment, customer, order, vehicle };
}

async function loadOwnershipAuthority(
  tx: Prisma.TransactionClient,
  input: { assetOwnerId: string; vehicleId: string }
): Promise<OwnershipAuthority> {
  const [vehicle, assetOwner] = await Promise.all([
    tx.vehicle.findFirst({ select: VEHICLE_SELECT, where: { deletedAt: null, id: input.vehicleId } }),
    tx.assetOwner.findFirst({ select: ASSET_OWNER_SELECT, where: { id: input.assetOwnerId } })
  ]);
  if (!vehicle) throw notFound(ASSET_FACT_SERVICE_CODE.VEHICLE_NOT_FOUND, "Vehicle not found.");
  if (!assetOwner) {
    throw notFound(ASSET_FACT_SERVICE_CODE.ASSET_OWNER_NOT_FOUND, "Asset owner not found.");
  }
  return { assetOwner, vehicle };
}

function buildSubscriptionSnapshot(
  authority: SubscriptionAuthority,
  metadata: Prisma.JsonObject
): ImmutableFactSnapshot {
  return {
    authority: {
      contract: authority.contract ? projectContract(authority.contract) : null,
      contractSegment: authority.contractSegment
        ? projectContractSegment(authority.contractSegment)
        : null,
      customer: projectCustomer(authority.customer),
      order: projectOrder(authority.order),
      vehicle: projectVehicle(authority.vehicle)
    },
    metadata
  };
}

function buildOwnershipSnapshot(
  authority: OwnershipAuthority,
  metadata: Prisma.JsonObject
): ImmutableFactSnapshot {
  return {
    authority: {
      assetOwner: {
        id: authority.assetOwner.id,
        name: authority.assetOwner.name,
        ownerNo: authority.assetOwner.ownerNo,
        ownerType: authority.assetOwner.ownerType,
        status: authority.assetOwner.status
      },
      vehicle: projectVehicle(authority.vehicle)
    },
    metadata
  };
}

function projectVehicle(vehicle: VehicleAuthority) {
  return {
    id: vehicle.id,
    plateNo: vehicle.plateNo,
    status: vehicle.status,
    vehicleNo: vehicle.vehicleNo,
    vin: vehicle.vin
  };
}

function projectOrder(order: OrderAuthority) {
  return {
    contractId: order.contractId,
    customerId: order.customerId,
    id: order.id,
    orderNo: order.orderNo,
    orderStatus: order.orderStatus,
    vehicleId: order.vehicleId
  };
}

function projectCustomer(customer: CustomerAuthority) {
  return {
    customerNo: customer.customerNo,
    id: customer.id,
    name: customer.name,
    status: customer.status
  };
}

function projectContract(contract: ContractAuthority) {
  return {
    contractNo: contract.contractNo,
    customerId: contract.customerId,
    id: contract.id,
    orderId: contract.orderId,
    status: contract.status
  };
}

function projectContractSegment(segment: ContractSegmentAuthority) {
  return {
    id: segment.id,
    orderId: segment.orderId,
    segmentNo: segment.segmentNo,
    sourceContractId: segment.sourceContractId,
    status: segment.status
  };
}

function projectSubscriptionRows(rows: VehicleSubscriptionPeriod[]) {
  const sorted = [...rows].sort(comparePeriods);
  const currentRow = sorted.find(({ endedAt }) => endedAt === null) ?? null;
  return {
    current: currentRow ? projectSubscriptionPeriod(currentRow) : null,
    history: sorted.filter(({ endedAt }) => endedAt !== null).map(projectSubscriptionPeriod)
  };
}

function projectOwnershipRows(rows: VehicleOwnershipPeriod[]) {
  const sorted = [...rows].sort(comparePeriods);
  const currentRow = sorted.find(({ endedAt }) => endedAt === null) ?? null;
  return {
    current: currentRow ? projectOwnershipPeriod(currentRow) : null,
    history: sorted.filter(({ endedAt }) => endedAt !== null).map(projectOwnershipPeriod)
  };
}

function comparePeriods(
  left: { id: string; startedAt: Date },
  right: { id: string; startedAt: Date }
) {
  return right.startedAt.getTime() - left.startedAt.getTime() || left.id.localeCompare(right.id);
}

function projectSubscriptionPeriod(period: VehicleSubscriptionPeriod) {
  return {
    contractId: period.contractId,
    contractSegmentId: period.contractSegmentId,
    customerId: period.customerId,
    end: period.endedAt
      ? {
          confirmedAt: toIso(period.endConfirmedAt),
          confirmedBy: period.endConfirmedBy,
          reason: period.endReason,
          snapshot: period.endSnapshot,
          source: {
            id: period.endSourceId,
            key: period.endSourceKey,
            type: period.endSourceType
          }
        }
      : null,
    endedAt: toIso(period.endedAt),
    id: period.id,
    orderId: period.orderId,
    start: {
      confirmedAt: toIso(period.startConfirmedAt),
      confirmedBy: period.startConfirmedBy,
      reason: period.startReason,
      snapshot: period.startSnapshot,
      source: {
        id: period.startSourceId,
        key: period.startSourceKey,
        type: period.startSourceType
      }
    },
    startedAt: period.startedAt.toISOString(),
    vehicleId: period.vehicleId
  };
}

function projectOwnershipPeriod(period: VehicleOwnershipPeriod) {
  return {
    assetOwnerId: period.assetOwnerId,
    end: period.endedAt
      ? {
          confirmedAt: toIso(period.endConfirmedAt),
          confirmedBy: period.endConfirmedBy,
          reason: period.endReason,
          snapshot: period.endSnapshot,
          source: {
            id: period.endSourceId,
            key: period.endSourceKey,
            type: period.endSourceType
          }
        }
      : null,
    endedAt: toIso(period.endedAt),
    id: period.id,
    start: {
      confirmedAt: toIso(period.startConfirmedAt),
      confirmedBy: period.startConfirmedBy,
      reason: period.startReason,
      snapshot: period.startSnapshot,
      source: {
        id: period.startSourceId,
        key: period.startSourceKey,
        type: period.startSourceType
      }
    },
    startedAt: period.startedAt.toISOString(),
    vehicleId: period.vehicleId
  };
}

function vehicleDiscrepancies(
  vehicle: VehicleAuthority,
  current: ReturnType<typeof projectSubscriptionPeriod> | null,
  order: OrderAuthority | null,
  lease: LeaseAuthority | null,
  vehicleOrders: OrderAuthority[],
  vehicleLeases: LeaseAuthority[]
): AssetFactDiscrepancyFlag[] {
  const flags: AssetFactDiscrepancyFlag[] = [];
  if (!current) {
    if (vehicleOrders.some(({ orderStatus }) => orderExpectsSubscription(orderStatus))) {
      flags.push("ORDER_WITHOUT_CURRENT_SUBSCRIPTION");
    }
    if (vehicleLeases.some(({ status }) => leaseExpectsSubscription(status))) {
      flags.push("LEASE_WITHOUT_CURRENT_SUBSCRIPTION");
    }
    if (vehicleExpectsSubscription(vehicle.status)) {
      flags.push("VEHICLE_WITHOUT_CURRENT_SUBSCRIPTION");
    }
    return flags;
  }
  if (!order) {
    flags.push("OPEN_SUBSCRIPTION_ORDER_MISSING");
  } else {
    if (order.vehicleId !== vehicle.id) {
      flags.push("OPEN_SUBSCRIPTION_ORDER_VEHICLE_MISMATCH");
    }
    if (order.customerId !== current.customerId) {
      flags.push("OPEN_SUBSCRIPTION_ORDER_CUSTOMER_MISMATCH");
    }
    if (!orderExpectsSubscription(order.orderStatus)) {
      flags.push("OPEN_SUBSCRIPTION_ORDER_STATUS_MISMATCH");
    }
  }
  appendLeaseDiscrepancies(flags, lease);
  if (!vehicleExpectsSubscription(vehicle.status)) {
    flags.push("OPEN_SUBSCRIPTION_VEHICLE_STATUS_MISMATCH");
  }
  return flags;
}

function orderDiscrepancies(
  order: OrderAuthority,
  current: ReturnType<typeof projectSubscriptionPeriod> | null,
  vehicle: VehicleAuthority | null,
  lease: LeaseAuthority | null
): AssetFactDiscrepancyFlag[] {
  const flags: AssetFactDiscrepancyFlag[] = [];
  if (!current) {
    if (orderExpectsSubscription(order.orderStatus)) {
      flags.push("ORDER_WITHOUT_CURRENT_SUBSCRIPTION");
    }
    if (lease && leaseExpectsSubscription(lease.status)) {
      flags.push("LEASE_WITHOUT_CURRENT_SUBSCRIPTION");
    }
    if (vehicle && vehicleExpectsSubscription(vehicle.status)) {
      flags.push("VEHICLE_WITHOUT_CURRENT_SUBSCRIPTION");
    }
    return flags;
  }
  if (current.vehicleId !== order.vehicleId) {
    flags.push("OPEN_SUBSCRIPTION_ORDER_VEHICLE_MISMATCH");
  }
  if (current.customerId !== order.customerId) {
    flags.push("OPEN_SUBSCRIPTION_ORDER_CUSTOMER_MISMATCH");
  }
  if (!orderExpectsSubscription(order.orderStatus)) {
    flags.push("OPEN_SUBSCRIPTION_ORDER_STATUS_MISMATCH");
  }
  appendLeaseDiscrepancies(flags, lease);
  if (!vehicle) {
    flags.push("OPEN_SUBSCRIPTION_VEHICLE_MISSING");
  } else if (!vehicleExpectsSubscription(vehicle.status)) {
    flags.push("OPEN_SUBSCRIPTION_VEHICLE_STATUS_MISMATCH");
  }
  return flags;
}

function appendLeaseDiscrepancies(
  flags: AssetFactDiscrepancyFlag[],
  lease: LeaseAuthority | null
) {
  if (!lease) {
    flags.push("OPEN_SUBSCRIPTION_LEASE_MISSING");
  } else if (!leaseExpectsSubscription(lease.status)) {
    flags.push("OPEN_SUBSCRIPTION_LEASE_STATUS_MISMATCH");
  }
}

function orderExpectsSubscription(status: OrderStatus) {
  return (
    status === OrderStatus.ACTIVE ||
    status === OrderStatus.SUSPENDED ||
    status === OrderStatus.PENDING_RETURN
  );
}

function leaseExpectsSubscription(status: LeaseStatus) {
  return status === LeaseStatus.ACTIVE || status === LeaseStatus.RETURN_DUE;
}

function vehicleExpectsSubscription(status: VehicleStatus) {
  return status === VehicleStatus.LEASED || status === VehicleStatus.RENTED;
}

function findSubscriptionStartReplay(tx: Prisma.TransactionClient, dto: OpenSubscriptionPeriodDto) {
  return tx.vehicleSubscriptionPeriod.findFirst({
    where: subscriptionLiveWhere({
      startSourceId: dto.source.id,
      startSourceKey: dto.source.key,
      startSourceType: dto.source.type
    })
  });
}

function findSubscriptionEndReplay(tx: Prisma.TransactionClient, dto: CloseSubscriptionPeriodDto) {
  return tx.vehicleSubscriptionPeriod.findFirst({
    where: subscriptionLiveWhere({
      endSourceId: dto.source.id,
      endSourceKey: dto.source.key,
      endSourceType: dto.source.type
    })
  });
}

function findOwnershipStartReplay(tx: Prisma.TransactionClient, dto: OpenOwnershipPeriodDto) {
  return tx.vehicleOwnershipPeriod.findFirst({
    where: {
      startSourceId: dto.source.id,
      startSourceKey: dto.source.key,
      startSourceType: dto.source.type,
      vehicle: { deletedAt: null }
    }
  });
}

function findOwnershipEndReplay(tx: Prisma.TransactionClient, dto: CloseOwnershipPeriodDto) {
  return tx.vehicleOwnershipPeriod.findFirst({
    where: {
      endSourceId: dto.source.id,
      endSourceKey: dto.source.key,
      endSourceType: dto.source.type,
      vehicle: { deletedAt: null }
    }
  });
}

function subscriptionLiveWhere(
  where: Prisma.VehicleSubscriptionPeriodWhereInput
): Prisma.VehicleSubscriptionPeriodWhereInput {
  return {
    ...where,
    customer: { deletedAt: null },
    order: { deletedAt: null },
    vehicle: { deletedAt: null },
    OR: [{ contractId: null }, { contract: { deletedAt: null } }]
  };
}

function replaySnapshot(
  snapshot: Prisma.JsonValue | null | undefined,
  metadata: Prisma.JsonObject
): ImmutableFactSnapshot | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  if (!isDeepStrictEqual(snapshot.metadata ?? {}, metadata)) return null;
  return normalizeJsonObject(snapshot);
}

function normalizeMetadata(value: Record<string, unknown> | undefined): Prisma.JsonObject {
  return normalizeJsonObject(value ?? {});
}

function normalizeJsonObject(value: unknown): Prisma.JsonObject {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw badRequest(ASSET_FACT_SERVICE_CODE.INVALID_SOURCE, "Value is not JSON serializable.");
  }
  const normalized: unknown = JSON.parse(serialized);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw badRequest(ASSET_FACT_SERVICE_CODE.INVALID_SOURCE, "Value must be a JSON object.");
  }
  return normalized as Prisma.JsonObject;
}

function parseDate(value: string) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    throw badRequest(ASSET_FACT_SERVICE_CODE.INVALID_TIME, "Command time is invalid.");
  }
  return date;
}

function assertConfirmationTime(confirmedAt: Date, effectiveAt: Date) {
  if (confirmedAt.getTime() < effectiveAt.getTime()) {
    throw badRequest(
      ASSET_FACT_SERVICE_CODE.INVALID_CONFIRMATION_TIME,
      "Confirmation time cannot precede the effective fact time."
    );
  }
}

function assertEndAfterStart(startedAt: Date, endedAt: Date) {
  if (endedAt.getTime() <= startedAt.getTime()) {
    throw badRequest(
      ASSET_FACT_SERVICE_CODE.INVALID_TIME_RANGE,
      "Period end must be later than period start."
    );
  }
}

function assertStartReason(
  reason: VehicleOwnershipPeriodStartReason | VehicleSubscriptionPeriodStartReason,
  kind: "ownership" | "subscription"
) {
  const allowed =
    kind === "subscription"
      ? Object.values(VehicleSubscriptionPeriodStartReason)
      : Object.values(VehicleOwnershipPeriodStartReason);
  if (!(allowed as string[]).includes(reason)) {
    throw badRequest(ASSET_FACT_SERVICE_CODE.INVALID_START_REASON, "Start reason is invalid.");
  }
}

function assertEndReason(
  reason: VehicleOwnershipPeriodEndReason | VehicleSubscriptionPeriodEndReason,
  kind: "ownership" | "subscription"
) {
  const allowed =
    kind === "subscription"
      ? Object.values(VehicleSubscriptionPeriodEndReason)
      : Object.values(VehicleOwnershipPeriodEndReason);
  if (!(allowed as string[]).includes(reason)) {
    throw badRequest(ASSET_FACT_SERVICE_CODE.INVALID_END_REASON, "End reason is invalid.");
  }
}

function assertSource(source: { id: string; key: string; type: string }) {
  if (!source?.id?.trim() || !source.key?.trim() || !source.type?.trim()) {
    throw badRequest(ASSET_FACT_SERVICE_CODE.INVALID_SOURCE, "Stable source identity is required.");
  }
}

function toIso(value: Date | null) {
  return value?.toISOString() ?? null;
}

function badRequest(code: string, message: string) {
  return new BadRequestException({ code, message });
}

function notFound(code: string, message: string) {
  return new NotFoundException({ code, message });
}
