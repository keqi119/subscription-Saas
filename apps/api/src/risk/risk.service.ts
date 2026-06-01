import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import {
  AuditAction,
  CustomerGrade,
  DepositRule,
  Prisma,
  RecordStatus,
  RiskResultDecision
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { CreateDepositRuleDto, UpdateDepositRuleDto } from "./dto/deposit-rule.dto";

const FAR_FUTURE_DATE = new Date("9999-12-31T00:00:00.000Z");

export const riskResultInclude = {
  approver: {
    select: { id: true, name: true, username: true }
  }
} satisfies Prisma.RiskResultInclude;

type RiskResultWithDetails = Prisma.RiskResultGetPayload<{ include: typeof riskResultInclude }>;
type DepositRuleClient = Pick<Prisma.TransactionClient, "depositRule">;

interface ApprovalRiskResultInput {
  applicationId: string;
  approvedAt: Date;
  customerId: string;
  grade: CustomerGrade;
  maxVehiclePurchasePriceAmount?: number;
  operatorId: string;
  remark?: string;
  riskScore?: number;
}

@Injectable()
export class RiskService {
  constructor(
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService
  ) {}

  async listDepositRules() {
    const rules = await this.prisma.depositRule.findMany({
      orderBy: [{ grade: "asc" }, { effectiveFrom: "desc" }],
      where: { deletedAt: null }
    });

    return rules.map(toDepositRuleView);
  }

  async getDepositRule(id: string) {
    return toDepositRuleView(await this.findDepositRuleOrThrow(id));
  }

  async createDepositRule(dto: CreateDepositRuleDto, user: RequestUser, context: RequestContext) {
    const data = normalizeCreateDepositRule(dto, user.id);

    const rule = await this.prisma.$transaction(async (tx) => {
      await assertNoActiveRuleOverlap(tx, data);
      return tx.depositRule.create({ data });
    });

    await this.auditService.write({
      action: AuditAction.CREATE,
      after: toDepositRuleView(rule),
      entityId: rule.id,
      entityType: "deposit_rule",
      ipAddress: context.ipAddress,
      module: "risk",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toDepositRuleView(rule);
  }

  async updateDepositRule(
    id: string,
    dto: UpdateDepositRuleDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.findDepositRuleOrThrow(id);
    const next = normalizeUpdateDepositRule(before, dto, user.id);

    const rule = await this.prisma.$transaction(async (tx) => {
      await assertNoActiveRuleOverlap(tx, next, id);
      return tx.depositRule.update({
        data: next,
        where: { id }
      });
    });

    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: toDepositRuleView(rule),
      before: toDepositRuleView(before),
      entityId: id,
      entityType: "deposit_rule",
      ipAddress: context.ipAddress,
      module: "risk",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toDepositRuleView(rule);
  }

  async deleteDepositRule(id: string, user: RequestUser, context: RequestContext) {
    const before = await this.findDepositRuleOrThrow(id);

    const rule = await this.prisma.depositRule.update({
      data: {
        deletedAt: new Date(),
        status: RecordStatus.INACTIVE,
        updatedBy: user.id
      },
      where: { id }
    });

    await this.auditService.write({
      action: AuditAction.DELETE,
      after: toDepositRuleView(rule),
      before: toDepositRuleView(before),
      entityId: id,
      entityType: "deposit_rule",
      ipAddress: context.ipAddress,
      module: "risk",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return { id };
  }

  async getMatchedDepositRule(gradeInput: string | undefined, effectiveAtInput?: string) {
    const grade = parseCustomerGrade(gradeInput);
    const effectiveAt = effectiveAtInput
      ? parseDateOnly(effectiveAtInput, "effectiveAt")
      : new Date();
    const rule = await this.findActiveDepositRuleForGrade(grade, effectiveAt);

    if (!rule) {
      throw new NotFoundException("No active deposit rule matched this grade and date.");
    }

    return toDepositRuleView(rule);
  }

  async listApplicationRiskResults(applicationId: string, user: RequestUser) {
    const application = await this.prisma.application.findUnique({
      select: { deletedAt: true, id: true, salesUserId: true },
      where: { id: applicationId }
    });

    if (!application || application.deletedAt) {
      throw new NotFoundException("Application not found.");
    }

    if (!canViewAll(user) && application.salesUserId !== user.id) {
      throw new ForbiddenException("Application is outside your scope.");
    }

    const results = await this.prisma.riskResult.findMany({
      include: riskResultInclude,
      orderBy: { createdAt: "desc" },
      where: { applicationId, deletedAt: null }
    });

    return results.map(toRiskResultView);
  }

  async createApprovalRiskResult(
    tx: Prisma.TransactionClient,
    input: ApprovalRiskResultInput
  ): Promise<RiskResultWithDetails> {
    const rule = await this.findActiveDepositRuleForGrade(input.grade, input.approvedAt, tx);

    if (!rule) {
      throw new BadRequestException(`No active deposit rule configured for grade ${input.grade}.`);
    }

    return tx.riskResult.create({
      data: {
        applicationId: input.applicationId,
        approvedAt: input.approvedAt,
        approvedBy: input.operatorId,
        approvedDepositAmount: rule.depositAmount,
        createdBy: input.operatorId,
        customerId: input.customerId,
        defaultRate: rule.defaultRate,
        grade: input.grade,
        maxVehiclePurchasePriceAmount:
          input.maxVehiclePurchasePriceAmount === undefined
            ? undefined
            : BigInt(input.maxVehiclePurchasePriceAmount),
        remark: input.remark,
        result: RiskResultDecision.APPROVED,
        score: input.riskScore,
        updatedBy: input.operatorId
      },
      include: riskResultInclude
    });
  }

  async findActiveDepositRuleForGrade(
    grade: CustomerGrade,
    effectiveAt: Date,
    client: DepositRuleClient = this.prisma
  ) {
    const effectiveDate = toDateOnly(effectiveAt);

    return client.depositRule.findFirst({
      orderBy: { effectiveFrom: "desc" },
      where: {
        deletedAt: null,
        effectiveFrom: { lte: effectiveDate },
        grade,
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveDate } }],
        status: RecordStatus.ACTIVE
      }
    });
  }

  private async findDepositRuleOrThrow(id: string) {
    const rule = await this.prisma.depositRule.findUnique({ where: { id } });

    if (!rule || rule.deletedAt) {
      throw new NotFoundException("Deposit rule not found.");
    }

    return rule;
  }
}

function normalizeCreateDepositRule(
  dto: CreateDepositRuleDto,
  operatorId: string
): Prisma.DepositRuleCreateInput {
  const effectiveFrom = parseDateOnly(dto.effectiveFrom, "effectiveFrom");
  const effectiveTo = dto.effectiveTo ? parseDateOnly(dto.effectiveTo, "effectiveTo") : null;
  ensureValidDateRange(effectiveFrom, effectiveTo);

  return {
    createdBy: operatorId,
    customerRatio:
      dto.customerRatio === undefined || dto.customerRatio === null
        ? null
        : new Prisma.Decimal(dto.customerRatio),
    defaultRate: new Prisma.Decimal(dto.defaultRate),
    depositAmount: BigInt(dto.depositAmount),
    effectiveFrom,
    effectiveTo,
    grade: dto.grade,
    status: dto.status ?? RecordStatus.ACTIVE,
    updatedBy: operatorId
  };
}

function normalizeUpdateDepositRule(
  before: DepositRule,
  dto: UpdateDepositRuleDto,
  operatorId: string
): Prisma.DepositRuleUpdateInput & {
  effectiveFrom: Date;
  effectiveTo: Date | null;
  grade: CustomerGrade;
  status: RecordStatus;
} {
  const effectiveFrom = dto.effectiveFrom
    ? parseDateOnly(dto.effectiveFrom, "effectiveFrom")
    : before.effectiveFrom;
  const effectiveTo =
    dto.effectiveTo === undefined
      ? before.effectiveTo
      : dto.effectiveTo
        ? parseDateOnly(dto.effectiveTo, "effectiveTo")
        : null;
  ensureValidDateRange(effectiveFrom, effectiveTo);

  return {
    customerRatio:
      dto.customerRatio === undefined
        ? before.customerRatio
        : dto.customerRatio === null
          ? null
          : new Prisma.Decimal(dto.customerRatio),
    defaultRate:
      dto.defaultRate === undefined ? before.defaultRate : new Prisma.Decimal(dto.defaultRate),
    depositAmount:
      dto.depositAmount === undefined ? before.depositAmount : BigInt(dto.depositAmount),
    effectiveFrom,
    effectiveTo,
    grade: dto.grade ?? before.grade,
    status: dto.status ?? before.status,
    updatedBy: operatorId
  };
}

async function assertNoActiveRuleOverlap(
  client: DepositRuleClient,
  rule: {
    effectiveFrom: Date | string;
    effectiveTo?: Date | string | null;
    grade: CustomerGrade;
    status?: RecordStatus;
  },
  excludeId?: string
) {
  if (rule.status !== RecordStatus.ACTIVE) {
    return;
  }

  const effectiveFrom = toDateOnly(new Date(rule.effectiveFrom));
  const effectiveTo = rule.effectiveTo ? toDateOnly(new Date(rule.effectiveTo)) : null;
  const conflicting = await client.depositRule.findFirst({
    where: {
      ...(excludeId ? { id: { not: excludeId } } : {}),
      deletedAt: null,
      effectiveFrom: { lte: effectiveTo ?? FAR_FUTURE_DATE },
      grade: rule.grade,
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveFrom } }],
      status: RecordStatus.ACTIVE
    }
  });

  if (conflicting) {
    throw new BadRequestException("Active deposit rule date range overlaps an existing rule.");
  }
}

function parseCustomerGrade(value: string | undefined): CustomerGrade {
  if (!value || !Object.values(CustomerGrade).includes(value as CustomerGrade)) {
    throw new BadRequestException("Valid customer grade is required.");
  }

  return value as CustomerGrade;
}

function parseDateOnly(value: string, field: string) {
  const date = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);

  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${field} must be a valid date.`);
  }

  return date;
}

function ensureValidDateRange(effectiveFrom: Date, effectiveTo: Date | null) {
  if (effectiveTo && effectiveTo.getTime() < effectiveFrom.getTime()) {
    throw new BadRequestException("effectiveTo must be later than effectiveFrom.");
  }
}

function toDateOnly(date: Date) {
  return new Date(date.toISOString().slice(0, 10) + "T00:00:00.000Z");
}

function canViewAll(user: RequestUser) {
  return user.roles.some((role) => ["ADMIN", "GM", "RC"].includes(role));
}

export function dateRangesOverlap(
  leftStart: Date,
  leftEnd: Date | null | undefined,
  rightStart: Date,
  rightEnd: Date | null | undefined
) {
  const leftEndTime = leftEnd?.getTime() ?? Number.POSITIVE_INFINITY;
  const rightEndTime = rightEnd?.getTime() ?? Number.POSITIVE_INFINITY;

  return leftStart.getTime() <= rightEndTime && rightStart.getTime() <= leftEndTime;
}

export function toDepositRuleView(rule: DepositRule) {
  return {
    createdAt: rule.createdAt,
    customerRatio: rule.customerRatio === null ? null : Number(rule.customerRatio),
    defaultRate: Number(rule.defaultRate),
    depositAmount: Number(rule.depositAmount),
    effectiveFrom: rule.effectiveFrom.toISOString().slice(0, 10),
    effectiveTo: rule.effectiveTo?.toISOString().slice(0, 10) ?? null,
    grade: rule.grade,
    id: rule.id,
    status: rule.status
  };
}

export function toRiskResultView(result: RiskResultWithDetails) {
  return {
    applicationId: result.applicationId,
    approvedAt: result.approvedAt,
    approvedBy: result.approvedBy,
    approvedDepositAmount: Number(result.approvedDepositAmount),
    approver: result.approver,
    createdAt: result.createdAt,
    customerId: result.customerId,
    defaultRate: Number(result.defaultRate),
    grade: result.grade,
    id: result.id,
    maxVehiclePurchasePriceAmount:
      result.maxVehiclePurchasePriceAmount === null
        ? null
        : Number(result.maxVehiclePurchasePriceAmount),
    remark: result.remark,
    result: result.result,
    score: result.score
  };
}
