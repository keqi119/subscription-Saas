import { Injectable, NotFoundException } from "@nestjs/common";
import {
  BillStatus,
  ContractStatus,
  DepositTransactionStatus,
  DepositTransactionType,
  EntitlementUnit,
  OrderMileageReviewStatus,
  OrderStatus,
  Prisma
} from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { planPortalBucketPage } from "../common/portal-list-ordering";
import { CurrentCustomer } from "./portal-auth.types";
import {
  PortalBillsQueryDto,
  PortalDepositTransactionsQueryDto,
  PortalEntitlementsQueryDto,
  PortalEntitlementUsagesQueryDto,
  PortalOrdersQueryDto,
  PortalPageQueryDto
} from "./portal-billing.dto";

const PAYABLE_BILL_STATUSES = new Set<BillStatus>([
  BillStatus.PENDING,
  BillStatus.PARTIALLY_PAID,
  BillStatus.OVERDUE
]);
const PORTAL_BILL_STATUS_ORDER = [
  BillStatus.OVERDUE,
  BillStatus.PARTIALLY_PAID,
  BillStatus.PENDING,
  BillStatus.PAID,
  BillStatus.CANCELLED
] as const;
const WAIT_DELIVERY_ORDER_STATUSES = new Set<OrderStatus>([
  OrderStatus.PENDING_VEHICLE,
  OrderStatus.PENDING_DELIVERY
]);

const portalOrderInclude = {
  contract: {
    select: {
      contractNo: true,
      createdAt: true,
      id: true,
      signedAt: true,
      status: true
    }
  },
  contracts: {
    orderBy: { createdAt: "desc" as const },
    select: {
      contractNo: true,
      createdAt: true,
      id: true,
      signedAt: true,
      status: true
    },
    where: { deletedAt: null }
  },
  deliveries: {
    orderBy: { createdAt: "desc" as const },
    select: {
      deliveredAt: true,
      deliveryStatus: true,
      id: true,
      scheduledAt: true
    },
    take: 1,
    where: { deletedAt: null }
  },
  entitlementGrants: {
    orderBy: { createdAt: "desc" as const },
    select: {
      id: true,
      remainingAmount: true,
      status: true,
      totalAmount: true,
      unit: true,
      usedAmount: true
    },
    where: { deletedAt: null }
  },
  mileageReviews: {
    orderBy: [
      { cycleNo: "desc" as const },
      { version: "desc" as const },
      { createdAt: "desc" as const }
    ],
    select: {
      cycleNo: true,
      dueAt: true,
      id: true,
      lockVersion: true,
      overMileageBillId: true,
      scheduledReviewAt: true,
      status: true
    },
    take: 1,
    where: {
      deletedAt: null,
      status: { not: OrderMileageReviewStatus.VOIDED }
    }
  },
  productVersion: {
    include: {
      product: {
        select: {
          id: true,
          name: true,
          productNo: true
        }
      }
    }
  },
  receivableBills: {
    orderBy: { dueDate: "asc" as const },
    select: {
      amount: true,
      billStatus: true,
      billType: true,
      id: true,
      paidAmount: true,
      remainingAmount: true
    },
    where: { deletedAt: null }
  },
  vehicle: {
    select: {
      assetLocation: true,
      batteryCapacityKwh: true,
      batteryUsageType: true,
      brand: true,
      currentMileageKm: true,
      id: true,
      model: true,
      modelYear: true,
      series: true
    }
  }
} satisfies Prisma.SubscriptionOrderInclude;

const billDetailInclude = {
  order: {
    select: {
      id: true,
      orderNo: true,
      orderStatus: true
    }
  },
  paymentOrderItems: {
    include: {
      paymentOrder: {
        select: {
          id: true,
          paidAmount: true,
          paidAt: true,
          paymentChannel: true,
          paymentOrderNo: true,
          paymentStatus: true,
          provider: true
        }
      }
    },
    orderBy: { createdAt: "desc" as const },
    where: { deletedAt: null }
  },
  writeOffs: {
    include: {
      payment: {
        select: {
          id: true,
          paymentAmount: true,
          paymentMethod: true,
          paymentNo: true,
          paymentStatus: true,
          receivedAt: true
        }
      }
    },
    orderBy: { writeOffAt: "desc" as const },
    where: { deletedAt: null }
  }
} satisfies Prisma.ReceivableBillInclude;

type PortalOrder = Prisma.SubscriptionOrderGetPayload<{ include: typeof portalOrderInclude }>;
type BillDetail = Prisma.ReceivableBillGetPayload<{ include: typeof billDetailInclude }>;
type DepositLedgerRow = Prisma.DepositLedgerGetPayload<{
  include: { order: { select: { id: true; orderNo: true; orderStatus: true } } };
}>;
type EntitlementGrantRow = Prisma.OrderEntitlementGrantGetPayload<{
  include: {
    order: { select: { id: true; orderNo: true; orderStatus: true } };
    usages: { orderBy: { occurredAt: "desc" }; take: 1; where: { deletedAt: null } };
  };
}>;
type EntitlementUsageRow = Prisma.OrderEntitlementUsageGetPayload<{
  include: {
    grant: { select: { entitlementName: true; grantNo: true; id: true } };
    order: { select: { id: true; orderNo: true; orderStatus: true } };
  };
}>;

@Injectable()
export class PortalBillingService {
  constructor(private readonly prisma: PrismaService) {}

  async listOrders(currentCustomer: CurrentCustomer, query: PortalOrdersQueryDto) {
    const { page, pageSize, skip } = resolvePagination(query);
    const where: Prisma.SubscriptionOrderWhereInput = {
      customerId: currentCustomer.customerId,
      deletedAt: null,
      orderStatus: query.orderStatus as OrderStatus | undefined
    };
    const [items, total] = await Promise.all([
      this.prisma.subscriptionOrder.findMany({
        include: portalOrderInclude,
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
        where
      }),
      this.prisma.subscriptionOrder.count({ where })
    ]);

    return paged(items.map(toPortalOrderListItem), total, page, pageSize);
  }

  async getOrder(id: string, currentCustomer: CurrentCustomer) {
    const order = await this.prisma.subscriptionOrder.findFirst({
      include: portalOrderInclude,
      where: {
        customerId: currentCustomer.customerId,
        deletedAt: null,
        id
      }
    });

    if (!order) {
      throw new NotFoundException("订单不存在或不属于当前客户。");
    }

    const [billSummary, depositSummary, entitlementSummary] = await Promise.all([
      this.buildOrderBillSummary(order),
      this.buildOrderDepositSummary(order.id, currentCustomer.customerId),
      this.buildOrderEntitlementSummary(order.id, currentCustomer.customerId)
    ]);
    const mileageReviewSummary = toMileageReviewSummary(order);
    const nextAction = resolveOrderNextAction(
      order,
      billSummary.remainingAmount,
      mileageReviewSummary
    );

    return {
      ...toPortalOrderListItem(order),
      billingSummary: billSummary,
      contractSummary: toContractSummary(order),
      depositSummary,
      deliverySummary: toDeliverySummary(order),
      entitlementSummary,
      mileageReviewSummary,
      nextAction,
      nextActionTarget:
        nextAction === "SUBMIT_MILEAGE_REVIEW"
          ? toMileageReviewNextActionTarget(mileageReviewSummary)
          : null,
      order: toOrderSummary(order),
      subscriptionPlanSummary: toSubscriptionPlanSummary(order),
      vehicleSummary: toVehicleSummary(order)
    };
  }

  async listBills(currentCustomer: CurrentCustomer, query: PortalBillsQueryDto) {
    const { page, pageSize, skip } = resolvePagination(query);
    const baseWhere: Prisma.ReceivableBillWhereInput = {
      billType: query.billType,
      customerId: currentCustomer.customerId,
      deletedAt: null,
      orderId: query.orderId
    };
    const statuses = query.billStatus
      ? [query.billStatus]
      : [...PORTAL_BILL_STATUS_ORDER];

    return this.prisma.$transaction(async (tx) => {
      const counts = await Promise.all(
        statuses.map((status) =>
          tx.receivableBill.count({ where: { ...baseWhere, billStatus: status } })
        )
      );
      const slices = planPortalBucketPage(
        statuses.map((status, index) => ({ bucket: status, count: counts[index] ?? 0 })),
        skip,
        pageSize
      );
      const pages = await Promise.all(
        slices.map((slice) =>
          tx.receivableBill.findMany({
            include: { order: { select: { id: true, orderNo: true, orderStatus: true } } },
            orderBy: [
              { dueDate: "asc" },
              { updatedAt: "desc" },
              { createdAt: "desc" },
              { id: "asc" }
            ],
            skip: slice.skip,
            take: slice.take,
            where: { ...baseWhere, billStatus: slice.bucket }
          })
        )
      );
      const total = counts.reduce((sum, count) => sum + count, 0);

      return paged(pages.flat().map(toBillListItem), total, page, pageSize);
    });
  }

  async getBill(id: string, currentCustomer: CurrentCustomer) {
    const bill = await this.prisma.receivableBill.findFirst({
      include: billDetailInclude,
      where: {
        customerId: currentCustomer.customerId,
        deletedAt: null,
        id
      }
    });

    if (!bill) {
      throw new NotFoundException("账单不存在或不属于当前客户。");
    }

    return toBillDetail(bill);
  }

  async getDepositOverview(currentCustomer: CurrentCustomer) {
    const ledgers = await this.prisma.depositLedger.findMany({
      include: {
        order: { select: { id: true, orderNo: true, orderStatus: true } }
      },
      orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }],
      where: {
        customerId: currentCustomer.customerId,
        deletedAt: null,
        transactionStatus: DepositTransactionStatus.CONFIRMED
      }
    });

    return buildDepositOverview(ledgers);
  }

  async listDepositTransactions(
    currentCustomer: CurrentCustomer,
    query: PortalDepositTransactionsQueryDto
  ) {
    const { page, pageSize, skip } = resolvePagination(query);
    const where: Prisma.DepositLedgerWhereInput = {
      customerId: currentCustomer.customerId,
      deletedAt: null,
      orderId: query.orderId,
      transactionType: query.transactionType
    };
    const [items, total] = await Promise.all([
      this.prisma.depositLedger.findMany({
        include: {
          order: { select: { id: true, orderNo: true, orderStatus: true } }
        },
        orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
        skip,
        take: pageSize,
        where
      }),
      this.prisma.depositLedger.count({ where })
    ]);

    return paged(items.map(toDepositTransaction), total, page, pageSize);
  }

  async listEntitlements(currentCustomer: CurrentCustomer, query: PortalEntitlementsQueryDto) {
    const { page, pageSize, skip } = resolvePagination(query);
    const where: Prisma.OrderEntitlementGrantWhereInput = {
      customerId: currentCustomer.customerId,
      deletedAt: null,
      orderId: query.orderId,
      status: query.status
    };
    const [items, total] = await Promise.all([
      this.prisma.orderEntitlementGrant.findMany({
        include: {
          order: { select: { id: true, orderNo: true, orderStatus: true } },
          usages: {
            orderBy: { occurredAt: "desc" },
            take: 1,
            where: { deletedAt: null }
          }
        },
        orderBy: [{ grantPeriodStart: "desc" }, { createdAt: "desc" }],
        skip,
        take: pageSize,
        where
      }),
      this.prisma.orderEntitlementGrant.count({ where })
    ]);

    return paged(items.map(toEntitlementGrantItem), total, page, pageSize);
  }

  async listEntitlementUsages(
    currentCustomer: CurrentCustomer,
    query: PortalEntitlementUsagesQueryDto
  ) {
    const { page, pageSize, skip } = resolvePagination(query);
    const where: Prisma.OrderEntitlementUsageWhereInput = {
      customerId: currentCustomer.customerId,
      deletedAt: null,
      grantId: query.grantId,
      orderId: query.orderId
    };
    const [items, total] = await Promise.all([
      this.prisma.orderEntitlementUsage.findMany({
        include: {
          grant: { select: { entitlementName: true, grantNo: true, id: true } },
          order: { select: { id: true, orderNo: true, orderStatus: true } }
        },
        orderBy: { occurredAt: "desc" },
        skip,
        take: pageSize,
        where
      }),
      this.prisma.orderEntitlementUsage.count({ where })
    ]);

    return paged(items.map(toEntitlementUsageItem), total, page, pageSize);
  }

  private async buildOrderBillSummary(order: PortalOrder) {
    const payableBills = order.receivableBills.filter(isBillPayable);
    const totalAmount = order.receivableBills.reduce((sum, bill) => sum + bill.amount, 0n);
    const paidAmount = order.receivableBills.reduce((sum, bill) => sum + bill.paidAmount, 0n);
    const remainingAmount = order.receivableBills.reduce(
      (sum, bill) => sum + bill.remainingAmount,
      0n
    );

    return {
      bills: order.receivableBills.map((bill) => ({
        amount: Number(bill.amount),
        billId: bill.id,
        billStatus: bill.billStatus,
        billType: bill.billType,
        canPay: isBillPayable(bill),
        paidAmount: Number(bill.paidAmount),
        remainingAmount: Number(bill.remainingAmount)
      })),
      paidAmount: Number(paidAmount),
      payableBillCount: payableBills.length,
      remainingAmount: Number(remainingAmount),
      totalAmount: Number(totalAmount)
    };
  }

  private async buildOrderDepositSummary(orderId: string, customerId: string) {
    const ledgers = await this.prisma.depositLedger.findMany({
      include: {
        order: { select: { id: true, orderNo: true, orderStatus: true } }
      },
      orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }],
      where: {
        customerId,
        deletedAt: null,
        orderId,
        transactionStatus: DepositTransactionStatus.CONFIRMED
      }
    });
    return (
      buildDepositOverview(ledgers).accounts[0] ??
      toPlainDepositAccount(emptyDepositAccount(orderId))
    );
  }

  private async buildOrderEntitlementSummary(orderId: string, customerId: string) {
    const grants = await this.prisma.orderEntitlementGrant.findMany({
      where: {
        customerId,
        deletedAt: null,
        orderId
      }
    });

    return {
      activeGrantCount: grants.filter((grant) => grant.status === "ACTIVE").length,
      grantCount: grants.length,
      exhaustedGrantCount: grants.filter((grant) => grant.status === "EXHAUSTED").length
    };
  }
}

function resolvePagination(query: PortalPageQueryDto) {
  const page = Math.max(1, Number(query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 20)));
  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize
  };
}

function paged<T>(items: T[], total: number, page: number, pageSize: number) {
  return {
    items,
    page,
    pageSize,
    total
  };
}

function toPortalOrderListItem(order: PortalOrder) {
  const billSummary = summarizeBills(order.receivableBills);
  return {
    actualDeliveryAt: toIsoDateTime(order.actualDeliveryAt),
    contractStatus: toContractSummary(order)?.contractStatus ?? null,
    createdAt: toIsoDateTime(order.createdAt),
    deliveryStatus: toDeliverySummary(order).deliveryStatus,
    id: order.id,
    orderId: order.id,
    orderNo: order.orderNo,
    orderStatus: order.orderStatus,
    paymentStatus: resolvePaymentStatus(order.receivableBills),
    subscriptionPlanSummary: toSubscriptionPlanSummary(order),
    vehicleSummary: toVehicleSummary(order),
    ...billSummary
  };
}

function toOrderSummary(order: PortalOrder) {
  return {
    actualDeliveryAt: toIsoDateTime(order.actualDeliveryAt),
    actualReturnAt: toIsoDateTime(order.actualReturnAt),
    createdAt: toIsoDateTime(order.createdAt),
    endDate: toIsoDate(order.endDate),
    id: order.id,
    monthlyFeeAmount: Number(order.monthlyFeeAmount),
    orderNo: order.orderNo,
    orderSource: order.orderSource,
    orderStatus: order.orderStatus,
    periodMonths: order.periodMonths,
    startDate: toIsoDate(order.startDate)
  };
}

function toVehicleSummary(order: PortalOrder) {
  const vehicle = order.vehicle;
  if (!vehicle) {
    return null;
  }
  const summary = {
    batteryCapacityKwh:
      vehicle.batteryCapacityKwh === null ? null : Number(vehicle.batteryCapacityKwh),
    batteryUsageType: vehicle.batteryUsageType,
    brand: vehicle.brand,
    city: vehicle.assetLocation,
    currentMileageKm: vehicle.currentMileageKm,
    displayName: [
      vehicle.brand,
      vehicle.series,
      vehicle.model,
      vehicle.modelYear ? `${vehicle.modelYear}款` : null
    ]
      .filter(Boolean)
      .join(" "),
    id: vehicle.id,
    model: vehicle.model,
    modelCode: order.modelCodeSnapshot,
    modelDefinitionId: order.modelDefinitionIdSnapshot,
    modelDisplayName: order.modelDisplayNameSnapshot,
    modelYear: vehicle.modelYear,
    series: vehicle.series
  };

  return {
    ...summary,
    displayName: order.modelDisplayNameSnapshot || summary.displayName
  };
}

function toSubscriptionPlanSummary(order: PortalOrder) {
  const snapshot =
    toRecord(order.finalPlanSnapshot) ??
    toRecord(order.customerSelectedSnapshot) ??
    toRecord(order.quoteSnapshot);
  const planSnapshot =
    toRecord(snapshot?.subscriptionPlan) ??
    toRecord(snapshot?.plan) ??
    toRecord(snapshot?.subscriptionPlanSnapshot) ??
    snapshot;

  return {
    mileageLimitKm: order.mileageLimitKm,
    monthlyFeeAmount: Number(order.monthlyFeeAmount),
    overMileageFeeAmount: Number(order.overMileageFeeAmount),
    periodMonths: order.periodMonths,
    planName:
      stringOrNull(planSnapshot?.planName) ??
      stringOrNull(planSnapshot?.name) ??
      order.productVersion.product.name,
    productName: order.productVersion.product.name
  };
}

function toContractSummary(order: PortalOrder) {
  const contract = order.contract ?? order.contracts[0] ?? null;
  if (!contract) {
    return null;
  }
  return {
    contractId: contract.id,
    contractNo: contract.contractNo,
    contractStatus: contract.status,
    createdAt: toIsoDateTime(contract.createdAt),
    signedAt: toIsoDateTime(contract.signedAt)
  };
}

function toDeliverySummary(order: PortalOrder) {
  const delivery = order.deliveries[0];
  return {
    deliveredAt: toIsoDateTime(delivery?.deliveredAt ?? order.actualDeliveryAt),
    deliveryStatus: delivery?.deliveryStatus ?? (order.actualDeliveryAt ? "DELIVERED" : null),
    scheduledAt: toIsoDateTime(delivery?.scheduledAt)
  };
}

function summarizeBills(bills: PortalOrder["receivableBills"]) {
  const remainingAmount = bills.reduce((sum, bill) => sum + bill.remainingAmount, 0n);
  return {
    billCount: bills.length,
    payableBillCount: bills.filter(isBillPayable).length,
    remainingAmount: Number(remainingAmount)
  };
}

function resolvePaymentStatus(bills: PortalOrder["receivableBills"]) {
  if (bills.length === 0) {
    return "NONE";
  }
  if (
    bills.every(
      (bill) => bill.billStatus === BillStatus.PAID || bill.billStatus === BillStatus.CANCELLED
    )
  ) {
    return "PAID";
  }
  if (bills.some((bill) => bill.billStatus === BillStatus.OVERDUE && bill.remainingAmount > 0n)) {
    return "OVERDUE";
  }
  if (bills.some((bill) => bill.paidAmount > 0n)) {
    return "PARTIALLY_PAID";
  }
  return "PENDING";
}

function resolveOrderNextAction(
  order: PortalOrder,
  remainingAmount: number,
  mileageReviewSummary: ReturnType<typeof toMileageReviewSummary>
) {
  const contract = toContractSummary(order);
  if (
    contract &&
    contract.contractStatus !== ContractStatus.SIGNED &&
    contract.contractStatus !== ContractStatus.ARCHIVED
  ) {
    return "SIGN_CONTRACT";
  }
  if (remainingAmount > 0) {
    return "PAY_BILL";
  }
  if (WAIT_DELIVERY_ORDER_STATUSES.has(order.orderStatus)) {
    return "WAIT_DELIVERY";
  }
  if (mileageReviewSummary?.hasAction) {
    return "SUBMIT_MILEAGE_REVIEW";
  }
  if (order.entitlementGrants.length > 0) {
    return "VIEW_ENTITLEMENTS";
  }
  return "NONE";
}

function toMileageReviewSummary(order: PortalOrder) {
  const review = order.mileageReviews[0];
  if (!review) {
    return null;
  }
  const hasAction =
    order.orderStatus === OrderStatus.ACTIVE &&
    (review.status === OrderMileageReviewStatus.PENDING_SUBMISSION ||
      review.status === OrderMileageReviewStatus.RETURNED);
  return {
    actionUrl: hasAction ? `/portal/mileage-reviews/${review.id}` : null,
    currentReviewId: review.id,
    cycleNo: review.cycleNo,
    dueAt: toIsoDateTime(review.dueAt),
    hasAction,
    lockVersion: review.lockVersion,
    overdue:
      review.status === OrderMileageReviewStatus.PENDING_SUBMISSION &&
      Date.now() > review.dueAt.getTime(),
    overMileageBillId: review.overMileageBillId,
    scheduledReviewAt: toIsoDateTime(review.scheduledReviewAt),
    status: review.status
  };
}

function toMileageReviewNextActionTarget(summary: ReturnType<typeof toMileageReviewSummary>) {
  if (!summary?.hasAction || !summary.actionUrl) {
    return null;
  }
  return {
    label: "提交里程复核",
    url: summary.actionUrl
  };
}

function toBillListItem(
  bill: Prisma.ReceivableBillGetPayload<{
    include: { order: { select: { id: true; orderNo: true; orderStatus: true } } };
  }>
) {
  return {
    amount: Number(bill.amount),
    billId: bill.id,
    billNo: bill.billNo,
    billStatus: bill.billStatus,
    billType: bill.billType,
    canPay: isBillPayable(bill),
    dueDate: toIsoDateTime(bill.dueDate),
    orderId: bill.orderId,
    orderNo: bill.order.orderNo,
    orderStatus: bill.order.orderStatus,
    paidAmount: Number(bill.paidAmount),
    periodEnd: toIsoDate(bill.billPeriodEnd),
    periodStart: toIsoDate(bill.billPeriodStart),
    remainingAmount: Number(bill.remainingAmount)
  };
}

function toBillDetail(bill: BillDetail) {
  return {
    ...toBillListItem(bill),
    paymentOrders: bill.paymentOrderItems.map((item) => ({
      amount: Number(item.amount),
      paidAmount: Number(item.paymentOrder.paidAmount),
      paidAt: toIsoDateTime(item.paymentOrder.paidAt),
      paymentChannel: item.paymentOrder.paymentChannel,
      paymentOrderId: item.paymentOrder.id,
      paymentOrderNo: item.paymentOrder.paymentOrderNo,
      paymentStatus: item.paymentOrder.paymentStatus,
      provider: item.paymentOrder.provider
    })),
    writeOffs: bill.writeOffs.map((writeOff) => ({
      paymentAmount: Number(writeOff.payment.paymentAmount),
      paymentId: writeOff.paymentId,
      paymentMethod: writeOff.payment.paymentMethod,
      paymentNo: writeOff.payment.paymentNo,
      paymentStatus: writeOff.payment.paymentStatus,
      receivedAt: toIsoDateTime(writeOff.payment.receivedAt),
      remark: writeOff.remark,
      writeOffAmount: Number(writeOff.writeOffAmount),
      writeOffAt: toIsoDateTime(writeOff.writeOffAt),
      writeOffId: writeOff.id
    }))
  };
}

function isBillPayable(bill: { billStatus: BillStatus; remainingAmount: bigint }) {
  return PAYABLE_BILL_STATUSES.has(bill.billStatus) && bill.remainingAmount > 0n;
}

function buildDepositOverview(ledgers: DepositLedgerRow[]) {
  const accounts = new Map<string, ReturnType<typeof emptyDepositAccount>>();
  const totals = {
    totalCollectedAmount: 0n,
    totalDeductedAmount: 0n,
    totalFrozenAmount: 0n,
    totalRefundedAmount: 0n,
    totalReleasedAmount: 0n
  };

  for (const ledger of ledgers) {
    const account =
      accounts.get(ledger.orderId) ?? emptyDepositAccount(ledger.orderId, ledger.order.orderNo);
    applyDepositAmount(account, ledger.transactionType, ledger.amount);
    account.lastTransactionAt = toIsoDateTime(ledger.occurredAt);
    account.orderStatus = ledger.order.orderStatus;
    account.remainingAmount =
      account.collectedAmount -
      account.deductedAmount -
      account.refundedAmount -
      account.frozenAmount +
      account.releasedAmount;
    accounts.set(ledger.orderId, account);
    applyDepositTotal(totals, ledger.transactionType, ledger.amount);
  }

  const availableAmount =
    totals.totalCollectedAmount -
    totals.totalDeductedAmount -
    totals.totalRefundedAmount -
    totals.totalFrozenAmount +
    totals.totalReleasedAmount;

  return {
    accounts: [...accounts.values()].map(toPlainDepositAccount),
    availableAmount: Number(availableAmount),
    totalCollectedAmount: Number(totals.totalCollectedAmount),
    totalDeductedAmount: Number(totals.totalDeductedAmount),
    totalFrozenAmount: Number(totals.totalFrozenAmount),
    totalRefundedAmount: Number(totals.totalRefundedAmount)
  };
}

function emptyDepositAccount(orderId: string, orderNo: string | null = null) {
  return {
    collectedAmount: 0n,
    deductedAmount: 0n,
    frozenAmount: 0n,
    lastTransactionAt: null as string | null,
    orderId,
    orderNo,
    orderStatus: null as string | null,
    refundedAmount: 0n,
    releasedAmount: 0n,
    remainingAmount: 0n,
    status: "NONE"
  };
}

function applyDepositAmount(
  account: ReturnType<typeof emptyDepositAccount>,
  type: DepositTransactionType,
  amount: bigint
) {
  if (type === DepositTransactionType.COLLECT) {
    account.collectedAmount += amount;
  } else if (type === DepositTransactionType.DEDUCT) {
    account.deductedAmount += amount;
  } else if (type === DepositTransactionType.REFUND) {
    account.refundedAmount += amount;
  } else if (type === DepositTransactionType.FREEZE) {
    account.frozenAmount += amount;
  } else if (type === DepositTransactionType.RELEASE) {
    account.releasedAmount += amount;
  }
  account.status =
    account.remainingAmount > 0n || type === DepositTransactionType.COLLECT ? "ACTIVE" : "NONE";
}

function applyDepositTotal(
  totals: {
    totalCollectedAmount: bigint;
    totalDeductedAmount: bigint;
    totalFrozenAmount: bigint;
    totalRefundedAmount: bigint;
    totalReleasedAmount: bigint;
  },
  type: DepositTransactionType,
  amount: bigint
) {
  if (type === DepositTransactionType.COLLECT) {
    totals.totalCollectedAmount += amount;
  } else if (type === DepositTransactionType.DEDUCT) {
    totals.totalDeductedAmount += amount;
  } else if (type === DepositTransactionType.REFUND) {
    totals.totalRefundedAmount += amount;
  } else if (type === DepositTransactionType.FREEZE) {
    totals.totalFrozenAmount += amount;
  } else if (type === DepositTransactionType.RELEASE) {
    totals.totalReleasedAmount += amount;
  }
}

function toPlainDepositAccount(account: ReturnType<typeof emptyDepositAccount>) {
  const status =
    account.remainingAmount > 0n ? "ACTIVE" : account.collectedAmount > 0n ? "SETTLED" : "NONE";
  return {
    collectedAmount: Number(account.collectedAmount),
    deductedAmount: Number(account.deductedAmount),
    frozenAmount: Number(account.frozenAmount),
    lastTransactionAt: account.lastTransactionAt,
    orderId: account.orderId,
    orderNo: account.orderNo,
    orderStatus: account.orderStatus,
    refundedAmount: Number(account.refundedAmount),
    remainingAmount: Number(account.remainingAmount),
    status
  };
}

function toDepositTransaction(ledger: DepositLedgerRow) {
  return {
    amount: Number(ledger.amount),
    balanceAfter: Number(ledger.balanceAfter),
    occurredAt: toIsoDateTime(ledger.occurredAt),
    orderId: ledger.orderId,
    orderNo: ledger.order.orderNo,
    remark: ledger.remark,
    transactionId: ledger.id,
    transactionStatus: ledger.transactionStatus,
    transactionType: ledger.transactionType
  };
}

function toEntitlementGrantItem(grant: EntitlementGrantRow) {
  const latestUsage = grant.usages[0];
  return {
    entitlementType: grant.entitlementType,
    grantId: grant.id,
    grantNo: grant.grantNo,
    latestUsageAt: toIsoDateTime(latestUsage?.occurredAt),
    name: grant.entitlementName,
    orderId: grant.orderId,
    orderNo: grant.order.orderNo,
    remainingAmount: decimalOrNull(grant.remainingAmount, grant.unit),
    remark: grant.remark,
    source: grant.grantSource,
    status: grant.status,
    totalAmount: decimalOrNull(grant.totalAmount, grant.unit),
    unit: grant.unit,
    usedAmount: decimalOrNull(grant.usedAmount, grant.unit),
    validFrom: toIsoDate(grant.grantPeriodStart),
    validTo: toIsoDate(grant.grantPeriodEnd)
  };
}

function toEntitlementUsageItem(usage: EntitlementUsageRow) {
  return {
    amount: Number(usage.usedAmount),
    entitlementType: usage.entitlementType,
    externalRefNo: usage.externalRefNo,
    grantId: usage.grantId,
    grantName: usage.grant.entitlementName,
    grantNo: usage.grant.grantNo,
    occurredAt: toIsoDateTime(usage.occurredAt),
    orderId: usage.orderId,
    orderNo: usage.order.orderNo,
    remark: usage.remark,
    source: usage.usageSource,
    status: usage.usageStatus,
    unit: usage.unit,
    usageId: usage.id,
    usageNo: usage.usageNo
  };
}

function decimalOrNull(value: Prisma.Decimal | null, unit: EntitlementUnit) {
  if (unit === EntitlementUnit.TEXT) {
    return null;
  }
  return value === null ? null : Number(value);
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function toIsoDateTime(value?: Date | string | null) {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : value;
}

function toIsoDate(value?: Date | string | null) {
  const dateTime = toIsoDateTime(value);
  return dateTime ? dateTime.slice(0, 10) : null;
}
