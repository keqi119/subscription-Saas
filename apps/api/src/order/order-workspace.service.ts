import { Injectable, NotFoundException } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import type { RequestUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import type {
  OrderWorkspaceGuideCategory,
  OrderWorkspaceGuideItem,
  OrderWorkspaceState,
  OrderWorkspaceSummary
} from "./order-workspace.types";
import { OrderService } from "./order.service";

const CATEGORY_ORDER: OrderWorkspaceGuideCategory[] = [
  "contract",
  "handover",
  "entitlement",
  "service",
  "finance",
  "change"
];

const STATE_PRIORITY: Record<OrderWorkspaceState, number> = {
  BLOCKED: 9,
  ACTION_REQUIRED: 8,
  FAILED: 7,
  PROCESSING: 6,
  WAITING_EXTERNAL: 5,
  READY: 4,
  COMPLETED: 3,
  NOT_STARTED: 2,
  UNAVAILABLE: 1
};

const ATTENTION_STATES = new Set<OrderWorkspaceState>(["BLOCKED", "ACTION_REQUIRED", "FAILED"]);
const NON_ACTIONABLE_STATES = new Set<OrderWorkspaceState>(["COMPLETED", "NOT_STARTED", "UNAVAILABLE"]);
const HANDOVER_SIGNING_START_GRACE_MS = 15 * 60 * 1000;

type WorkspaceAccess = Record<OrderWorkspaceGuideCategory, { view: boolean; action: boolean }>;

type ResolverInput = {
  access: WorkspaceAccess;
  asOf: string;
  guidance: OrderWorkspaceGuideItem[];
  header: OrderWorkspaceSummary["header"];
  recentActivity: OrderWorkspaceSummary["recentActivity"];
};

export type ContractWorkspaceFacts = {
  contracts: Array<{
    id: string;
    status: string;
    tasks: Array<{ taskStatus: string; updatedAt: string }>;
    updatedAt: string;
  }>;
};

export type HandoverWorkspaceFacts = {
  asOf: string;
  workOrder: {
    assigned: boolean;
    handover: {
      archiveStatus: string;
      id: string;
      signers: Array<{ required: boolean; signerStatus: string }>;
      status: string;
      taskStatus: string | null;
      updatedAt: string;
    } | null;
    id: string;
    status: string;
    updatedAt: string;
  } | null;
};

export type EntitlementWorkspaceFacts = {
  account: {
    grants: Array<{ status: string }>;
    id: string;
    status: string;
    updatedAt: string;
  } | null;
  orderStatus: string;
};

export type ServiceWorkspaceFacts = {
  cases: Array<{
    assigned: boolean;
    id: string;
    status: string;
    updatedAt: string;
  }>;
};

export type FinanceWorkspaceFacts = {
  asOf: string;
  depositEntries: Array<{
    id: string;
    status: string;
    transactionType: string;
    updatedAt: string;
  }>;
  paymentOrders: Array<{ id: string; status: string; updatedAt: string }>;
  receivableBills: Array<{
    billStatus: string;
    dueDate: string;
    id: string;
    updatedAt: string;
  }>;
};

export type ChangeWorkspaceFacts = {
  changes: Array<{ id: string; status: string; updatedAt: string }>;
};

@Injectable()
export class OrderWorkspaceResolver {
  resolve(input: ResolverInput): OrderWorkspaceSummary {
    const guidance = input.guidance
      .filter((item) => input.access[item.category].view)
      .map((item) => {
        const stateForcesNoAction = NON_ACTIONABLE_STATES.has(item.state);
        return {
          ...item,
          actionCode: input.access[item.category].action && !stateForcesNoAction ? item.actionCode : null,
          priority: STATE_PRIORITY[item.state]
        };
      })
      .sort((left, right) => CATEGORY_ORDER.indexOf(left.category) - CATEGORY_ORDER.indexOf(right.category));

    const primary = [...guidance]
      .filter((item) => item.actionCode !== null)
      .sort(comparePrimaryAction)[0];

    return {
      asOf: input.asOf,
      guidance,
      header: input.header,
      primaryAction: primary
        ? {
            actionCode: primary.actionCode!,
            targetRecordId: primary.targetRecordId,
            targetTab: primary.targetTab
          }
        : null,
      recentActivity: input.recentActivity,
      tabBadges: guidance.map((item) => ({
        attentionCount: ATTENTION_STATES.has(item.state) ? 1 + item.additionalCount : 0,
        count: 1 + item.additionalCount,
        tab: item.category
      }))
    };
  }

  resolveContract(facts: ContractWorkspaceFacts): OrderWorkspaceGuideItem {
    const contract = facts.contracts[0];
    if (!contract) {
      return guideItem("contract", "BLOCKED", "CONTRACT_REQUIRED", "contract.generate", null, null, true);
    }

    const failedTask = contract.tasks.find((task) => task.taskStatus === "FAILED");
    if (failedTask) {
      return guideItem(
        "contract",
        "FAILED",
        "CONTRACT_SIGNATURE_FAILED",
        "contract.retry_signing",
        contract.id,
        failedTask.updatedAt,
        true
      );
    }

    if (["SIGNED", "ARCHIVED"].includes(contract.status)) {
      return guideItem("contract", "COMPLETED", "CONTRACT_SIGNED", null, contract.id, contract.updatedAt);
    }

    const actionCode = ["DRAFT", "CANCELLED"].includes(contract.status) ? "contract.generate" : "contract.sign";
    return guideItem(
      "contract",
      "ACTION_REQUIRED",
      contract.status === "SIGNING" ? "CONTRACT_SIGNATURE_PENDING" : "CONTRACT_SIGNATURE_REQUIRED",
      actionCode,
      contract.id,
      contract.updatedAt,
      true
    );
  }

  resolveHandover(facts: HandoverWorkspaceFacts): OrderWorkspaceGuideItem {
    const workOrder = facts.workOrder;
    if (!workOrder) {
      return guideItem("handover", "NOT_STARTED", "HANDOVER_NOT_STARTED", null, null, null);
    }

    if (!workOrder.assigned || workOrder.status === "DRAFT") {
      return guideItem(
        "handover",
        "ACTION_REQUIRED",
        "HANDOVER_FIELD_UNASSIGNED",
        "handover.assign",
        workOrder.id,
        workOrder.updatedAt
      );
    }

    const handover = workOrder.handover;
    if (workOrder.status === "FAILED" || handover?.status === "FAILED" || handover?.taskStatus === "FAILED") {
      return guideItem(
        "handover",
        "FAILED",
        "HANDOVER_STAGE2_FAILED",
        "handover.retry_signing",
        handover?.id ?? workOrder.id,
        handover?.updatedAt ?? workOrder.updatedAt,
        true
      );
    }

    if (handover) {
      const requiredSigners = handover.signers.filter((signer) => signer.required);
      if (requiredSigners.length >= 2 && requiredSigners.every((signer) => signer.signerStatus === "SIGNED")) {
        return guideItem(
          "handover",
          "COMPLETED",
          "HANDOVER_STAGE2_SIGNED",
          null,
          handover.id,
          handover.updatedAt
        );
      }

      if (handover.taskStatus) {
        return guideItem(
          "handover",
          "ACTION_REQUIRED",
          "HANDOVER_SIGNER_PENDING",
          "handover.follow_up_signing",
          handover.id,
          handover.updatedAt
        );
      }
    }

    if (workOrder.status === "CUSTOMER_CONFIRMED") {
      const elapsed = Date.parse(facts.asOf) - Date.parse(workOrder.updatedAt);
      const overdue = elapsed >= HANDOVER_SIGNING_START_GRACE_MS;
      return guideItem(
        "handover",
        overdue ? "ACTION_REQUIRED" : "PROCESSING",
        overdue ? "HANDOVER_SIGNING_START_OVERDUE" : "HANDOVER_SIGNING_START_PENDING",
        overdue ? "handover.start_signing" : null,
        workOrder.id,
        workOrder.updatedAt
      );
    }

    if (["EVIDENCE_SUBMITTED", "CUSTOMER_REVIEWING"].includes(workOrder.status)) {
      return guideItem(
        "handover",
        "WAITING_EXTERNAL",
        "HANDOVER_CUSTOMER_REVIEW_PENDING",
        null,
        workOrder.id,
        workOrder.updatedAt
      );
    }

    return guideItem(
      "handover",
      "WAITING_EXTERNAL",
      "HANDOVER_FIELD_PROGRESS_PENDING",
      null,
      workOrder.id,
      workOrder.updatedAt
    );
  }

  resolveEntitlement(facts: EntitlementWorkspaceFacts): OrderWorkspaceGuideItem {
    if (!facts.account) {
      if (facts.orderStatus === "ACTIVE") {
        return guideItem(
          "entitlement",
          "ACTION_REQUIRED",
          "ENTITLEMENT_ACTIVATION_REQUIRED",
          "entitlement.activate",
          null,
          null
        );
      }
      return guideItem("entitlement", "NOT_STARTED", "ENTITLEMENT_NOT_DUE", null, null, null);
    }

    if (facts.account.status !== "ACTIVE" || facts.account.grants.some((grant) => grant.status === "CANCELLED")) {
      return guideItem(
        "entitlement",
        "ACTION_REQUIRED",
        "ENTITLEMENT_RECONCILIATION_REQUIRED",
        "entitlement.reconcile",
        facts.account.id,
        facts.account.updatedAt
      );
    }

    if (facts.account.grants.length === 0) {
      return guideItem(
        "entitlement",
        "ACTION_REQUIRED",
        "ENTITLEMENT_ACTIVATION_REQUIRED",
        "entitlement.activate",
        facts.account.id,
        facts.account.updatedAt
      );
    }

    return guideItem(
      "entitlement",
      "COMPLETED",
      "ENTITLEMENT_CURRENT",
      null,
      facts.account.id,
      facts.account.updatedAt
    );
  }

  resolveService(facts: ServiceWorkspaceFacts): OrderWorkspaceGuideItem {
    const serviceCase = facts.cases[0];
    if (!serviceCase) {
      return guideItem("service", "COMPLETED", "SERVICE_NO_OPEN_CASE", null, null, null);
    }

    if (serviceCase.status === "WAITING_CUSTOMER") {
      return guideItem(
        "service",
        "WAITING_EXTERNAL",
        "SERVICE_WAITING_CUSTOMER",
        null,
        serviceCase.id,
        serviceCase.updatedAt,
        false,
        facts.cases.length - 1
      );
    }

    return guideItem(
      "service",
      "ACTION_REQUIRED",
      serviceCase.assigned ? "SERVICE_CASE_ACTION_REQUIRED" : "SERVICE_CASE_ASSIGNMENT_REQUIRED",
      "service.resolve",
      serviceCase.id,
      serviceCase.updatedAt,
      false,
      facts.cases.length - 1
    );
  }

  resolveFinance(facts: FinanceWorkspaceFacts): OrderWorkspaceGuideItem {
    const failedPayment = facts.paymentOrders.find((payment) => payment.status === "FAILED");
    if (failedPayment) {
      return guideItem(
        "finance",
        "FAILED",
        "FINANCE_RECONCILIATION_REQUIRED",
        "finance.reconcile",
        failedPayment.id,
        failedPayment.updatedAt
      );
    }

    const pendingDeposit = facts.depositEntries.find((entry) => entry.status === "PENDING");
    if (pendingDeposit) {
      return guideItem(
        "finance",
        "ACTION_REQUIRED",
        "FINANCE_DEPOSIT_SETTLEMENT_REQUIRED",
        "finance.settle_deposit",
        pendingDeposit.id,
        pendingDeposit.updatedAt
      );
    }

    const dueBills = facts.receivableBills
      .filter((bill) => bill.billStatus === "OVERDUE" || Date.parse(bill.dueDate) <= Date.parse(facts.asOf))
      .sort((left, right) => Date.parse(left.dueDate) - Date.parse(right.dueDate));
    const dueBill = dueBills[0];
    if (dueBill) {
      return guideItem(
        "finance",
        "ACTION_REQUIRED",
        dueBill.billStatus === "OVERDUE" ? "FINANCE_PAYMENT_OVERDUE" : "FINANCE_PAYMENT_DUE",
        "finance.collect",
        dueBill.id,
        dueBill.updatedAt,
        false,
        dueBills.length - 1
      );
    }

    return guideItem("finance", "COMPLETED", "FINANCE_NO_ACTION_DUE", null, null, null);
  }

  resolveChange(facts: ChangeWorkspaceFacts): OrderWorkspaceGuideItem {
    const failed = facts.changes.find((change) => change.status === "FAILED");
    if (failed) {
      return guideItem(
        "change",
        "FAILED",
        "CHANGE_WORKFLOW_FAILED",
        "change.retry",
        failed.id,
        failed.updatedAt
      );
    }

    const pending = facts.changes.find((change) => change.status === "PENDING");
    if (pending) {
      return guideItem(
        "change",
        "ACTION_REQUIRED",
        "CHANGE_APPROVAL_PENDING",
        "change.approve",
        pending.id,
        pending.updatedAt
      );
    }

    const approved = facts.changes.find((change) => change.status === "APPROVED");
    if (approved) {
      return guideItem(
        "change",
        "ACTION_REQUIRED",
        "CHANGE_EXECUTION_REQUIRED",
        "change.execute",
        approved.id,
        approved.updatedAt
      );
    }

    return guideItem("change", "COMPLETED", "CHANGE_NONE_PENDING", null, null, null);
  }

  unavailable(category: OrderWorkspaceGuideCategory): OrderWorkspaceGuideItem {
    return guideItem(category, "UNAVAILABLE", `${category.toUpperCase()}_UNAVAILABLE`, null, null, null);
  }
}

@Injectable()
export class OrderWorkspaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orderService: OrderService,
    private readonly resolver: OrderWorkspaceResolver
  ) {}

  async getSummary(id: string, user: RequestUser): Promise<OrderWorkspaceSummary> {
    await this.orderService.getOrder(id, user);

    const headerRecord = await this.prisma.subscriptionOrder.findUnique({
      select: {
        application: { select: { salesUser: { select: { name: true } } } },
        customer: { select: { name: true } },
        id: true,
        orderNo: true,
        orderStatus: true,
        vehicle: {
          select: {
            modelDefinition: { select: { displayName: true } },
            plateNo: true,
            vehicleNo: true
          }
        }
      },
      where: { id }
    });
    if (!headerRecord) {
      throw new NotFoundException("Order not found.");
    }

    const asOf = new Date().toISOString();
    const access = resolveAccess(user);
    const guidance = await Promise.all([
      this.loadContributor("contract", access, () => this.loadContract(id)),
      this.loadContributor("handover", access, () => this.loadHandover(id, asOf)),
      this.loadContributor("entitlement", access, () =>
        this.loadEntitlement(id, headerRecord.orderStatus)
      ),
      this.loadContributor("service", access, () => this.loadService(id)),
      this.loadContributor("finance", access, () => this.loadFinance(id, asOf)),
      this.loadContributor("change", access, () => this.loadChange(id))
    ]);

    return this.resolver.resolve({
      access,
      asOf,
      guidance,
      header: {
        currentVehicleLabel:
          headerRecord.vehicle?.plateNo ??
          headerRecord.vehicle?.modelDefinition?.displayName ??
          headerRecord.vehicle?.vehicleNo ??
          null,
        customerLabel: headerRecord.customer.name,
        orderId: headerRecord.id,
        orderNo: headerRecord.orderNo,
        orderStatus: headerRecord.orderStatus,
        ownerLabel: headerRecord.application.salesUser.name
      },
      recentActivity: []
    });
  }

  private async loadContributor(
    category: OrderWorkspaceGuideCategory,
    access: WorkspaceAccess,
    contributor: () => Promise<OrderWorkspaceGuideItem>
  ): Promise<OrderWorkspaceGuideItem> {
    if (!access[category].view) {
      return this.resolver.unavailable(category);
    }
    try {
      return await contributor();
    } catch {
      return this.resolver.unavailable(category);
    }
  }

  private async loadContract(orderId: string) {
    const contracts = await this.prisma.contract.findMany({
      orderBy: { updatedAt: "desc" },
      select: {
        esignTasks: {
          orderBy: { updatedAt: "desc" },
          select: { taskStatus: true, updatedAt: true },
          take: 10,
          where: { deletedAt: null, signingStage: "STAGE1_SUBSCRIPTION_CONTRACT" }
        },
        id: true,
        status: true,
        updatedAt: true
      },
      take: 10,
      where: { deletedAt: null, orderId }
    });
    return this.resolver.resolveContract({
      contracts: contracts.map((contract) => ({
        id: contract.id,
        status: contract.status,
        tasks: contract.esignTasks.map((task) => ({
          taskStatus: task.taskStatus,
          updatedAt: task.updatedAt.toISOString()
        })),
        updatedAt: contract.updatedAt.toISOString()
      }))
    });
  }

  private async loadHandover(orderId: string, asOf: string) {
    const workOrder = await this.prisma.vehicleHandoverWorkOrder.findFirst({
      orderBy: { updatedAt: "desc" },
      select: {
        assignedInternalUserId: true,
        handover: {
          select: {
            archiveStatus: true,
            handoverESignTask: {
              select: {
                signers: {
                  select: { required: true, signerStatus: true },
                  where: { deletedAt: null }
                },
                taskStatus: true
              }
            },
            id: true,
            status: true,
            updatedAt: true
          }
        },
        id: true,
        operatorType: true,
        status: true,
        updatedAt: true
      },
      where: { handoverType: "DELIVERY_OUTBOUND", orderId }
    });
    return this.resolver.resolveHandover({
      asOf,
      workOrder: workOrder
        ? {
            assigned:
              workOrder.status !== "DRAFT" ||
              workOrder.assignedInternalUserId !== null ||
              workOrder.operatorType === "EXTERNAL",
            handover: workOrder.handover
              ? {
                  archiveStatus: workOrder.handover.archiveStatus,
                  id: workOrder.handover.id,
                  signers: workOrder.handover.handoverESignTask?.signers ?? [],
                  status: workOrder.handover.status,
                  taskStatus: workOrder.handover.handoverESignTask?.taskStatus ?? null,
                  updatedAt: workOrder.handover.updatedAt.toISOString()
                }
              : null,
            id: workOrder.id,
            status: workOrder.status,
            updatedAt: workOrder.updatedAt.toISOString()
          }
        : null
    });
  }

  private async loadEntitlement(orderId: string, orderStatus: string) {
    const account = await this.prisma.orderEntitlementAccount.findFirst({
      orderBy: { updatedAt: "desc" },
      select: {
        accountStatus: true,
        grants: {
          orderBy: { updatedAt: "desc" },
          select: { status: true },
          take: 50,
          where: { deletedAt: null }
        },
        id: true,
        updatedAt: true
      },
      where: { deletedAt: null, orderId }
    });
    return this.resolver.resolveEntitlement({
      account: account
        ? {
            grants: account.grants.map((grant) => ({ status: grant.status })),
            id: account.id,
            status: account.accountStatus,
            updatedAt: account.updatedAt.toISOString()
          }
        : null,
      orderStatus
    });
  }

  private async loadService(orderId: string) {
    const cases = await this.prisma.serviceCase.findMany({
      orderBy: { updatedAt: "asc" },
      select: { assignedTo: true, caseStatus: true, id: true, updatedAt: true },
      take: 25,
      where: {
        caseStatus: { in: ["SUBMITTED", "ACCEPTED", "IN_PROGRESS", "WAITING_CUSTOMER"] },
        deletedAt: null,
        orderId
      }
    });
    return this.resolver.resolveService({
      cases: cases.map((serviceCase) => ({
        assigned: Boolean(serviceCase.assignedTo),
        id: serviceCase.id,
        status: serviceCase.caseStatus,
        updatedAt: serviceCase.updatedAt.toISOString()
      }))
    });
  }

  private async loadFinance(orderId: string, asOf: string) {
    const order = await this.prisma.subscriptionOrder.findUnique({
      select: {
        depositLedgers: {
          orderBy: { occurredAt: "asc" },
          select: { id: true, occurredAt: true, transactionStatus: true, transactionType: true },
          take: 25,
          where: { deletedAt: null, transactionStatus: "PENDING" }
        },
        paymentOrders: {
          orderBy: { updatedAt: "asc" },
          select: { id: true, paymentStatus: true, updatedAt: true },
          take: 25,
          where: { deletedAt: null, paymentStatus: "FAILED" }
        },
        receivableBills: {
          orderBy: { dueDate: "asc" },
          select: { billStatus: true, dueDate: true, id: true, updatedAt: true },
          take: 50,
          where: {
            billStatus: { in: ["PENDING", "PARTIALLY_PAID", "OVERDUE"] },
            deletedAt: null
          }
        }
      },
      where: { id: orderId }
    });
    if (!order) {
      throw new NotFoundException("Order not found.");
    }
    return this.resolver.resolveFinance({
      asOf,
      depositEntries: order.depositLedgers.map((entry) => ({
        id: entry.id,
        status: entry.transactionStatus,
        transactionType: entry.transactionType,
        updatedAt: entry.occurredAt.toISOString()
      })),
      paymentOrders: order.paymentOrders.map((payment) => ({
        id: payment.id,
        status: payment.paymentStatus,
        updatedAt: payment.updatedAt.toISOString()
      })),
      receivableBills: order.receivableBills.map((bill) => ({
        billStatus: bill.billStatus,
        dueDate: bill.dueDate.toISOString(),
        id: bill.id,
        updatedAt: bill.updatedAt.toISOString()
      }))
    });
  }

  private async loadChange(orderId: string) {
    const changes = await this.prisma.orderChange.findMany({
      orderBy: { updatedAt: "asc" },
      select: { id: true, status: true, updatedAt: true },
      take: 25,
      where: { deletedAt: null, orderId, status: { in: ["PENDING", "APPROVED"] } }
    });
    return this.resolver.resolveChange({
      changes: changes.map((change) => ({
        id: change.id,
        status: change.status,
        updatedAt: change.updatedAt.toISOString()
      }))
    });
  }
}

function guideItem(
  category: OrderWorkspaceGuideCategory,
  state: OrderWorkspaceState,
  reasonCode: string,
  actionCode: string | null,
  targetRecordId: string | null,
  updatedAt: string | null,
  blocking = false,
  additionalCount = 0
): OrderWorkspaceGuideItem {
  return {
    actionCode,
    additionalCount,
    blocking,
    category,
    priority: STATE_PRIORITY[state],
    reasonCode,
    state,
    targetRecordId,
    targetTab: category,
    updatedAt
  };
}

function comparePrimaryAction(left: OrderWorkspaceGuideItem, right: OrderWorkspaceGuideItem) {
  const priority = right.priority - left.priority;
  if (priority !== 0) {
    return priority;
  }
  const timestamp = sortableTimestamp(left.updatedAt) - sortableTimestamp(right.updatedAt);
  if (timestamp !== 0) {
    return timestamp;
  }
  return (left.targetRecordId ?? "").localeCompare(right.targetRecordId ?? "");
}

function sortableTimestamp(value: string | null) {
  const parsed = value === null ? Number.POSITIVE_INFINITY : Date.parse(value);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

function resolveAccess(user: RequestUser): WorkspaceAccess {
  const permissions = new Set(user.permissions);
  return {
    change: access(
      permissions,
      [PermissionCode.ORDER_CHANGE_VIEW],
      [
        PermissionCode.ORDER_CHANGE_CREATE,
        PermissionCode.ORDER_CHANGE_APPROVE,
        PermissionCode.ORDER_CHANGE_REJECT,
        PermissionCode.ORDER_CHANGE_EXECUTE
      ]
    ),
    contract: access(
      permissions,
      [PermissionCode.CONTRACT_VIEW],
      [
        PermissionCode.CONTRACT_GENERATE,
        PermissionCode.CONTRACT_SIGN,
        PermissionCode.CONTRACT_ARCHIVE,
        PermissionCode.CONTRACT_CANCEL
      ]
    ),
    entitlement: access(
      permissions,
      [PermissionCode.ENTITLEMENT_VIEW],
      [PermissionCode.ENTITLEMENT_GENERATE, PermissionCode.ENTITLEMENT_ADJUST, PermissionCode.ENTITLEMENT_CONSUME]
    ),
    finance: access(
      permissions,
      [
        PermissionCode.BILLING_VIEW,
        PermissionCode.PAYMENT_VIEW,
        PermissionCode.DEPOSIT_LEDGER_VIEW,
        PermissionCode.COLLECTION_VIEW,
        PermissionCode.REPORT_FINANCE
      ],
      [
        PermissionCode.BILLING_GENERATE,
        PermissionCode.PAYMENT_CREATE,
        PermissionCode.PAYMENT_WRITE_OFF,
        PermissionCode.DEPOSIT_LEDGER_DEDUCT,
        PermissionCode.DEPOSIT_LEDGER_REFUND,
        PermissionCode.COLLECTION_ACTION_CREATE,
        PermissionCode.COLLECTION_CLOSE
      ]
    ),
    handover: access(
      permissions,
      [PermissionCode.DELIVERY_VIEW],
      [PermissionCode.DELIVERY_PREPARE, PermissionCode.DELIVERY_CONFIRM]
    ),
    service: access(
      permissions,
      [PermissionCode.SERVICE_CASE_VIEW],
      [PermissionCode.SERVICE_CASE_MANAGE]
    )
  };
}

function access(permissions: Set<string>, view: PermissionCode[], actionPermissions: PermissionCode[]) {
  return {
    action: actionPermissions.some((permission) => permissions.has(permission)),
    view: view.some((permission) => permissions.has(permission))
  };
}
