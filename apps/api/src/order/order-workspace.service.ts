import { Injectable, NotFoundException } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import type { RequestUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import type {
  OrderWorkspaceGuideCategory,
  OrderWorkspaceGuideItem,
  OrderWorkspaceDetail,
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

const WORKSPACE_DETAIL_BASE_FIELDS = [
  "actualDeliveryAt",
  "actualReturnAt",
  "createdAt",
  "creditReviewStatus",
  "customerConfirmedAt",
  "customerId",
  "depositAmount",
  "depositStatus",
  "finalDepositAmount",
  "finalPlanConfirmedAt",
  "id",
  "mileageLimitKm",
  "monthlyFeeAmount",
  "orderNo",
  "orderSource",
  "orderStatus",
  "periodMonths",
  "productReviewStatus",
  "vehicleReviewStatus"
] as const;

const WORKSPACE_APPLICATION_FIELDS = ["applicationNo", "id", "status"] as const;
const WORKSPACE_CHANGE_FIELDS = [
  "afterSnapshot",
  "approvedAt",
  "approvedBy",
  "beforeSnapshot",
  "changeType",
  "createdAt",
  "createdBy",
  "executedAt",
  "id",
  "reason",
  "status",
  "updatedAt"
] as const;
const WORKSPACE_CONTRACT_FIELDS = [
  "archivedAt",
  "contractNo",
  "contractTitle",
  "createdAt",
  "fileId",
  "id",
  "signedAt",
  "status",
  "updatedAt"
] as const;
const WORKSPACE_CUSTOMER_FIELDS = ["grade", "id", "mobile", "name"] as const;
const WORKSPACE_CUSTOMER_IDENTITY_FIELDS = ["id", "idCardNoPresent"] as const;
const WORKSPACE_CUSTOMER_PROFILE_FIELDS = ["residenceAddress"] as const;
const WORKSPACE_QUOTE_FIELDS = ["id", "quoteNo", "status"] as const;
const WORKSPACE_RISK_FIELDS = [
  "applicationId",
  "approvedAt",
  "approvedBy",
  "approvedDepositAmount",
  "createdAt",
  "customerId",
  "defaultRate",
  "grade",
  "id",
  "maxVehiclePurchasePriceAmount",
  "remark",
  "result",
  "score",
  "updatedAt"
] as const;
const WORKSPACE_VEHICLE_FIELDS = [
  "batteryCapacityKwh",
  "batteryUsageType",
  "batteryUsageTypeLabel",
  "brand",
  "currentMileageKm",
  "currentSalePriceAmount",
  "id",
  "model",
  "modelDefinitionId",
  "modelYear",
  "plateNo",
  "series",
  "status",
  "vehicleModel",
  "vehicleNo",
  "vin"
] as const;
const WORKSPACE_VEHICLE_ORDER_FIELDS = [
  "legacyVehicleModelSnapshot",
  "modelDisplayName",
  "modelDisplayNameSnapshot",
  "modelDisplaySource",
  "vehicleModel"
] as const;
const WORKSPACE_VEHICLE_INSURANCE_POLICY_FIELDS = [
  "createdAt",
  "currency",
  "effectiveFrom",
  "effectiveTo",
  "id",
  "insuredAmount",
  "insuredName",
  "insurerName",
  "policyHolderName",
  "policyNo",
  "policyStatus",
  "policyType",
  "premiumAmount",
  "remark",
  "renewalReminderAt",
  "updatedAt",
  "vehicleId"
] as const;
const WORKSPACE_VEHICLE_DOCUMENT_FIELDS = [
  "customerVisible",
  "description",
  "documentStatus",
  "documentType",
  "effectiveFrom",
  "effectiveTo",
  "fileName",
  "fileSize",
  "id",
  "mimeType",
  "originalName",
  "title"
] as const;
const WORKSPACE_INSURANCE_CLAIM_FIELDS = [
  "acceptedAt",
  "accidentAt",
  "approvedAmount",
  "claimNo",
  "claimStatus",
  "closedAt",
  "customerId",
  "estimatedAmount",
  "id",
  "insurerClaimNo",
  "orderId",
  "paidAmount",
  "policyId",
  "remark",
  "serviceCaseId",
  "submittedAt",
  "vehicleId"
] as const;

type WorkspaceAccess = Record<OrderWorkspaceGuideCategory, { view: boolean; action: boolean }>;

type ResolverInput = {
  access: WorkspaceAccess;
  asOf: string;
  guidance: OrderWorkspaceGuideItem[];
  header: OrderWorkspaceSummary["header"];
  primaryActionCandidates?: OrderWorkspaceGuideItem[];
  recentActivity: OrderWorkspaceSummary["recentActivity"];
};

type WorkspaceContributorResult = {
  guidance: OrderWorkspaceGuideItem;
  primaryActionCandidates: OrderWorkspaceGuideItem[];
};

export type ContractWorkspaceFacts = {
  contracts: Array<{
    id: string;
    status: string;
    tasks: Array<{ taskStatus: string; updatedAt: string }>;
    updatedAt: string;
  }>;
};

type HandoverWorkOrderFacts = {
  assigned: boolean;
  customerConfirmedAt?: string | null;
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
};

export type HandoverWorkspaceFacts = {
  asOf: string;
  workOrder?: HandoverWorkOrderFacts | null;
  workOrders?: HandoverWorkOrderFacts[];
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
  collectionCases?: Array<{
    id: string;
    requiredAt: string;
    status: string;
  }>;
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
    const normalize = (item: OrderWorkspaceGuideItem) => {
      const stateForcesNoAction = NON_ACTIONABLE_STATES.has(item.state);
      return {
        ...item,
        actionCode: input.access[item.category].action && !stateForcesNoAction ? item.actionCode : null,
        priority: STATE_PRIORITY[item.state]
      };
    };
    const guidance = input.guidance
      .filter((item) => input.access[item.category].view)
      .map(normalize)
      .sort((left, right) => CATEGORY_ORDER.indexOf(left.category) - CATEGORY_ORDER.indexOf(right.category));

    const primary = (input.primaryActionCandidates ?? guidance)
      .filter((item) => input.access[item.category].view)
      .map(normalize)
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

    if (["SIGNED", "ARCHIVED"].includes(contract.status)) {
      return guideItem("contract", "COMPLETED", "CONTRACT_SIGNED", null, contract.id, contract.updatedAt);
    }

    const failedTask = contract.tasks[0]?.taskStatus === "FAILED" ? contract.tasks[0] : null;
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
    const workOrders = facts.workOrders ?? (facts.workOrder ? [facts.workOrder] : []);
    if (workOrders.length === 0) {
      return guideItem("handover", "NOT_STARTED", "HANDOVER_NOT_STARTED", null, null, null);
    }
    return selectRepresentative(
      workOrders.map((workOrder) => this.resolveHandoverWorkOrder(workOrder, facts.asOf))
    );
  }

  private resolveHandoverWorkOrder(workOrder: HandoverWorkOrderFacts, asOf: string) {
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
    }

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
      const confirmedAt = workOrder.customerConfirmedAt ?? null;
      const elapsed = confirmedAt === null ? 0 : Date.parse(asOf) - Date.parse(confirmedAt);
      const overdue = confirmedAt !== null && elapsed >= HANDOVER_SIGNING_START_GRACE_MS;
      return guideItem(
        "handover",
        overdue ? "ACTION_REQUIRED" : "PROCESSING",
        overdue ? "HANDOVER_SIGNING_START_OVERDUE" : "HANDOVER_SIGNING_START_PENDING",
        overdue ? "handover.start_signing" : null,
        workOrder.id,
        confirmedAt
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
    if (facts.cases.length === 0) {
      return guideItem("service", "COMPLETED", "SERVICE_NO_OPEN_CASE", null, null, null);
    }
    return selectRepresentative(
      facts.cases.map((serviceCase) =>
        serviceCase.status === "WAITING_CUSTOMER"
          ? guideItem(
              "service",
              "WAITING_EXTERNAL",
              "SERVICE_WAITING_CUSTOMER",
              null,
              serviceCase.id,
              serviceCase.updatedAt
            )
          : guideItem(
              "service",
              "ACTION_REQUIRED",
              serviceCase.assigned ? "SERVICE_CASE_ACTION_REQUIRED" : "SERVICE_CASE_ASSIGNMENT_REQUIRED",
              "service.resolve",
              serviceCase.id,
              serviceCase.updatedAt
            )
      )
    );
  }

  resolveFinance(facts: FinanceWorkspaceFacts): OrderWorkspaceGuideItem {
    return this.resolveFinanceContributor(facts).guidance;
  }

  resolveFinanceContributor(facts: FinanceWorkspaceFacts): WorkspaceContributorResult {
    const candidates = [
      ...facts.paymentOrders.map((payment) =>
        guideItem(
          "finance",
          payment.status === "FAILED" ? "FAILED" : "COMPLETED",
          payment.status === "FAILED" ? "FINANCE_RECONCILIATION_REQUIRED" : "FINANCE_PAYMENT_COMPLETE",
          payment.status === "FAILED" ? "finance.reconcile" : null,
          payment.id,
          payment.updatedAt
        )
      ),
      ...facts.depositEntries.map((entry) => {
        const action =
          entry.transactionType === "REFUND"
            ? "finance.refund_deposit"
            : entry.transactionType === "DEDUCT"
              ? "finance.deduct_deposit"
              : "finance.collect";
        return guideItem(
          "finance",
          entry.status === "PENDING" ? "ACTION_REQUIRED" : "COMPLETED",
          entry.status === "PENDING" ? "FINANCE_DEPOSIT_SETTLEMENT_REQUIRED" : "FINANCE_DEPOSIT_SETTLED",
          entry.status === "PENDING" ? action : null,
          entry.id,
          entry.updatedAt
        );
      }),
      ...facts.receivableBills.map((bill) => {
        const due = bill.billStatus === "OVERDUE" || Date.parse(bill.dueDate) <= Date.parse(facts.asOf);
        return guideItem(
          "finance",
          due ? "ACTION_REQUIRED" : "COMPLETED",
          due
            ? bill.billStatus === "OVERDUE"
              ? "FINANCE_PAYMENT_OVERDUE"
              : "FINANCE_PAYMENT_DUE"
            : "FINANCE_PAYMENT_NOT_DUE",
          due ? "finance.collect" : null,
          bill.id,
          due ? bill.dueDate : bill.updatedAt
        );
      }),
      ...(facts.collectionCases ?? []).map((collectionCase) =>
        guideItem(
          "finance",
          collectionCase.status === "ACTIVE" ? "ACTION_REQUIRED" : "WAITING_EXTERNAL",
          collectionCase.status === "ACTIVE" ? "FINANCE_COLLECTION_ACTION_REQUIRED" : "FINANCE_COLLECTION_PAUSED",
          collectionCase.status === "ACTIVE" ? "finance.collection_follow_up" : null,
          collectionCase.id,
          collectionCase.requiredAt
        )
      )
    ];
    if (candidates.length === 0) {
      const guidance = guideItem("finance", "COMPLETED", "FINANCE_NO_ACTION_DUE", null, null, null);
      return { guidance, primaryActionCandidates: [guidance] };
    }
    return {
      guidance: selectRepresentative(candidates),
      primaryActionCandidates: candidates
    };
  }

  resolveChange(facts: ChangeWorkspaceFacts): OrderWorkspaceGuideItem {
    if (facts.changes.length === 0) {
      return guideItem("change", "COMPLETED", "CHANGE_NONE_PENDING", null, null, null);
    }
    return selectRepresentative(
      facts.changes.map((change) => {
        if (change.status === "FAILED") {
          return guideItem(
            "change",
            "FAILED",
            "CHANGE_WORKFLOW_FAILED",
            "change.retry",
            change.id,
            change.updatedAt
          );
        }
        if (change.status === "PENDING") {
          return guideItem(
            "change",
            "ACTION_REQUIRED",
            "CHANGE_APPROVAL_PENDING",
            "change.approve",
            change.id,
            change.updatedAt
          );
        }
        if (change.status === "APPROVED") {
          return guideItem(
            "change",
            "ACTION_REQUIRED",
            "CHANGE_EXECUTION_REQUIRED",
            "change.execute",
            change.id,
            change.updatedAt
          );
        }
        return guideItem("change", "COMPLETED", "CHANGE_COMPLETE", null, change.id, change.updatedAt);
      })
    );
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

  async getDetail(id: string, user: RequestUser): Promise<OrderWorkspaceDetail> {
    const rawDetail = await this.orderService.getOrder(id, user);
    return projectOrderWorkspaceDetail(rawDetail, new Set(user.permissions));
  }

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
    const contributors = await Promise.all([
      this.loadContributor("contract", access, () => this.loadContract(id)),
      this.loadContributor("handover", access, () => this.loadHandover(id, asOf, user)),
      this.loadContributor("entitlement", access, () =>
        this.loadEntitlement(id, headerRecord.orderStatus)
      ),
      this.loadContributor("service", access, () => this.loadService(id)),
      this.loadContributor("finance", access, () => this.loadFinance(id, asOf, user)),
      this.loadContributor("change", access, () => this.loadChange(id))
    ]);
    const guidance = contributors.map(({ guidance: item }) => filterWorkspaceActionByPermission(item, user));
    const primaryActionCandidates = contributors.flatMap((contributor) =>
      contributor.primaryActionCandidates.map((item) => filterWorkspaceActionByPermission(item, user))
    );

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
        ownerLabel: headerRecord.application?.salesUser?.name ?? null
      },
      primaryActionCandidates,
      recentActivity: []
    });
  }

  private async loadContributor(
    category: OrderWorkspaceGuideCategory,
    access: WorkspaceAccess,
    contributor: () => Promise<OrderWorkspaceGuideItem | WorkspaceContributorResult>
  ): Promise<WorkspaceContributorResult> {
    if (!access[category].view) {
      return singleContributor(this.resolver.unavailable(category));
    }
    try {
      const result = await contributor();
      return "guidance" in result ? result : singleContributor(result);
    } catch {
      return singleContributor(this.resolver.unavailable(category));
    }
  }

  private async loadContract(orderId: string) {
    const order = await this.prisma.subscriptionOrder.findUnique({
      select: {
        contract: {
          select: {
            esignTasks: {
              orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
              select: { taskStatus: true, updatedAt: true },
              take: 1,
              where: { deletedAt: null, signingStage: "STAGE1_SUBSCRIPTION_CONTRACT" }
            },
            id: true,
            status: true,
            updatedAt: true
          }
        },
        contractId: true
      },
      where: { id: orderId }
    });
    return this.resolver.resolveContract({
      contracts:
        order?.contractId && order.contract
          ? [
              {
                id: order.contract.id,
                status: order.contract.status,
                tasks: order.contract.esignTasks.map((task) => ({
                  taskStatus: task.taskStatus,
                  updatedAt: task.updatedAt.toISOString()
                })),
                updatedAt: order.contract.updatedAt.toISOString()
              }
            ]
          : []
    });
  }

  private async loadHandover(orderId: string, asOf: string, user: RequestUser) {
    const permissions = new Set(user.permissions);
    const handoverTypes: Array<"DELIVERY_OUTBOUND" | "RETURN_INBOUND"> = [];
    if (permissions.has(PermissionCode.DELIVERY_VIEW)) {
      handoverTypes.push("DELIVERY_OUTBOUND");
    }
    if (permissions.has(PermissionCode.VEHICLE_RETURN_VIEW)) {
      handoverTypes.push("RETURN_INBOUND");
    }

    const workOrders = await this.prisma.vehicleHandoverWorkOrder.findMany({
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      select: {
        assignedInternalUserId: true,
        customerConfirmedAt: true,
        handover: {
          select: {
            archiveStatus: true,
            handoverESignTask: {
              select: {
                signers: {
                  select: { required: true, signerStatus: true },
                  take: 10,
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
      take: 50,
      where: { handoverType: { in: handoverTypes }, orderId }
    });
    return this.resolver.resolveHandover({
      asOf,
      workOrders: workOrders.map((workOrder) => ({
        assigned:
          workOrder.status !== "DRAFT" ||
          workOrder.assignedInternalUserId !== null ||
          workOrder.operatorType === "EXTERNAL",
        customerConfirmedAt: workOrder.customerConfirmedAt?.toISOString() ?? null,
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
      }))
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
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
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

  private async loadFinance(orderId: string, asOf: string, user: RequestUser) {
    const permissions = new Set(user.permissions);
    const [receivableBills, paymentOrders, depositEntries, collectionCases] = await Promise.all([
      permissions.has(PermissionCode.BILLING_VIEW)
        ? this.prisma.receivableBill.findMany({
            orderBy: [{ dueDate: "asc" }, { id: "asc" }],
            select: { billStatus: true, dueDate: true, id: true, updatedAt: true },
            take: 50,
            where: {
              billStatus: { in: ["PENDING", "PARTIALLY_PAID", "OVERDUE"] },
              deletedAt: null,
              orderId
            }
          })
        : [],
      permissions.has(PermissionCode.PAYMENT_VIEW)
        ? this.prisma.paymentOrder.findMany({
            orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
            select: { id: true, paymentStatus: true, updatedAt: true },
            take: 25,
            where: { deletedAt: null, orderId, paymentStatus: "FAILED" }
          })
        : [],
      permissions.has(PermissionCode.DEPOSIT_LEDGER_VIEW)
        ? this.prisma.depositLedger.findMany({
            orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
            select: { id: true, occurredAt: true, transactionStatus: true, transactionType: true },
            take: 25,
            where: { deletedAt: null, orderId, transactionStatus: "PENDING" }
          })
        : [],
      permissions.has(PermissionCode.COLLECTION_VIEW)
        ? this.prisma.collectionCase.findMany({
            orderBy: [{ nextFollowUpAt: "asc" }, { id: "asc" }],
            select: { id: true, nextFollowUpAt: true, caseStatus: true, updatedAt: true },
            take: 25,
            where: { caseStatus: { in: ["ACTIVE", "PAUSED"] }, deletedAt: null, orderId }
          })
        : []
    ]);
    return this.resolver.resolveFinanceContributor({
      asOf,
      collectionCases: collectionCases.map((collectionCase) => ({
        id: collectionCase.id,
        requiredAt: (collectionCase.nextFollowUpAt ?? collectionCase.updatedAt).toISOString(),
        status: collectionCase.caseStatus
      })),
      depositEntries: depositEntries.map((entry) => ({
        id: entry.id,
        status: entry.transactionStatus,
        transactionType: entry.transactionType,
        updatedAt: entry.occurredAt.toISOString()
      })),
      paymentOrders: paymentOrders.map((payment) => ({
        id: payment.id,
        status: payment.paymentStatus,
        updatedAt: payment.updatedAt.toISOString()
      })),
      receivableBills: receivableBills.map((bill) => ({
        billStatus: bill.billStatus,
        dueDate: bill.dueDate.toISOString(),
        id: bill.id,
        updatedAt: bill.updatedAt.toISOString()
      }))
    });
  }

  private async loadChange(orderId: string) {
    const changes = await this.prisma.orderChange.findMany({
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
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

function singleContributor(guidance: OrderWorkspaceGuideItem): WorkspaceContributorResult {
  return { guidance, primaryActionCandidates: [guidance] };
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

function selectRepresentative(candidates: OrderWorkspaceGuideItem[]) {
  const representative = [...candidates].sort(comparePrimaryAction)[0]!;
  return {
    ...representative,
    additionalCount: candidates.length - 1
  };
}

function sortableTimestamp(value: string | null) {
  const parsed = value === null ? Number.POSITIVE_INFINITY : Date.parse(value);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

function projectOrderWorkspaceDetail(
  rawDetail: Record<string, unknown>,
  permissions: Set<string>
): OrderWorkspaceDetail {
  const detail = pickWorkspaceFields(rawDetail, WORKSPACE_DETAIL_BASE_FIELDS);

  if (permissions.has(PermissionCode.CUSTOMER_VIEW)) {
    const customer = projectWorkspaceRecord(
      rawDetail.customer,
      WORKSPACE_CUSTOMER_FIELDS
    );
    if (isWorkspaceRecord(customer) && isWorkspaceRecord(rawDetail.customer)) {
      assignProjectedRecord(
        customer,
        "identity",
        rawDetail.customer.identity,
        WORKSPACE_CUSTOMER_IDENTITY_FIELDS
      );
      assignProjectedRecord(
        customer,
        "profile",
        rawDetail.customer.profile,
        WORKSPACE_CUSTOMER_PROFILE_FIELDS
      );
    }
    assignProjectedValue(detail, "customer", customer);
  }

  if (permissions.has(PermissionCode.RISK_VIEW)) {
    assignProjectedRecord(
      detail,
      "riskResult",
      rawDetail.riskResult,
      WORKSPACE_RISK_FIELDS
    );
  }

  if (permissions.has(PermissionCode.APPLICATION_VIEW)) {
    assignProjectedRecord(
      detail,
      "application",
      rawDetail.application,
      WORKSPACE_APPLICATION_FIELDS
    );
  }

  if (permissions.has(PermissionCode.QUOTE_VIEW)) {
    assignProjectedRecord(detail, "quote", rawDetail.quote, WORKSPACE_QUOTE_FIELDS);
    copyWorkspaceField(detail, rawDetail, "quoteSnapshot");
  }

  if (permissions.has(PermissionCode.CONTRACT_VIEW)) {
    assignProjectedRecord(
      detail,
      "contract",
      rawDetail.contract,
      WORKSPACE_CONTRACT_FIELDS
    );
    copyWorkspaceField(detail, rawDetail, "contractId");
    assignProjectedArray(
      detail,
      "contracts",
      rawDetail.contracts,
      WORKSPACE_CONTRACT_FIELDS
    );
  }

  if (permissions.has(PermissionCode.ORDER_CHANGE_VIEW)) {
    assignProjectedArray(
      detail,
      "changes",
      rawDetail.changes,
      WORKSPACE_CHANGE_FIELDS
    );
  }

  if (permissions.has(PermissionCode.VEHICLE_VIEW)) {
    for (const field of WORKSPACE_VEHICLE_ORDER_FIELDS) {
      copyWorkspaceField(detail, rawDetail, field);
    }
    const vehicle = projectWorkspaceRecord(
      rawDetail.vehicle,
      WORKSPACE_VEHICLE_FIELDS
    );
    if (isWorkspaceRecord(vehicle) && isWorkspaceRecord(rawDetail.vehicle)) {
      const hasInsuranceView = permissions.has(
        PermissionCode.VEHICLE_INSURANCE_VIEW
      );
      if (hasInsuranceView) {
        assignProjectedArray(
          vehicle,
          "insurancePolicies",
          rawDetail.vehicle.insurancePolicies,
          WORKSPACE_VEHICLE_INSURANCE_POLICY_FIELDS
        );
      }
      if (
        hasInsuranceView &&
        permissions.has(PermissionCode.VEHICLE_DOCUMENT_VIEW)
      ) {
        assignProjectedArray(
          vehicle,
          "documents",
          rawDetail.vehicle.documents,
          WORKSPACE_VEHICLE_DOCUMENT_FIELDS
        );
      }
      if (
        hasInsuranceView &&
        permissions.has(PermissionCode.INSURANCE_CLAIM_VIEW)
      ) {
        assignProjectedArray(
          vehicle,
          "insuranceClaims",
          rawDetail.vehicle.insuranceClaims,
          WORKSPACE_INSURANCE_CLAIM_FIELDS
        );
      }
    }
    assignProjectedValue(detail, "vehicle", vehicle);
  }

  return detail as OrderWorkspaceDetail;
}

function pickWorkspaceFields(
  source: Record<string, unknown>,
  fields: readonly string[]
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    copyWorkspaceField(result, source, field);
  }
  return result;
}

function copyWorkspaceField(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  field: string
) {
  if (Object.prototype.hasOwnProperty.call(source, field)) {
    target[field] = source[field];
  }
}

function projectWorkspaceRecord(
  value: unknown,
  fields: readonly string[]
): Record<string, unknown> | null | undefined {
  if (value === null) {
    return null;
  }
  return isWorkspaceRecord(value) ? pickWorkspaceFields(value, fields) : undefined;
}

function assignProjectedRecord(
  target: Record<string, unknown>,
  field: string,
  value: unknown,
  fields: readonly string[]
) {
  assignProjectedValue(target, field, projectWorkspaceRecord(value, fields));
}

function assignProjectedArray(
  target: Record<string, unknown>,
  field: string,
  value: unknown,
  fields: readonly string[]
) {
  if (!Array.isArray(value)) {
    return;
  }
  target[field] = value
    .filter(isWorkspaceRecord)
    .map((item) => pickWorkspaceFields(item, fields));
}

function assignProjectedValue(
  target: Record<string, unknown>,
  field: string,
  value: unknown
) {
  if (value !== undefined) {
    target[field] = value;
  }
}

function isWorkspaceRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveAccess(user: RequestUser): WorkspaceAccess {
  const permissions = new Set(user.permissions);
  return {
    change: viewAccess(permissions.has(PermissionCode.ORDER_CHANGE_VIEW)),
    contract: viewAccess(permissions.has(PermissionCode.CONTRACT_VIEW)),
    entitlement: viewAccess(permissions.has(PermissionCode.ENTITLEMENT_VIEW)),
    finance: viewAccess(
      [
        PermissionCode.BILLING_VIEW,
        PermissionCode.PAYMENT_VIEW,
        PermissionCode.DEPOSIT_LEDGER_VIEW,
        PermissionCode.COLLECTION_VIEW
      ].some((permission) => permissions.has(permission))
    ),
    handover: viewAccess(
      permissions.has(PermissionCode.DELIVERY_VIEW) ||
        permissions.has(PermissionCode.VEHICLE_RETURN_VIEW)
    ),
    service: viewAccess(permissions.has(PermissionCode.SERVICE_CASE_VIEW))
  };
}

function viewAccess(view: boolean) {
  return { action: true, view };
}

const ACTION_PERMISSION: Record<string, PermissionCode> = {
  "change.approve": PermissionCode.ORDER_CHANGE_APPROVE,
  "change.execute": PermissionCode.ORDER_CHANGE_EXECUTE,
  "change.retry": PermissionCode.ORDER_CHANGE_EXECUTE,
  "contract.generate": PermissionCode.CONTRACT_GENERATE,
  "contract.retry_signing": PermissionCode.CONTRACT_SIGN,
  "contract.sign": PermissionCode.CONTRACT_SIGN,
  "entitlement.activate": PermissionCode.ENTITLEMENT_GENERATE,
  "entitlement.reconcile": PermissionCode.ENTITLEMENT_ADJUST,
  "finance.collect": PermissionCode.PAYMENT_CREATE,
  "finance.deduct_deposit": PermissionCode.DEPOSIT_LEDGER_DEDUCT,
  "finance.refund_deposit": PermissionCode.DEPOSIT_LEDGER_REFUND,
  "handover.assign": PermissionCode.DELIVERY_PREPARE,
  "handover.follow_up_signing": PermissionCode.DELIVERY_CONFIRM,
  "handover.retry_signing": PermissionCode.DELIVERY_CONFIRM,
  "handover.start_signing": PermissionCode.DELIVERY_CONFIRM,
  "service.resolve": PermissionCode.SERVICE_CASE_MANAGE
};

export function filterWorkspaceActionByPermission(
  item: OrderWorkspaceGuideItem,
  user: RequestUser
): OrderWorkspaceGuideItem {
  if (item.actionCode === null) {
    return item;
  }
  const permission = ACTION_PERMISSION[item.actionCode];
  return permission && user.permissions.includes(permission) ? item : { ...item, actionCode: null };
}
