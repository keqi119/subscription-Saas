import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  AuditAction,
  BillType,
  FinancingInstrument,
  Prisma,
  ReceivableBill,
  RevenueRightAssignmentStatus,
  RevenueRightAssignmentType,
  RevenueRightTargetType,
  RevenueShareBasis,
  RevenueShareSettlementCycle,
  RevenueShareRule,
  RevenueShareRuleStatus,
  RevenueShareRuleType,
  SubscriptionOrder,
  Vehicle,
  VehicleAcquisitionMode
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { createBusinessNo, withUniqueBusinessNoRetry } from "../common/business-number";
import { PrismaService } from "../prisma/prisma.service";
import {
  CreateRevenueRightAssignmentDto,
  CreateRevenueShareRuleDto,
  DeactivateRevenueShareRuleDto,
  ReleaseRevenueRightAssignmentDto,
  RevenueRightAssignmentsQueryDto,
  RevenueSharePreviewQueryDto
} from "./dto/revenue-right.dto";

const assignmentInclude = {
  bill: { select: { billNo: true, billType: true, id: true, paidAmount: true, remainingAmount: true } },
  financingInstrument: { select: { id: true, instrumentNo: true, instrumentType: true, lenderName: true } },
  order: { select: { id: true, orderNo: true, vehicleId: true } },
  vehicle: { select: { acquisitionMode: true, id: true, vehicleNo: true } }
} satisfies Prisma.RevenueRightAssignmentInclude;

const shareRuleInclude = {
  vehicle: { select: { acquisitionMode: true, id: true, vehicleNo: true } }
} satisfies Prisma.RevenueShareRuleInclude;

type RevenueRightAssignmentWithRelations = Prisma.RevenueRightAssignmentGetPayload<{
  include: typeof assignmentInclude;
}>;
type RevenueShareRuleWithVehicle = Prisma.RevenueShareRuleGetPayload<{ include: typeof shareRuleInclude }>;
type BillForPreview = Pick<
  ReceivableBill,
  "billPeriodEnd" | "billPeriodStart" | "billType" | "dueDate" | "id" | "paidAmount"
>;

const FINANCING_REQUIRED_ASSIGNMENT_TYPES = new Set<RevenueRightAssignmentType>([
  RevenueRightAssignmentType.PLEDGE,
  RevenueRightAssignmentType.TRANSFER,
  RevenueRightAssignmentType.SPV_POOL
]);
const SUPPORTED_REVENUE_SHARE_BASIS = new Set<RevenueShareBasis>([
  RevenueShareBasis.RENTAL_PAID,
  RevenueShareBasis.OPERATING_REVENUE
]);
const RENTAL_PAID_BILL_TYPES = new Set<BillType>([BillType.FIRST_MONTHLY_FEE, BillType.MONTHLY_RENT]);
const OPERATING_REVENUE_BILL_TYPES = new Set<BillType>([
  BillType.FIRST_MONTHLY_FEE,
  BillType.MONTHLY_RENT,
  BillType.DAMAGE_FEE,
  BillType.OTHER
]);
const SHARE_RULE_EXPECTED_ACQUISITION_MODES = new Set<VehicleAcquisitionMode>([
  VehicleAcquisitionMode.LONG_TERM_LEASED,
  VehicleAcquisitionMode.MANAGED_REVENUE_SHARE
]);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class RevenueRightService {
  constructor(
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService
  ) {}

  async listAssignments(query: RevenueRightAssignmentsQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where: Prisma.RevenueRightAssignmentWhereInput = {
      assigneeType: query.assigneeType,
      assignmentStatus: query.assignmentStatus,
      assignmentType: query.assignmentType,
      billId: query.billId,
      deletedAt: null,
      financingInstrumentId: query.financingInstrumentId,
      orderId: query.orderId,
      targetType: query.targetType,
      vehicleId: query.vehicleId
    };

    const [total, assignments] = await Promise.all([
      this.prisma.revenueRightAssignment.count({ where }),
      this.prisma.revenueRightAssignment.findMany({
        include: assignmentInclude,
        orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        where
      })
    ]);

    return {
      items: assignments.map(toAssignmentView),
      page,
      pageSize,
      total
    };
  }

  async getAssignment(id: string) {
    return toAssignmentView(await this.findAssignmentOrThrow(id));
  }

  async createAssignment(
    dto: CreateRevenueRightAssignmentDto,
    user: RequestUser,
    context: RequestContext
  ) {
    assertAssignmentInput(dto);
    const target = await this.resolveAssignmentTarget(dto);
    const financingInstrument = await this.resolveFinancingInstrument(dto);
    const duplicate = await this.prisma.revenueRightAssignment.findFirst({
      where: duplicateAssignmentWhere(dto, target, financingInstrument)
    });

    if (duplicate) {
      throw new BadRequestException("不允许创建完全重复的生效收益权 assignment");
    }

    const data = buildAssignmentData(dto, target, financingInstrument);
    const assignment = await withUniqueBusinessNoRetry(() =>
      this.prisma.revenueRightAssignment.create({
        data: {
          ...data,
          assignmentNo: createBusinessNo("RRA"),
          createdBy: user.id,
          updatedBy: user.id
        },
        include: assignmentInclude
      })
    );

    await this.writeAudit(
      AuditAction.CREATE,
      "revenue_right_assignment",
      assignment.id,
      undefined,
      toAssignmentAuditSnapshot(assignment, dto.remark),
      user,
      context
    );

    return toAssignmentView(assignment);
  }

  async releaseAssignment(
    id: string,
    dto: ReleaseRevenueRightAssignmentDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.findAssignmentOrThrow(id);
    if (before.assignmentStatus !== RevenueRightAssignmentStatus.ACTIVE) {
      throw new BadRequestException("已释放或取消的收益权 assignment 不能重复释放");
    }

    const releasedAt = parseDateOnly(dto.releasedAt, "releasedAt");
    const assignment = await this.prisma.revenueRightAssignment.update({
      data: {
        assignmentStatus: RevenueRightAssignmentStatus.RELEASED,
        effectiveTo: releasedAt,
        releaseReason: dto.releaseReason ?? null,
        releasedAt,
        remark: dto.remark ?? before.remark,
        updatedBy: user.id
      },
      include: assignmentInclude,
      where: { id }
    });

    await this.writeAudit(
      AuditAction.UPDATE,
      "revenue_right_assignment",
      id,
      toAssignmentAuditSnapshot(before, dto.remark),
      toAssignmentAuditSnapshot(assignment, dto.remark),
      user,
      context
    );

    return toAssignmentView(assignment);
  }

  async listVehicleRevenueShareRules(vehicleId: string) {
    await this.findVehicleOrThrow(vehicleId);
    const rules = await this.prisma.revenueShareRule.findMany({
      include: shareRuleInclude,
      orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
      where: { deletedAt: null, vehicleId }
    });

    return rules.map(toRevenueShareRuleView);
  }

  async createVehicleRevenueShareRule(
    vehicleId: string,
    dto: CreateRevenueShareRuleDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const vehicle = await this.findVehicleOrThrow(vehicleId);
    assertRevenueShareRuleInput(dto);
    const activeRule = await this.prisma.revenueShareRule.findFirst({
      where: {
        deletedAt: null,
        ruleStatus: RevenueShareRuleStatus.ACTIVE,
        vehicleId
      }
    });

    if (activeRule) {
      throw new BadRequestException("同一车辆不能重复创建 ACTIVE 分润规则");
    }

    const warnings = shareRuleWarnings(vehicle);
    const data = buildRevenueShareRuleData(dto, vehicle, warnings);
    const rule = await withUniqueBusinessNoRetry(() =>
      this.prisma.revenueShareRule.create({
        data: {
          ...data,
          createdBy: user.id,
          ruleNo: createBusinessNo("RSR"),
          updatedBy: user.id,
          vehicleId
        },
        include: shareRuleInclude
      })
    );

    await this.writeAudit(
      AuditAction.CREATE,
      "revenue_share_rule",
      rule.id,
      undefined,
      toRevenueShareRuleAuditSnapshot(rule, dto.remark),
      user,
      context
    );

    return {
      ...toRevenueShareRuleView(rule),
      warnings
    };
  }

  async deactivateVehicleRevenueShareRule(
    vehicleId: string,
    ruleId: string,
    dto: DeactivateRevenueShareRuleDto,
    user: RequestUser,
    context: RequestContext
  ) {
    await this.findVehicleOrThrow(vehicleId);
    const before = await this.prisma.revenueShareRule.findFirst({
      include: shareRuleInclude,
      where: {
        deletedAt: null,
        id: ruleId,
        ruleStatus: RevenueShareRuleStatus.ACTIVE,
        vehicleId
      }
    });

    if (!before) {
      throw new NotFoundException("分润规则不存在或已停用");
    }

    const effectiveTo = parseDateOnly(dto.effectiveTo, "effectiveTo");
    const rule = await this.prisma.revenueShareRule.update({
      data: {
        effectiveTo,
        remark: dto.remark ?? before.remark,
        ruleStatus: RevenueShareRuleStatus.INACTIVE,
        updatedBy: user.id
      },
      include: shareRuleInclude,
      where: { id: ruleId }
    });

    await this.writeAudit(
      AuditAction.UPDATE,
      "revenue_share_rule",
      ruleId,
      toRevenueShareRuleAuditSnapshot(before, dto.remark),
      toRevenueShareRuleAuditSnapshot(rule, dto.remark),
      user,
      context
    );

    return toRevenueShareRuleView(rule);
  }

  async getVehicleRevenueSharePreview(vehicleId: string, query: RevenueSharePreviewQueryDto) {
    const vehicle = await this.findVehicleOrThrow(vehicleId);
    const startDate = parseDateOnly(query.startDate, "startDate");
    const endDate = parseDateOnly(query.endDate, "endDate");

    if (endDate.getTime() < startDate.getTime()) {
      throw new BadRequestException("endDate 不能早于 startDate");
    }

    const rule = await this.prisma.revenueShareRule.findFirst({
      include: shareRuleInclude,
      orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
      where: activeShareRuleWhere(vehicleId, startDate, endDate)
    });

    if (!rule) {
      return {
        preview: null,
        rule: null,
        vehicle: toVehicleSummary(vehicle)
      };
    }

    const preview = await this.buildRevenueSharePreview(vehicle, rule, startDate, endDate);

    return {
      preview,
      rule: toRevenueShareRuleView(rule),
      vehicle: toVehicleSummary(vehicle)
    };
  }

  private async resolveAssignmentTarget(dto: CreateRevenueRightAssignmentDto) {
    if (dto.targetType === RevenueRightTargetType.ORDER) {
      assertRequiredString(dto.orderId, "targetType = ORDER 时 orderId 必填");
      const order = await this.prisma.subscriptionOrder.findUnique({
        where: { id: dto.orderId }
      });
      assertExistingRecord(order, "订单不存在");

      return {
        bill: null,
        billId: null,
        order,
        orderId: order.id,
        vehicle: null,
        vehicleId: order.vehicleId
      };
    }

    if (dto.targetType === RevenueRightTargetType.RECEIVABLE_BILL) {
      assertRequiredString(dto.billId, "targetType = RECEIVABLE_BILL 时 billId 必填");
      const bill = await this.prisma.receivableBill.findUnique({
        include: { order: true },
        where: { id: dto.billId }
      });
      assertExistingRecord(bill, "应收账单不存在");
      assertExistingRecord(bill.order, "账单关联订单不存在");

      return {
        bill,
        billId: bill.id,
        order: bill.order,
        orderId: bill.orderId,
        vehicle: null,
        vehicleId: bill.order.vehicleId
      };
    }

    if (dto.targetType === RevenueRightTargetType.VEHICLE) {
      assertRequiredString(dto.vehicleId, "targetType = VEHICLE 时 vehicleId 必填");
      const vehicle = await this.findVehicleOrThrow(dto.vehicleId);

      return {
        bill: null,
        billId: null,
        order: null,
        orderId: null,
        vehicle,
        vehicleId: vehicle.id
      };
    }

    return {
      bill: null,
      billId: null,
      order: null,
      orderId: null,
      vehicle: null,
      vehicleId: dto.vehicleId ?? null
    };
  }

  private async resolveFinancingInstrument(dto: CreateRevenueRightAssignmentDto) {
    if (FINANCING_REQUIRED_ASSIGNMENT_TYPES.has(dto.assignmentType) && !dto.financingInstrumentId) {
      throw new BadRequestException("PLEDGE / TRANSFER / SPV_POOL 必须关联融资工具");
    }

    if (!dto.financingInstrumentId) {
      return null;
    }

    const financingInstrument = await this.prisma.financingInstrument.findUnique({
      where: { id: dto.financingInstrumentId }
    });
    assertExistingRecord(financingInstrument, "融资工具不存在");

    return financingInstrument;
  }

  private async findAssignmentOrThrow(id: string) {
    const assignment = await this.prisma.revenueRightAssignment.findUnique({
      include: assignmentInclude,
      where: { id }
    });

    if (!assignment || assignment.deletedAt) {
      throw new NotFoundException("收益权 assignment 不存在");
    }

    return assignment;
  }

  private async findVehicleOrThrow(id: string) {
    const vehicle = await this.prisma.vehicle.findUnique({ where: { id } });

    if (!vehicle || vehicle.deletedAt) {
      throw new NotFoundException("车辆不存在");
    }

    return vehicle;
  }

  private async buildRevenueSharePreview(
    vehicle: Vehicle,
    rule: RevenueShareRuleWithVehicle,
    startDate: Date,
    endDate: Date
  ) {
    const days = daysInclusive(startDate, endDate);
    const warnings = shareRuleWarnings(vehicle);

    if (!SUPPORTED_REVENUE_SHARE_BASIS.has(rule.shareBasis)) {
      const fixedCostAmount = calculateFixedCostAmount(rule, days);

      return {
        billCount: 0,
        fixedCostAmount: Number(fixedCostAmount),
        ownerShareAmount: 0,
        platformShareAmount: 0,
        previewSupported: false,
        shareBaseAmount: 0,
        unsupportedReason: unsupportedShareBasisReason(rule.shareBasis),
        warnings
      };
    }

    const bills = await this.prisma.receivableBill.findMany({
      orderBy: { dueDate: "asc" },
      where: {
        deletedAt: null,
        order: { vehicleId: vehicle.id },
        OR: [
          {
            billPeriodEnd: { gte: startDate },
            billPeriodStart: { lte: endDate }
          },
          {
            billPeriodEnd: null,
            billPeriodStart: null,
            dueDate: { gte: startDate, lt: addDays(endDate, 1) }
          }
        ]
      }
    });
    const eligibleBillTypes = eligibleBillTypesForBasis(rule.shareBasis);
    const eligibleBills = (bills as BillForPreview[]).filter(
      (bill) => eligibleBillTypes.has(bill.billType) && billInDateRange(bill, startDate, endDate)
    );
    const shareBaseAmount = sumBigInt(eligibleBills.map((bill) => bill.paidAmount));
    const ownerShareVariableAmount = calculateBpsAmount(shareBaseAmount, rule.ownerShareBps ?? 0);
    const fixedCostAmount = calculateFixedCostAmount(rule, days);
    const ownerShareAmount = ownerShareVariableAmount + fixedCostAmount;
    const platformShareAmount = shareBaseAmount - ownerShareVariableAmount - fixedCostAmount;

    if (platformShareAmount < 0n) {
      warnings.push("platformShareAmount < 0，请检查固定成本或分成规则。");
    }

    return {
      billCount: eligibleBills.length,
      fixedCostAmount: Number(fixedCostAmount),
      ownerShareAmount: Number(ownerShareAmount),
      ownerShareVariableAmount: Number(ownerShareVariableAmount),
      platformShareAmount: Number(platformShareAmount),
      previewSupported: true,
      shareBaseAmount: Number(shareBaseAmount),
      unsupportedReason: null,
      warnings
    };
  }

  private async writeAudit(
    action: AuditAction,
    entityType: string,
    entityId: string,
    before: unknown,
    after: unknown,
    user: RequestUser,
    context: RequestContext
  ) {
    await this.auditService.write({
      action,
      after,
      before,
      entityId,
      entityType,
      ipAddress: context.ipAddress,
      module: "revenue_right",
      operatorId: user.id,
      userAgent: context.userAgent
    });
  }
}

function assertAssignmentInput(dto: CreateRevenueRightAssignmentDto) {
  assertOptionalBps(dto.shareRatioBps, "shareRatioBps 必须在 0 到 10000 之间");
  assertOptionalNonNegativeInteger(dto.priority, "priority 必须大于等于 0");
  const effectiveFrom = parseDateOnly(dto.effectiveFrom, "effectiveFrom");
  const effectiveTo = parseOptionalDateOnly(dto.effectiveTo, "effectiveTo");

  if (effectiveTo && effectiveTo.getTime() < effectiveFrom.getTime()) {
    throw new BadRequestException("effectiveTo 不能早于 effectiveFrom");
  }
}

function assertRevenueShareRuleInput(dto: CreateRevenueShareRuleDto) {
  assertOptionalBps(dto.ownerShareBps, "ownerShareBps 必须在 0 到 10000 之间");
  assertOptionalBps(dto.platformShareBps, "platformShareBps 必须在 0 到 10000 之间");
  assertOptionalNonNegativeInteger(dto.fixedMonthlyAmount, "fixedMonthlyAmount 必须大于等于 0");
  assertOptionalNonNegativeInteger(dto.minimumGuaranteeAmount, "minimumGuaranteeAmount 必须大于等于 0");

  if (dto.ruleType === RevenueShareRuleType.REVENUE_SHARE && !isPositiveNumber(dto.ownerShareBps)) {
    throw new BadRequestException("REVENUE_SHARE 规则必须设置 ownerShareBps");
  }

  if (dto.ruleType === RevenueShareRuleType.FIXED_RENT && !isPositiveNumber(dto.fixedMonthlyAmount)) {
    throw new BadRequestException("FIXED_RENT 规则必须设置 fixedMonthlyAmount");
  }

  if (
    dto.ruleType === RevenueShareRuleType.MIXED &&
    !isPositiveNumber(dto.ownerShareBps) &&
    !isPositiveNumber(dto.fixedMonthlyAmount)
  ) {
    throw new BadRequestException("MIXED 规则至少需要 ownerShareBps 或 fixedMonthlyAmount");
  }

  const effectiveFrom = parseDateOnly(dto.effectiveFrom, "effectiveFrom");
  const effectiveTo = parseOptionalDateOnly(dto.effectiveTo, "effectiveTo");
  if (effectiveTo && effectiveTo.getTime() < effectiveFrom.getTime()) {
    throw new BadRequestException("effectiveTo 不能早于 effectiveFrom");
  }
}

function duplicateAssignmentWhere(
  dto: CreateRevenueRightAssignmentDto,
  target: AssignmentTarget,
  financingInstrument: FinancingInstrument | null
): Prisma.RevenueRightAssignmentWhereInput {
  return {
    assigneeName: dto.assigneeName ?? null,
    assigneeType: dto.assigneeType,
    assignmentStatus: RevenueRightAssignmentStatus.ACTIVE,
    assignmentType: dto.assignmentType,
    billId: target.billId,
    deletedAt: null,
    financingInstrumentId: financingInstrument?.id ?? null,
    orderId: target.orderId,
    targetType: dto.targetType,
    vehicleId: target.vehicleId
  };
}

function buildAssignmentData(
  dto: CreateRevenueRightAssignmentDto,
  target: AssignmentTarget,
  financingInstrument: FinancingInstrument | null
): Omit<Prisma.RevenueRightAssignmentUncheckedCreateInput, "assignmentNo" | "createdBy" | "updatedBy"> {
  const effectiveFrom = parseDateOnly(dto.effectiveFrom, "effectiveFrom");
  const effectiveTo = parseOptionalDateOnly(dto.effectiveTo, "effectiveTo");
  const fields = {
    assigneeName: dto.assigneeName ?? null,
    assigneeType: dto.assigneeType,
    assignmentStatus: RevenueRightAssignmentStatus.ACTIVE,
    assignmentType: dto.assignmentType,
    billId: target.billId,
    effectiveFrom,
    effectiveTo,
    financingInstrumentId: financingInstrument?.id ?? null,
    orderId: target.orderId,
    priority: dto.priority ?? null,
    remark: dto.remark ?? null,
    shareRatioBps: dto.shareRatioBps ?? null,
    targetType: dto.targetType,
    vehicleId: target.vehicleId
  };

  return {
    ...fields,
    snapshot: buildAssignmentSnapshot(fields, target, financingInstrument)
  };
}

function buildAssignmentSnapshot(
  fields: {
    assigneeName: string | null;
    assigneeType: string;
    assignmentStatus: string;
    assignmentType: string;
    billId: string | null;
    effectiveFrom: Date;
    effectiveTo: Date | null | undefined;
    financingInstrumentId: string | null;
    orderId: string | null;
    priority: number | null;
    remark: string | null;
    shareRatioBps: number | null;
    targetType: string;
    vehicleId: string | null;
  },
  target: AssignmentTarget,
  financingInstrument: FinancingInstrument | null
): Prisma.InputJsonObject {
  return {
    assigneeName: fields.assigneeName,
    assigneeType: fields.assigneeType,
    assignmentStatus: fields.assignmentStatus,
    assignmentType: fields.assignmentType,
    billId: fields.billId,
    billNo: target.bill?.billNo ?? null,
    effectiveFrom: formatDateOnly(fields.effectiveFrom),
    effectiveTo: fields.effectiveTo ? formatDateOnly(fields.effectiveTo) : null,
    financingInstrumentId: fields.financingInstrumentId,
    financingInstrumentNo: financingInstrument?.instrumentNo ?? null,
    orderId: fields.orderId,
    orderNo: target.order?.orderNo ?? null,
    priority: fields.priority,
    remark: fields.remark,
    shareRatioBps: fields.shareRatioBps,
    targetType: fields.targetType,
    vehicleId: fields.vehicleId,
    vehicleNo: target.vehicle?.vehicleNo ?? null
  };
}

function buildRevenueShareRuleData(
  dto: CreateRevenueShareRuleDto,
  vehicle: Vehicle,
  warnings: string[]
): Omit<Prisma.RevenueShareRuleUncheckedCreateInput, "createdBy" | "ruleNo" | "updatedBy" | "vehicleId"> {
  const effectiveFrom = parseDateOnly(dto.effectiveFrom, "effectiveFrom");
  const effectiveTo = parseOptionalDateOnly(dto.effectiveTo, "effectiveTo");
  const fields = {
    effectiveFrom,
    effectiveTo,
    fixedMonthlyAmount: optionalBigInt(dto.fixedMonthlyAmount),
    minimumGuaranteeAmount: optionalBigInt(dto.minimumGuaranteeAmount),
    ownerContact: dto.ownerContact ?? null,
    ownerName: dto.ownerName ?? null,
    ownerShareBps: dto.ownerShareBps ?? null,
    platformShareBps: dto.platformShareBps ?? null,
    remark: dto.remark ?? null,
    ruleStatus: RevenueShareRuleStatus.ACTIVE,
    ruleType: dto.ruleType,
    settlementCycle: dto.settlementCycle ?? RevenueShareSettlementCycle.MONTHLY,
    shareBasis: dto.shareBasis
  };

  return {
    ...fields,
    snapshot: buildRevenueShareRuleSnapshot(fields, vehicle, warnings)
  };
}

function buildRevenueShareRuleSnapshot(
  fields: {
    effectiveFrom: Date;
    effectiveTo: Date | null | undefined;
    fixedMonthlyAmount: bigint | null;
    minimumGuaranteeAmount: bigint | null;
    ownerContact: string | null;
    ownerName: string | null;
    ownerShareBps: number | null;
    platformShareBps: number | null;
    remark: string | null;
    ruleStatus: string;
    ruleType: string;
    settlementCycle: string;
    shareBasis: string;
  },
  vehicle: Vehicle,
  warnings: string[]
): Prisma.InputJsonObject {
  return {
    acquisitionMode: vehicle.acquisitionMode,
    effectiveFrom: formatDateOnly(fields.effectiveFrom),
    effectiveTo: fields.effectiveTo ? formatDateOnly(fields.effectiveTo) : null,
    fixedMonthlyAmount: numberOrNull(fields.fixedMonthlyAmount),
    minimumGuaranteeAmount: numberOrNull(fields.minimumGuaranteeAmount),
    ownerContact: fields.ownerContact,
    ownerName: fields.ownerName,
    ownerShareBps: fields.ownerShareBps,
    platformShareBps: fields.platformShareBps,
    remark: fields.remark,
    ruleStatus: fields.ruleStatus,
    ruleType: fields.ruleType,
    settlementCycle: fields.settlementCycle,
    shareBasis: fields.shareBasis,
    vehicleId: vehicle.id,
    vehicleNo: vehicle.vehicleNo,
    warnings
  };
}

function activeShareRuleWhere(
  vehicleId: string,
  startDate: Date,
  endDate: Date
): Prisma.RevenueShareRuleWhereInput {
  return {
    deletedAt: null,
    effectiveFrom: { lte: endDate },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: startDate } }],
    ruleStatus: RevenueShareRuleStatus.ACTIVE,
    vehicleId
  };
}

function toAssignmentView(assignment: RevenueRightAssignmentWithRelations) {
  return {
    assigneeName: assignment.assigneeName,
    assigneeType: assignment.assigneeType,
    assignmentNo: assignment.assignmentNo,
    assignmentStatus: assignment.assignmentStatus,
    assignmentType: assignment.assignmentType,
    bill: assignment.bill
      ? {
          billNo: assignment.bill.billNo,
          billType: assignment.bill.billType,
          id: assignment.bill.id,
          paidAmount: Number(assignment.bill.paidAmount),
          remainingAmount: Number(assignment.bill.remainingAmount)
        }
      : null,
    billId: assignment.billId,
    createdAt: assignment.createdAt,
    effectiveFrom: assignment.effectiveFrom,
    effectiveTo: assignment.effectiveTo,
    financingInstrument: assignment.financingInstrument
      ? {
          id: assignment.financingInstrument.id,
          instrumentNo: assignment.financingInstrument.instrumentNo,
          instrumentType: assignment.financingInstrument.instrumentType,
          lenderName: assignment.financingInstrument.lenderName
        }
      : null,
    financingInstrumentId: assignment.financingInstrumentId,
    id: assignment.id,
    order: assignment.order
      ? {
          id: assignment.order.id,
          orderNo: assignment.order.orderNo,
          vehicleId: assignment.order.vehicleId
        }
      : null,
    orderId: assignment.orderId,
    priority: assignment.priority,
    releaseReason: assignment.releaseReason,
    releasedAt: assignment.releasedAt,
    remark: assignment.remark,
    shareRatioBps: assignment.shareRatioBps,
    snapshot: assignment.snapshot,
    targetType: assignment.targetType,
    updatedAt: assignment.updatedAt,
    vehicle: assignment.vehicle ? toVehicleSummary(assignment.vehicle) : null,
    vehicleId: assignment.vehicleId
  };
}

function toAssignmentAuditSnapshot(
  assignment: RevenueRightAssignmentWithRelations,
  remark: string | null | undefined
) {
  return {
    after: undefined,
    assignment: toAssignmentView(assignment),
    assignmentId: assignment.id,
    billId: assignment.billId,
    financingInstrumentId: assignment.financingInstrumentId,
    orderId: assignment.orderId,
    remark: remark ?? assignment.remark,
    vehicleId: assignment.vehicleId
  };
}

function toRevenueShareRuleView(rule: RevenueShareRuleWithVehicle) {
  return {
    createdAt: rule.createdAt,
    effectiveFrom: rule.effectiveFrom,
    effectiveTo: rule.effectiveTo,
    fixedMonthlyAmount: numberOrNull(rule.fixedMonthlyAmount),
    id: rule.id,
    minimumGuaranteeAmount: numberOrNull(rule.minimumGuaranteeAmount),
    ownerContact: rule.ownerContact,
    ownerName: rule.ownerName,
    ownerShareBps: rule.ownerShareBps,
    platformShareBps: rule.platformShareBps,
    remark: rule.remark,
    ruleNo: rule.ruleNo,
    ruleStatus: rule.ruleStatus,
    ruleType: rule.ruleType,
    settlementCycle: rule.settlementCycle,
    shareBasis: rule.shareBasis,
    snapshot: rule.snapshot,
    updatedAt: rule.updatedAt,
    vehicle: rule.vehicle ? toVehicleSummary(rule.vehicle) : null,
    vehicleId: rule.vehicleId
  };
}

function toRevenueShareRuleAuditSnapshot(rule: RevenueShareRuleWithVehicle, remark: string | null | undefined) {
  return {
    remark: remark ?? rule.remark,
    rule: toRevenueShareRuleView(rule),
    ruleId: rule.id,
    vehicleId: rule.vehicleId
  };
}

function toVehicleSummary(vehicle: Pick<Vehicle, "acquisitionMode" | "id" | "vehicleNo">) {
  return {
    acquisitionMode: vehicle.acquisitionMode,
    id: vehicle.id,
    vehicleNo: vehicle.vehicleNo
  };
}

function shareRuleWarnings(vehicle: Pick<Vehicle, "acquisitionMode">) {
  return SHARE_RULE_EXPECTED_ACQUISITION_MODES.has(vehicle.acquisitionMode)
    ? []
    : ["车辆取得方式不是 MANAGED_REVENUE_SHARE 或 LONG_TERM_LEASED，请确认分润/固定成本规则适用性。"];
}

function eligibleBillTypesForBasis(shareBasis: RevenueShareBasis) {
  return shareBasis === RevenueShareBasis.RENTAL_PAID
    ? RENTAL_PAID_BILL_TYPES
    : OPERATING_REVENUE_BILL_TYPES;
}

function unsupportedShareBasisReason(shareBasis: RevenueShareBasis) {
  if (shareBasis === RevenueShareBasis.GROSS_RECEIVABLE) {
    return "GROSS_RECEIVABLE 分润口径暂未实现。";
  }
  return "MANUAL 分润口径需人工结算，暂不支持自动 preview。";
}

function billInDateRange(bill: BillForPreview, startDate: Date, endDate: Date) {
  if (bill.billPeriodStart || bill.billPeriodEnd) {
    const periodStart = bill.billPeriodStart ?? bill.dueDate;
    const periodEnd = bill.billPeriodEnd ?? bill.dueDate;
    return dateOnly(periodStart).getTime() <= endDate.getTime() && dateOnly(periodEnd).getTime() >= startDate.getTime();
  }

  const dueDate = dateOnly(bill.dueDate);
  return dueDate.getTime() >= startDate.getTime() && dueDate.getTime() <= endDate.getTime();
}

function calculateFixedCostAmount(rule: Pick<RevenueShareRule, "fixedMonthlyAmount" | "ruleType">, days: number) {
  if (
    (rule.ruleType !== RevenueShareRuleType.FIXED_RENT && rule.ruleType !== RevenueShareRuleType.MIXED) ||
    !rule.fixedMonthlyAmount
  ) {
    return 0n;
  }

  return BigInt(Math.round(Number(rule.fixedMonthlyAmount) * 12 * days / 365));
}

function calculateBpsAmount(amount: bigint, bps: number) {
  return (amount * BigInt(bps)) / 10000n;
}

function daysInclusive(startDate: Date, endDate: Date) {
  return Math.floor((endDate.getTime() - startDate.getTime()) / MS_PER_DAY) + 1;
}

function addDays(date: Date, days: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

function dateOnly(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function parseOptionalDateOnly(input: string | null | undefined, fieldName: string) {
  if (input === undefined) {
    return undefined;
  }
  if (input === null || input === "") {
    return null;
  }
  return parseDateOnly(input, fieldName);
}

function parseDateOnly(input: string, fieldName: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);

  if (!match) {
    throw new BadRequestException(`${fieldName} 必须是 YYYY-MM-DD 格式`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new BadRequestException(`${fieldName} 不是有效日期`);
  }

  return date;
}

function assertRequiredString(value: string | null | undefined, message: string): asserts value is string {
  if (!value?.trim()) {
    throw new BadRequestException(message);
  }
}

function assertExistingRecord<T extends { deletedAt?: Date | null } | null | undefined>(
  record: T,
  message: string
): asserts record is NonNullable<T> {
  if (!record || record.deletedAt) {
    throw new NotFoundException(message);
  }
}

function assertOptionalBps(value: number | null | undefined, message: string) {
  if (value === undefined || value === null) {
    return;
  }
  if (!Number.isSafeInteger(value) || value < 0 || value > 10000) {
    throw new BadRequestException(message);
  }
}

function assertOptionalNonNegativeInteger(value: number | null | undefined, message: string) {
  if (value === undefined || value === null) {
    return;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BadRequestException(message);
  }
}

function isPositiveNumber(value: number | null | undefined) {
  return value !== undefined && value !== null && value > 0;
}

function optionalBigInt(value: number | null | undefined) {
  return value === undefined || value === null ? null : BigInt(value);
}

function sumBigInt(values: bigint[]) {
  return values.reduce((total, value) => total + value, 0n);
}

function numberOrNull(value: bigint | number | null | undefined) {
  return value === null || value === undefined ? null : Number(value);
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

type AssignmentTarget = {
  bill: (ReceivableBill & { order?: SubscriptionOrder }) | null;
  billId: string | null;
  order: SubscriptionOrder | null;
  orderId: string | null;
  vehicle: Vehicle | null;
  vehicleId: string | null;
};
