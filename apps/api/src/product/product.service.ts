import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException
} from "@nestjs/common";
import {
  ApplicationSource,
  ApplicationStatus,
  AuditAction,
  MonthlyFeeMode,
  Prisma,
  ProductStatus,
  ProductType,
  ProductVersionStatus,
  QuoteStatus,
  RecordStatus,
  RiskResultDecision,
  SalePriceStatus,
  SubscriptionPlanStatus,
  VehicleBatteryUsageType,
  VehicleStatus
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { createBusinessNo, withUniqueBusinessNoRetry } from "../common/business-number";
import { requireActiveVehicleModelDefinition } from "../common/vehicle-model-resolver";
import { trackVehicleModelUsage } from "../common/vehicle-model-usage-tracker";
import { buildVehicleModelSnapshot } from "../common/vehicle-model-snapshot";
import { PrismaService } from "../prisma/prisma.service";
import {
  CreatePriceRuleDto,
  CreateBenefitPackageDto,
  CreateEnergyPackageDto,
  CreateMileagePackageDto,
  CreateProductDto,
  CreateProductVersionDto,
  CreateQuoteDto,
  CreateSubscriptionPlanDto,
  CreateVehiclePackageDto,
  UpdateBenefitPackageDto,
  UpdateEnergyPackageDto,
  UpdateMileagePackageDto,
  UpdatePriceRuleDto,
  UpdateProductDto,
  UpdateProductVersionDto,
  UpdateVehiclePackageDto,
  UpdateQuoteDto,
  UpdateSubscriptionPlanDto
} from "./dto/product.dto";

const productModelDefinitionSelect = {
  customerDisplayName: true,
  displayName: true,
  enabled: true,
  id: true,
  modelCode: true
} satisfies Prisma.VehicleModelDefinitionSelect;

const packageInclude = {
  product: { select: { id: true, name: true, productNo: true, status: true } },
  productVersion: { select: { id: true, productId: true, status: true, versionNo: true } }
};

const vehiclePackageInclude = {
  modelDefinition: {
    select: productModelDefinitionSelect
  },
  product: { select: { id: true, name: true, productNo: true, status: true } },
  productVersion: { select: { id: true, productId: true, status: true, versionNo: true } }
} satisfies Prisma.VehiclePackageInclude;

const priceRuleListInclude = {
  modelDefinition: {
    select: productModelDefinitionSelect
  }
} satisfies Prisma.ProductPriceRuleInclude;

const priceRuleInclude = {
  modelDefinition: {
    select: productModelDefinitionSelect
  },
  productVersion: {
    include: { product: true }
  }
} satisfies Prisma.ProductPriceRuleInclude;

const productInclude = {
  versions: {
    include: {
      approver: { select: { id: true, name: true, username: true } },
      benefitPackages: { include: packageInclude, where: { deletedAt: null } },
      energyPackages: { include: packageInclude, where: { deletedAt: null } },
      mileagePackages: { include: packageInclude, where: { deletedAt: null } },
      priceRules: { include: priceRuleListInclude, where: { deletedAt: null } },
      vehiclePackages: { include: vehiclePackageInclude, where: { deletedAt: null } }
    },
    orderBy: { createdAt: "desc" as const },
    where: { deletedAt: null }
  }
} satisfies Prisma.ProductInclude;

const versionInclude = {
  approver: { select: { id: true, name: true, username: true } },
  priceRules: {
    include: priceRuleListInclude,
    orderBy: { modelDefinitionId: "asc" as const },
    where: { deletedAt: null }
  },
  benefitPackages: { include: packageInclude, where: { deletedAt: null } },
  energyPackages: { include: packageInclude, where: { deletedAt: null } },
  mileagePackages: { include: packageInclude, where: { deletedAt: null } },
  vehiclePackages: { include: vehiclePackageInclude, where: { deletedAt: null } },
  product: true
} satisfies Prisma.ProductVersionInclude;

const subscriptionPlanInclude = {
  benefitPackage: { include: packageInclude },
  energyPackage: { include: packageInclude },
  mileagePackage: { include: packageInclude },
  product: { select: { id: true, name: true, productNo: true, productType: true, status: true, deletedAt: true } },
  productVersion: {
    select: {
      deletedAt: true,
      effectiveFrom: true,
      effectiveTo: true,
      id: true,
      productId: true,
      status: true,
      versionNo: true
    }
  },
  vehiclePackage: { include: vehiclePackageInclude }
} satisfies Prisma.SubscriptionPlanInclude;

const VEHICLE_BASE_FEE_MODE_LABELS: Record<MonthlyFeeMode, string> = {
  [MonthlyFeeMode.FIXED_AMOUNT]: "固定金额",
  [MonthlyFeeMode.MANUAL_QUOTE]: "现场报价",
  [MonthlyFeeMode.RATE_FORMULA]: "固定费率"
};

const VEHICLE_BATTERY_USAGE_TYPE_LABELS: Record<VehicleBatteryUsageType, string> = {
  [VehicleBatteryUsageType.BAAS]: "BaaS / 电池租用",
  [VehicleBatteryUsageType.BUYOUT]: "电池买断"
};

const quoteInclude = {
  application: {
    select: { applicationNo: true, id: true, salesUserId: true, status: true }
  },
  confirmer: { select: { id: true, name: true, username: true } },
  customer: { select: { grade: true, id: true, mobile: true, name: true } },
  order: { select: { deletedAt: true, id: true, orderNo: true, orderStatus: true } },
  benefitPackage: { include: packageInclude },
  energyPackage: { include: packageInclude },
  mileagePackage: { include: packageInclude },
  productVersion: { include: { product: true } },
  riskResult: true,
  subscriptionPlan: { include: subscriptionPlanInclude },
  vehicle: {
    include: {
      modelDefinition: {
        select: { displayName: true, id: true, modelCode: true }
      }
    }
  },
  vehiclePackage: { include: vehiclePackageInclude }
} satisfies Prisma.SubscriptionQuoteInclude;

type ProductWithDetails = Prisma.ProductGetPayload<{ include: typeof productInclude }>;
type VersionWithDetails = Prisma.ProductVersionGetPayload<{ include: typeof versionInclude }>;
type SubscriptionPlanWithDetails = Prisma.SubscriptionPlanGetPayload<{ include: typeof subscriptionPlanInclude }>;
type QuoteWithDetails = Prisma.SubscriptionQuoteGetPayload<{ include: typeof quoteInclude }>;
type ProductListVersion = ProductWithDetails["versions"][number];
type ProductModelDefinition = Prisma.VehicleModelDefinitionGetPayload<{
  select: typeof productModelDefinitionSelect;
}>;
const CURRENT_PRODUCT_TYPE = ProductType.SUBSCRIPTION;
const RENT_TO_OWN_NOT_OPEN_MESSAGE = "当前阶段暂未开放以租代购产品线。";
const SELF_SERVICE_APPLICATION_QUOTE_MESSAGE = "客户自助进件请使用确认最终方案 / 生成正式订单流程。";
const productMapperLogger = new Logger("ProductService");

@Injectable()
export class ProductService {
  constructor(
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService
  ) {}

  async listProducts() {
    const products = await this.prisma.product.findMany({
      include: productInclude,
      orderBy: { createdAt: "desc" },
      where: { deletedAt: null, productType: CURRENT_PRODUCT_TYPE }
    });

    return products.map(toProductView);
  }

  async getProduct(id: string) {
    return toProductView(await this.findProductOrThrow(id));
  }

  async createProduct(dto: CreateProductDto, user: RequestUser, context: RequestContext) {
    const productType = ensureSubscriptionProductType(dto.productType);
    const product = await withUniqueBusinessNoRetry(() => this.prisma.product.create({
      data: {
        createdBy: user.id,
        description: dto.description,
        name: dto.name,
        productNo: createBusinessNo("PRD"),
        productType,
        status: dto.status ?? ProductStatus.DRAFT,
        updatedBy: user.id
      },
      include: productInclude
    }));

    await this.writeAudit(AuditAction.CREATE, "product", product.id, undefined, toProductView(product), user, context);
    return toProductView(product);
  }

  async updateProduct(id: string, dto: UpdateProductDto, user: RequestUser, context: RequestContext) {
    const before = await this.findProductOrThrow(id);
    const productType =
      dto.productType === undefined ? undefined : ensureSubscriptionProductType(dto.productType);
    const product = await this.prisma.product.update({
      data: {
        description: dto.description,
        name: dto.name,
        productType,
        updatedBy: user.id
      },
      include: productInclude,
      where: { id }
    });

    await this.writeAudit(AuditAction.UPDATE, "product", id, toProductView(before), toProductView(product), user, context);
    return toProductView(product);
  }

  async setProductStatus(
    id: string,
    status: ProductStatus,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.findProductOrThrow(id);
    const product = await this.prisma.product.update({
      data: { status, updatedBy: user.id },
      include: productInclude,
      where: { id }
    });

    await this.writeAudit(AuditAction.UPDATE, "product", id, toProductView(before), toProductView(product), user, context);
    return toProductView(product);
  }

  async listVersions(productId: string) {
    await this.findProductOrThrow(productId);
    const versions = await this.prisma.productVersion.findMany({
      include: versionInclude,
      orderBy: { createdAt: "desc" },
      where: { deletedAt: null, productId }
    });

    return versions.map((version) => toVersionView(version)).filter(isNonNullable);
  }

  async getVersion(id: string) {
    return toVersionView(await this.findVersionOrThrow(id));
  }

  async createVersion(
    productId: string,
    dto: CreateProductVersionDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const product = await this.findProductOrThrow(productId);
    ensureProductAllowsVersion(product);
    const effectiveFrom = parseDateOnly(dto.effectiveFrom, "effectiveFrom");
    const effectiveTo = dto.effectiveTo ? parseDateOnly(dto.effectiveTo, "effectiveTo") : null;
    ensureValidDateRange(effectiveFrom, effectiveTo);

    const version = await this.prisma.productVersion.create({
      data: {
        createdBy: user.id,
        effectiveFrom,
        effectiveTo,
        productId,
        status: dto.status ?? ProductVersionStatus.DRAFT,
        updatedBy: user.id,
        versionNo: dto.versionNo
      },
      include: versionInclude
    });

    await this.writeAudit(AuditAction.CREATE, "product_version", version.id, undefined, toVersionView(version), user, context);
    return toVersionView(version);
  }

  async createVersionGlobal(dto: CreateProductVersionDto, user: RequestUser, context: RequestContext) {
    if (!dto.productId) {
      throw new BadRequestException("请选择产品后再创建产品版本");
    }
    return this.createVersion(dto.productId, dto, user, context);
  }

  async updateVersion(
    id: string,
    dto: UpdateProductVersionDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.findVersionOrThrow(id);
    if (before.status === ProductVersionStatus.ACTIVE) {
      throw new BadRequestException("Active product versions cannot be edited.");
    }

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

    const version = await this.prisma.productVersion.update({
      data: {
        effectiveFrom,
        effectiveTo,
        updatedBy: user.id,
        versionNo: dto.versionNo
      },
      include: versionInclude,
      where: { id }
    });

    await this.writeAudit(AuditAction.UPDATE, "product_version", id, toVersionView(before), toVersionView(version), user, context);
    return toVersionView(version);
  }

  async approveVersion(id: string, user: RequestUser, context: RequestContext) {
    const before = await this.findVersionOrThrow(id);
    const version = await this.prisma.productVersion.update({
      data: {
        approvedAt: new Date(),
        approvedBy: user.id,
        status: ProductVersionStatus.APPROVED,
        updatedBy: user.id
      },
      include: versionInclude,
      where: { id }
    });

    await this.writeAudit(AuditAction.APPROVE, "product_version", id, toVersionView(before), toVersionView(version), user, context);
    return toVersionView(version);
  }

  async activateVersion(id: string, user: RequestUser, context: RequestContext) {
    const before = await this.findVersionOrThrow(id);
    const activePlan = await this.prisma.subscriptionPlan.findFirst({
      include: subscriptionPlanInclude,
      where: {
        deletedAt: null,
        productVersionId: id,
        status: SubscriptionPlanStatus.ACTIVE
      }
    });
    if (!activePlan || !isSubscriptionPlanComponentsActive(activePlan)) {
      throw new BadRequestException("请先配置并启用至少一个订阅套餐后再激活产品版本。");
    }

    const version = await this.prisma.$transaction(async (tx) => {
      await tx.productVersion.updateMany({
        data: { status: ProductVersionStatus.INACTIVE, updatedBy: user.id },
        where: {
          deletedAt: null,
          id: { not: id },
          productId: before.productId,
          status: ProductVersionStatus.ACTIVE
        }
      });

      return tx.productVersion.update({
        data: { status: ProductVersionStatus.ACTIVE, updatedBy: user.id },
        include: versionInclude,
        where: { id }
      });
    });

    await this.writeAudit(AuditAction.UPDATE, "product_version", id, toVersionView(before), toVersionView(version), user, context);
    return toVersionView(version);
  }

  async deactivateVersion(id: string, user: RequestUser, context: RequestContext) {
    const before = await this.findVersionOrThrow(id);
    const version = await this.prisma.productVersion.update({
      data: { status: ProductVersionStatus.INACTIVE, updatedBy: user.id },
      include: versionInclude,
      where: { id }
    });

    await this.writeAudit(AuditAction.UPDATE, "product_version", id, toVersionView(before), toVersionView(version), user, context);
    return toVersionView(version);
  }

  async listPriceRules(versionId: string) {
    await this.findVersionOrThrow(versionId);
    const rules = await this.prisma.productPriceRule.findMany({
      include: priceRuleInclude,
      orderBy: { modelDefinitionId: "asc" },
      where: { deletedAt: null, productVersionId: versionId }
    });
    return rules.map((rule) => toPriceRuleView(rule)).filter(isNonNullable);
  }

  async createPriceRule(
    versionId: string,
    dto: CreatePriceRuleDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const version = await this.findVersionOrThrow(versionId);
    ensureValidPeriod(dto.minPeriodMonths, dto.maxPeriodMonths);
    const modelIdentity = await requireActiveVehicleModelDefinition(
      this.prisma,
      dto.modelDefinitionId
    );

    const rule = await this.prisma.productPriceRule.create({
      data: {
        baseMileageKm: dto.baseMileageKm,
        createdBy: user.id,
        energyLimitCount: dto.energyLimitCount,
        energyLimitKwh: dto.energyLimitKwh,
        maxPeriodMonths: dto.maxPeriodMonths,
        minPeriodMonths: dto.minPeriodMonths,
        monthlyFeeRate: new Prisma.Decimal(dto.monthlyFeeRate ?? 0.035),
        modelDefinitionId: modelIdentity.modelDefinitionId,
        overMileageFeeAmount: BigInt(dto.overMileageFeeAmount),
        productVersionId: version.id,
        status: dto.status ?? RecordStatus.ACTIVE,
        updatedBy: user.id
      },
      include: priceRuleInclude
    });

    await this.writeAudit(AuditAction.CREATE, "product_price_rule", rule.id, undefined, toPriceRuleView(rule), user, context);
    return toPriceRuleView(rule);
  }

  async updatePriceRule(
    id: string,
    dto: UpdatePriceRuleDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.findPriceRuleOrThrow(id);
    ensureValidPeriod(
      dto.minPeriodMonths ?? before.minPeriodMonths,
      dto.maxPeriodMonths ?? before.maxPeriodMonths
    );
    const modelDefinitionId =
      dto.modelDefinitionId === undefined
        ? undefined
        : (
            await requireActiveVehicleModelDefinition(
              this.prisma,
              dto.modelDefinitionId
            )
          ).modelDefinitionId;

    const rule = await this.prisma.productPriceRule.update({
      data: {
        baseMileageKm: dto.baseMileageKm,
        energyLimitCount: dto.energyLimitCount,
        energyLimitKwh: dto.energyLimitKwh,
        maxPeriodMonths: dto.maxPeriodMonths,
        minPeriodMonths: dto.minPeriodMonths,
        modelDefinitionId,
        monthlyFeeRate:
          dto.monthlyFeeRate === undefined ? undefined : new Prisma.Decimal(dto.monthlyFeeRate),
        overMileageFeeAmount:
          dto.overMileageFeeAmount === undefined
            ? undefined
            : BigInt(dto.overMileageFeeAmount),
        status: dto.status,
        updatedBy: user.id
      },
      include: priceRuleInclude,
      where: { id }
    });

    await this.writeAudit(AuditAction.UPDATE, "product_price_rule", id, toPriceRuleView(before), toPriceRuleView(rule), user, context);
    return toPriceRuleView(rule);
  }

  async deletePriceRule(id: string, user: RequestUser, context: RequestContext) {
    const before = await this.findPriceRuleOrThrow(id);
    const rule = await this.prisma.productPriceRule.update({
      data: { deletedAt: new Date(), status: RecordStatus.INACTIVE, updatedBy: user.id },
      include: priceRuleInclude,
      where: { id }
    });
    await this.writeAudit(AuditAction.DELETE, "product_price_rule", id, toPriceRuleView(before), toPriceRuleView(rule), user, context);
    return { id };
  }

  async listVersionPackages(versionId: string) {
    await this.findVersionOrThrow(versionId);
    const [vehiclePackages, mileagePackages, energyPackages, benefitPackages] = await Promise.all([
      this.prisma.vehiclePackage.findMany({
        include: vehiclePackageInclude,
        orderBy: { createdAt: "desc" },
        where: { deletedAt: null, productVersionId: versionId, status: RecordStatus.ACTIVE }
      }),
      this.prisma.mileagePackage.findMany({
        include: packageInclude,
        orderBy: { createdAt: "desc" },
        where: { deletedAt: null, productVersionId: versionId, status: RecordStatus.ACTIVE }
      }),
      this.prisma.energyPackage.findMany({
        include: packageInclude,
        orderBy: { createdAt: "desc" },
        where: { deletedAt: null, productVersionId: versionId, status: RecordStatus.ACTIVE }
      }),
      this.prisma.benefitPackage.findMany({
        include: packageInclude,
        orderBy: { createdAt: "desc" },
        where: { deletedAt: null, productVersionId: versionId, status: RecordStatus.ACTIVE }
      })
    ]);
    return {
      benefitPackages: benefitPackages.map(toPackageView),
      energyPackages: energyPackages.map(toPackageView),
      mileagePackages: mileagePackages.map(toPackageView),
      vehiclePackages: vehiclePackages.map(toPackageView)
    };
  }

  async listVehiclePackages() {
    const rows = await this.prisma.vehiclePackage.findMany({
      include: vehiclePackageInclude,
      orderBy: { createdAt: "desc" },
      where: { deletedAt: null }
    });
    return rows.map(toPackageView);
  }

  async createVehiclePackage(dto: CreateVehiclePackageDto, user: RequestUser, context: RequestContext) {
    const version = await this.ensurePackageVersion(dto.productId, dto.productVersionId);
    ensureValidPeriod(dto.minPeriodMonths, dto.maxPeriodMonths);
    const modelIdentity = await requireActiveVehicleModelDefinition(
      this.prisma,
      dto.modelDefinitionId
    );
    const row = await withUniqueBusinessNoRetry(() => this.prisma.vehiclePackage.create({
      data: {
        brand: dto.brand,
        configName: dto.configName,
        createdBy: user.id,
        maxPeriodMonths: dto.maxPeriodMonths,
        maxPurchasePriceAmount: optionalBigInt(dto.maxPurchasePriceAmount),
        minPeriodMonths: dto.minPeriodMonths,
        minPurchasePriceAmount: optionalBigInt(dto.minPurchasePriceAmount),
        modelDefinitionId: modelIdentity.modelDefinitionId,
        monthlyFeeRate: new Prisma.Decimal(dto.monthlyFeeRate ?? 0.035),
        packageName: dto.packageName,
        packageNo: this.nextPackageNo("vehiclePackage", "VPK"),
        productId: version.productId,
        productVersionId: version.id,
        remark: dto.remark,
        series: dto.series,
        status: dto.status ?? RecordStatus.ACTIVE,
        updatedBy: user.id,
        vehicleModelName: dto.vehicleModelName
      },
      include: vehiclePackageInclude
    }));
    await this.writeAudit(AuditAction.CREATE, "vehicle_package", row.id, undefined, toPackageView(row), user, context);
    return toPackageView(row);
  }

  async updateVehiclePackage(id: string, dto: UpdateVehiclePackageDto, user: RequestUser, context: RequestContext) {
    const before = await this.findVehiclePackageOrThrow(id);
    ensureValidPeriod(dto.minPeriodMonths ?? before.minPeriodMonths, dto.maxPeriodMonths ?? before.maxPeriodMonths);
    const modelDefinitionId =
      dto.modelDefinitionId === undefined
        ? undefined
        : (
            await requireActiveVehicleModelDefinition(
              this.prisma,
              dto.modelDefinitionId
            )
          ).modelDefinitionId;
    const row = await this.prisma.vehiclePackage.update({
      data: {
        brand: dto.brand,
        configName: dto.configName,
        maxPeriodMonths: dto.maxPeriodMonths,
        maxPurchasePriceAmount: dto.maxPurchasePriceAmount === undefined ? undefined : optionalBigInt(dto.maxPurchasePriceAmount),
        minPeriodMonths: dto.minPeriodMonths,
        minPurchasePriceAmount: dto.minPurchasePriceAmount === undefined ? undefined : optionalBigInt(dto.minPurchasePriceAmount),
        modelDefinitionId,
        monthlyFeeRate: dto.monthlyFeeRate === undefined ? undefined : new Prisma.Decimal(dto.monthlyFeeRate),
        packageName: dto.packageName,
        remark: dto.remark,
        series: dto.series,
        updatedBy: user.id,
        vehicleModelName: dto.vehicleModelName
      },
      include: vehiclePackageInclude,
      where: { id }
    });
    await this.writeAudit(AuditAction.UPDATE, "vehicle_package", id, toPackageView(before), toPackageView(row), user, context);
    return toPackageView(row);
  }

  async setVehiclePackageStatus(id: string, status: RecordStatus, user: RequestUser, context: RequestContext) {
    const before = await this.findVehiclePackageOrThrow(id);
    const row = await this.prisma.vehiclePackage.update({ data: { status, updatedBy: user.id }, include: vehiclePackageInclude, where: { id } });
    await this.writeAudit(AuditAction.UPDATE, "vehicle_package", id, toPackageView(before), toPackageView(row), user, context);
    return toPackageView(row);
  }

  async deleteVehiclePackage(id: string, user: RequestUser, context: RequestContext) {
    const before = await this.findVehiclePackageOrThrow(id);
    const row = await this.prisma.vehiclePackage.update({ data: { deletedAt: new Date(), status: RecordStatus.INACTIVE, updatedBy: user.id }, include: vehiclePackageInclude, where: { id } });
    await this.writeAudit(AuditAction.DELETE, "vehicle_package", id, toPackageView(before), toPackageView(row), user, context);
    return toPackageView(row);
  }

  async listMileagePackages() {
    const rows = await this.prisma.mileagePackage.findMany({ include: packageInclude, orderBy: { createdAt: "desc" }, where: { deletedAt: null } });
    return rows.map(toPackageView);
  }

  async createMileagePackage(dto: CreateMileagePackageDto, user: RequestUser, context: RequestContext) {
    const version = await this.ensurePackageVersion(dto.productId, dto.productVersionId);
    const row = await withUniqueBusinessNoRetry(() => this.prisma.mileagePackage.create({
      data: {
        createdBy: user.id,
        monthlyMileageKm: dto.monthlyMileageKm,
        overMileageFeeAmount: BigInt(dto.overMileageFeeAmount),
        packageName: dto.packageName,
        packageNo: this.nextPackageNo("mileagePackage", "MPK"),
        priceAmount: BigInt(dto.priceAmount ?? 0),
        productId: version.productId,
        productVersionId: version.id,
        remark: dto.remark,
        status: dto.status ?? RecordStatus.ACTIVE,
        updatedBy: user.id
      },
      include: packageInclude
    }));
    await this.writeAudit(AuditAction.CREATE, "mileage_package", row.id, undefined, toPackageView(row), user, context);
    return toPackageView(row);
  }

  async updateMileagePackage(id: string, dto: UpdateMileagePackageDto, user: RequestUser, context: RequestContext) {
    const before = await this.findMileagePackageOrThrow(id);
    const row = await this.prisma.mileagePackage.update({
      data: {
        monthlyMileageKm: dto.monthlyMileageKm,
        overMileageFeeAmount: dto.overMileageFeeAmount === undefined ? undefined : BigInt(dto.overMileageFeeAmount),
        packageName: dto.packageName,
        priceAmount: dto.priceAmount === undefined ? undefined : BigInt(dto.priceAmount),
        remark: dto.remark,
        updatedBy: user.id
      },
      include: packageInclude,
      where: { id }
    });
    await this.writeAudit(AuditAction.UPDATE, "mileage_package", id, toPackageView(before), toPackageView(row), user, context);
    return toPackageView(row);
  }

  async setMileagePackageStatus(id: string, status: RecordStatus, user: RequestUser, context: RequestContext) {
    const before = await this.findMileagePackageOrThrow(id);
    const row = await this.prisma.mileagePackage.update({ data: { status, updatedBy: user.id }, include: packageInclude, where: { id } });
    await this.writeAudit(AuditAction.UPDATE, "mileage_package", id, toPackageView(before), toPackageView(row), user, context);
    return toPackageView(row);
  }

  async deleteMileagePackage(id: string, user: RequestUser, context: RequestContext) {
    const before = await this.findMileagePackageOrThrow(id);
    const row = await this.prisma.mileagePackage.update({ data: { deletedAt: new Date(), status: RecordStatus.INACTIVE, updatedBy: user.id }, include: packageInclude, where: { id } });
    await this.writeAudit(AuditAction.DELETE, "mileage_package", id, toPackageView(before), toPackageView(row), user, context);
    return toPackageView(row);
  }

  async listEnergyPackages() {
    const rows = await this.prisma.energyPackage.findMany({ include: packageInclude, orderBy: { createdAt: "desc" }, where: { deletedAt: null } });
    return rows.map(toPackageView);
  }

  async createEnergyPackage(dto: CreateEnergyPackageDto, user: RequestUser, context: RequestContext) {
    const version = await this.ensurePackageVersion(dto.productId, dto.productVersionId);
    const row = await withUniqueBusinessNoRetry(() => this.prisma.energyPackage.create({
      data: {
        createdBy: user.id,
        monthlyEnergyCount: dto.monthlyEnergyCount,
        monthlyEnergyKwh: dto.monthlyEnergyKwh,
        packageName: dto.packageName,
        packageNo: this.nextPackageNo("energyPackage", "EPK"),
        priceAmount: BigInt(dto.priceAmount ?? 0),
        productId: version.productId,
        productVersionId: version.id,
        remark: dto.remark,
        serviceDescription: dto.serviceDescription,
        stationScope: dto.stationScope,
        status: dto.status ?? RecordStatus.ACTIVE,
        updatedBy: user.id
      },
      include: packageInclude
    }));
    await this.writeAudit(AuditAction.CREATE, "energy_package", row.id, undefined, toPackageView(row), user, context);
    return toPackageView(row);
  }

  async updateEnergyPackage(id: string, dto: UpdateEnergyPackageDto, user: RequestUser, context: RequestContext) {
    const before = await this.findEnergyPackageOrThrow(id);
    const row = await this.prisma.energyPackage.update({
      data: {
        monthlyEnergyCount: dto.monthlyEnergyCount,
        monthlyEnergyKwh: dto.monthlyEnergyKwh,
        packageName: dto.packageName,
        priceAmount: dto.priceAmount === undefined ? undefined : BigInt(dto.priceAmount),
        remark: dto.remark,
        serviceDescription: dto.serviceDescription,
        stationScope: dto.stationScope,
        updatedBy: user.id
      },
      include: packageInclude,
      where: { id }
    });
    await this.writeAudit(AuditAction.UPDATE, "energy_package", id, toPackageView(before), toPackageView(row), user, context);
    return toPackageView(row);
  }

  async setEnergyPackageStatus(id: string, status: RecordStatus, user: RequestUser, context: RequestContext) {
    const before = await this.findEnergyPackageOrThrow(id);
    const row = await this.prisma.energyPackage.update({ data: { status, updatedBy: user.id }, include: packageInclude, where: { id } });
    await this.writeAudit(AuditAction.UPDATE, "energy_package", id, toPackageView(before), toPackageView(row), user, context);
    return toPackageView(row);
  }

  async deleteEnergyPackage(id: string, user: RequestUser, context: RequestContext) {
    const before = await this.findEnergyPackageOrThrow(id);
    const row = await this.prisma.energyPackage.update({ data: { deletedAt: new Date(), status: RecordStatus.INACTIVE, updatedBy: user.id }, include: packageInclude, where: { id } });
    await this.writeAudit(AuditAction.DELETE, "energy_package", id, toPackageView(before), toPackageView(row), user, context);
    return toPackageView(row);
  }

  async listBenefitPackages() {
    const rows = await this.prisma.benefitPackage.findMany({ include: packageInclude, orderBy: { createdAt: "desc" }, where: { deletedAt: null } });
    return rows.map(toPackageView);
  }

  async createBenefitPackage(dto: CreateBenefitPackageDto, user: RequestUser, context: RequestContext) {
    const version = await this.ensurePackageVersion(dto.productId, dto.productVersionId);
    const row = await withUniqueBusinessNoRetry(() => this.prisma.benefitPackage.create({
      data: {
        benefitCount: dto.benefitCount,
        benefitType: dto.benefitType,
        createdBy: user.id,
        description: dto.description,
        packageName: dto.packageName,
        packageNo: this.nextPackageNo("benefitPackage", "BPK"),
        priceAmount: BigInt(dto.priceAmount ?? 0),
        productId: version.productId,
        productVersionId: version.id,
        remark: dto.remark,
        status: dto.status ?? RecordStatus.ACTIVE,
        updatedBy: user.id
      },
      include: packageInclude
    }));
    await this.writeAudit(AuditAction.CREATE, "benefit_package", row.id, undefined, toPackageView(row), user, context);
    return toPackageView(row);
  }

  async updateBenefitPackage(id: string, dto: UpdateBenefitPackageDto, user: RequestUser, context: RequestContext) {
    const before = await this.findBenefitPackageOrThrow(id);
    const row = await this.prisma.benefitPackage.update({
      data: {
        benefitCount: dto.benefitCount,
        benefitType: dto.benefitType,
        description: dto.description,
        packageName: dto.packageName,
        priceAmount: dto.priceAmount === undefined ? undefined : BigInt(dto.priceAmount),
        remark: dto.remark,
        updatedBy: user.id
      },
      include: packageInclude,
      where: { id }
    });
    await this.writeAudit(AuditAction.UPDATE, "benefit_package", id, toPackageView(before), toPackageView(row), user, context);
    return toPackageView(row);
  }

  async setBenefitPackageStatus(id: string, status: RecordStatus, user: RequestUser, context: RequestContext) {
    const before = await this.findBenefitPackageOrThrow(id);
    const row = await this.prisma.benefitPackage.update({ data: { status, updatedBy: user.id }, include: packageInclude, where: { id } });
    await this.writeAudit(AuditAction.UPDATE, "benefit_package", id, toPackageView(before), toPackageView(row), user, context);
    return toPackageView(row);
  }

  async deleteBenefitPackage(id: string, user: RequestUser, context: RequestContext) {
    const before = await this.findBenefitPackageOrThrow(id);
    const row = await this.prisma.benefitPackage.update({ data: { deletedAt: new Date(), status: RecordStatus.INACTIVE, updatedBy: user.id }, include: packageInclude, where: { id } });
    await this.writeAudit(AuditAction.DELETE, "benefit_package", id, toPackageView(before), toPackageView(row), user, context);
    return toPackageView(row);
  }

  async listSubscriptionPlans() {
    const plans = await this.prisma.subscriptionPlan.findMany({
      include: subscriptionPlanInclude,
      orderBy: { createdAt: "desc" },
      where: { deletedAt: null }
    });
    return plans.map(toSubscriptionPlanView);
  }

  async getSubscriptionPlan(id: string) {
    const plan = await this.findSubscriptionPlanOrThrow(id);
    return toSubscriptionPlanView(plan);
  }

  async createSubscriptionPlan(
    dto: CreateSubscriptionPlanDto,
    user: RequestUser,
    context: RequestContext
  ) {
    ensureValidPeriod(dto.minPeriodMonths, dto.maxPeriodMonths);
    const effectiveFrom = parseDateOnly(dto.effectiveFrom, "effectiveFrom");
    const effectiveTo = dto.effectiveTo ? parseDateOnly(dto.effectiveTo, "effectiveTo") : null;
    ensureValidDateRange(effectiveFrom, effectiveTo);
    const packages = await this.resolveSubscriptionPlanPackages({
      benefitPackageId: dto.benefitPackageId,
      energyPackageId: dto.energyPackageId,
      mileagePackageId: dto.mileagePackageId,
      productId: dto.productId,
      productVersionId: dto.productVersionId,
      vehiclePackageId: dto.vehiclePackageId
    });
    if (dto.status === SubscriptionPlanStatus.ACTIVE) {
      ensureSubscriptionPlanCanActivate({
        ...packages,
        effectiveFrom,
        effectiveTo
      });
    }

    const plan = await withUniqueBusinessNoRetry(() => this.prisma.subscriptionPlan.create({
      data: {
        baseMonthlyFeeAmount:
          dto.baseMonthlyFeeAmount === undefined || dto.baseMonthlyFeeAmount === null
            ? null
            : BigInt(dto.baseMonthlyFeeAmount),
        benefitPackageId: packages.benefitPackage?.id ?? null,
        createdBy: user.id,
        effectiveFrom,
        effectiveTo,
        energyPackageId: packages.energyPackage.id,
        maxPeriodMonths: dto.maxPeriodMonths,
        mileagePackageId: packages.mileagePackage.id,
        minPeriodMonths: dto.minPeriodMonths,
        monthlyFeeCapRate:
          dto.monthlyFeeCapRate === undefined || dto.monthlyFeeCapRate === null
            ? null
            : new Prisma.Decimal(dto.monthlyFeeCapRate),
        monthlyFeeMode: dto.monthlyFeeMode ?? MonthlyFeeMode.MANUAL_QUOTE,
        monthlyFeeRate: new Prisma.Decimal(dto.monthlyFeeRate ?? packages.vehiclePackage.monthlyFeeRate),
        planName: dto.planName,
        planNo: createBusinessNo("PLAN"),
        productId: packages.product.id,
        productVersionId: packages.productVersion.id,
        remark: dto.remark,
        status: dto.status ?? SubscriptionPlanStatus.DRAFT,
        updatedBy: user.id,
        vehiclePackageId: packages.vehiclePackage.id
      },
      include: subscriptionPlanInclude
    }));

    await this.writeAudit(AuditAction.CREATE, "subscription_plan", plan.id, undefined, toSubscriptionPlanView(plan), user, context);
    return toSubscriptionPlanView(plan);
  }

  async updateSubscriptionPlan(
    id: string,
    dto: UpdateSubscriptionPlanDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.findSubscriptionPlanOrThrow(id);
    const minPeriodMonths = dto.minPeriodMonths ?? before.minPeriodMonths;
    const maxPeriodMonths = dto.maxPeriodMonths ?? before.maxPeriodMonths;
    ensureValidPeriod(minPeriodMonths, maxPeriodMonths);
    const effectiveFrom = dto.effectiveFrom
      ? parseDateOnly(dto.effectiveFrom, "effectiveFrom")
      : before.effectiveFrom;
    const effectiveTo = dto.effectiveTo === undefined
      ? before.effectiveTo
      : dto.effectiveTo
        ? parseDateOnly(dto.effectiveTo, "effectiveTo")
        : null;
    ensureValidDateRange(effectiveFrom, effectiveTo);
    const packages = await this.resolveSubscriptionPlanPackages({
      benefitPackageId: dto.benefitPackageId === undefined ? before.benefitPackageId : dto.benefitPackageId,
      energyPackageId: dto.energyPackageId ?? before.energyPackageId,
      mileagePackageId: dto.mileagePackageId ?? before.mileagePackageId,
      productId: before.productId,
      productVersionId: before.productVersionId,
      vehiclePackageId: dto.vehiclePackageId ?? before.vehiclePackageId
    });
    if (before.status === SubscriptionPlanStatus.ACTIVE) {
      ensureSubscriptionPlanCanActivate({
        ...packages,
        effectiveFrom,
        effectiveTo
      });
    }

    const plan = await this.prisma.subscriptionPlan.update({
      data: {
        baseMonthlyFeeAmount:
          dto.baseMonthlyFeeAmount === undefined
            ? undefined
            : dto.baseMonthlyFeeAmount === null
              ? null
              : BigInt(dto.baseMonthlyFeeAmount),
        benefitPackageId: packages.benefitPackage?.id ?? null,
        effectiveFrom,
        effectiveTo,
        energyPackageId: packages.energyPackage.id,
        maxPeriodMonths,
        mileagePackageId: packages.mileagePackage.id,
        minPeriodMonths,
        monthlyFeeCapRate:
          dto.monthlyFeeCapRate === undefined
            ? undefined
            : dto.monthlyFeeCapRate === null
              ? null
              : new Prisma.Decimal(dto.monthlyFeeCapRate),
        monthlyFeeMode: dto.monthlyFeeMode,
        monthlyFeeRate:
          dto.monthlyFeeRate === undefined ? undefined : new Prisma.Decimal(dto.monthlyFeeRate),
        planName: dto.planName,
        remark: dto.remark,
        updatedBy: user.id,
        vehiclePackageId: packages.vehiclePackage.id
      },
      include: subscriptionPlanInclude,
      where: { id }
    });

    await this.writeAudit(AuditAction.UPDATE, "subscription_plan", id, toSubscriptionPlanView(before), toSubscriptionPlanView(plan), user, context);
    return toSubscriptionPlanView(plan);
  }

  async setSubscriptionPlanStatus(
    id: string,
    status: SubscriptionPlanStatus,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.findSubscriptionPlanOrThrow(id);
    if (status === SubscriptionPlanStatus.ACTIVE) {
      ensureSubscriptionPlanCanActivate(before);
    }
    const plan = await this.prisma.subscriptionPlan.update({
      data: { status, updatedBy: user.id },
      include: subscriptionPlanInclude,
      where: { id }
    });
    await this.writeAudit(AuditAction.UPDATE, "subscription_plan", id, toSubscriptionPlanView(before), toSubscriptionPlanView(plan), user, context);
    return toSubscriptionPlanView(plan);
  }

  async deleteSubscriptionPlan(id: string, user: RequestUser, context: RequestContext) {
    const before = await this.findSubscriptionPlanOrThrow(id);
    const plan = await this.prisma.subscriptionPlan.update({
      data: {
        deletedAt: new Date(),
        status: SubscriptionPlanStatus.INACTIVE,
        updatedBy: user.id
      },
      include: subscriptionPlanInclude,
      where: { id }
    });
    await this.writeAudit(AuditAction.DELETE, "subscription_plan", id, toSubscriptionPlanView(before), toSubscriptionPlanView(plan), user, context);
    return toSubscriptionPlanView(plan);
  }

  async listAvailableSubscriptionPlans(applicationId: string, user: RequestUser, vehicleId?: string) {
    const application = await this.prisma.application.findUnique({
      select: { applicationSource: true, deletedAt: true, id: true, salesUserId: true, status: true },
      where: { id: applicationId }
    });
    if (!application || application.deletedAt) {
      throw new NotFoundException("Application not found.");
    }
    if (!canViewAllQuotes(user) && application.salesUserId !== user.id) {
      throw new ForbiddenException("Application is outside your scope.");
    }
    if (application.applicationSource === ApplicationSource.SELF_SERVICE) {
      throw new BadRequestException(SELF_SERVICE_APPLICATION_QUOTE_MESSAGE);
    }
    if (application.status !== ApplicationStatus.APPROVED) {
      throw new BadRequestException("只有审批通过的进件可以获取可报价套餐。");
    }

    const vehicle = vehicleId ? await this.findAvailableVehicleForQuote(vehicleId) : null;
    const today = new Date();
    const plans = await this.prisma.subscriptionPlan.findMany({
      include: subscriptionPlanInclude,
      orderBy: { createdAt: "desc" },
      where: {
        deletedAt: null,
        effectiveFrom: { lte: today },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }],
        product: { deletedAt: null, status: ProductStatus.ACTIVE },
        productVersion: { deletedAt: null, status: ProductVersionStatus.ACTIVE },
        status: SubscriptionPlanStatus.ACTIVE
      }
    });

    return plans
      .filter(isSubscriptionPlanCurrentlyAvailable)
      .filter((plan) =>
        vehicle
          ? vehicle.modelDefinitionId === plan.vehiclePackage.modelDefinitionId
          : true
      )
      .map(toAvailableSubscriptionPlanView);
  }

  async listQuotes(user: RequestUser) {
    const quotes = await this.prisma.subscriptionQuote.findMany({
      include: quoteInclude,
      orderBy: { createdAt: "desc" },
      where: {
        deletedAt: null,
        ...(canViewAllQuotes(user) ? {} : { application: { salesUserId: user.id } })
      }
    });
    return quotes.map(toQuoteView);
  }

  async getQuote(id: string, user: RequestUser) {
    const quote = await this.findQuoteOrThrow(id);
    ensureCanAccessQuote(quote, user);
    return toQuoteView(quote);
  }

  async createQuote(
    applicationId: string,
    dto: CreateQuoteDto,
    user: RequestUser,
    context: RequestContext
  ) {
    if (dto.productType !== undefined) {
      ensureSubscriptionProductType(dto.productType);
    }
    ensureNoRentToOwnQuoteFields(dto);
    const application = await this.prisma.application.findUnique({
      include: {
        customer: true,
        riskResults: {
          orderBy: { createdAt: "desc" },
          where: { deletedAt: null, result: RiskResultDecision.APPROVED }
        }
      },
      where: { id: applicationId }
    });

    if (!application || application.deletedAt) {
      throw new NotFoundException("Application not found.");
    }
    if (!canViewAllQuotes(user) && application.salesUserId !== user.id) {
      throw new ForbiddenException("Application is outside your scope.");
    }
    if (application.applicationSource === ApplicationSource.SELF_SERVICE) {
      throw new BadRequestException(SELF_SERVICE_APPLICATION_QUOTE_MESSAGE);
    }
    if (application.status !== ApplicationStatus.APPROVED) {
      throw new BadRequestException("Only approved applications can be quoted.");
    }
    if (!application.customer.grade) {
      throw new BadRequestException("Customer grade is required before quote generation.");
    }

    const riskResult = application.riskResults[0];
    if (!riskResult) {
      throw new BadRequestException("Approved risk result is required before quote generation.");
    }

    const depositRule = await this.prisma.depositRule.findFirst({
      orderBy: { effectiveFrom: "desc" },
      where: {
        deletedAt: null,
        effectiveFrom: { lte: new Date() },
        grade: application.customer.grade,
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date() } }],
        status: RecordStatus.ACTIVE
      }
    });
    if (!depositRule) {
      throw new BadRequestException(`No active deposit rule configured for grade ${application.customer.grade}.`);
    }

    const depositRuleSnapshot = toJsonValue({
      customerGrade: application.customer.grade,
      defaultRate: Number(depositRule.defaultRate),
      depositAmount: Number(depositRule.depositAmount),
      grade: depositRule.grade,
      id: depositRule.id
    });
    const componentQuote = !dto.subscriptionPlanId && Boolean(dto.vehiclePackageId || dto.mileagePackageId || dto.energyPackageId || dto.benefitPackageId);
    let quoteData: {
      benefitPackageId?: string | null;
      depositRuleSnapshot?: Prisma.InputJsonValue;
      energyLimitCount?: number | null;
      energyLimitKwh?: number | null;
      energyPackageId?: string;
      mileageLimitKm: number;
      mileagePackageId?: string;
      monthlyFeeCapAmount?: bigint;
      monthlyFeeAmount: bigint;
      monthlyFeeRate: Prisma.Decimal;
      overMileageFeeAmount: bigint;
      packageSnapshot?: Prisma.InputJsonValue;
      productId: string;
      productVersionId: string;
      subscriptionPlanId?: string | null;
      vehicleBaseFeeAmount?: bigint;
      vehicleBaseFeeCapAmount?: bigint;
      vehicleId?: string | null;
      modelCodeSnapshot: string;
      modelDefinitionIdSnapshot: string;
      modelDisplayNameSnapshot: string;
      vehiclePackageId?: string;
      vehiclePurchasePriceAmount: bigint;
      vehicleSalePriceAmount?: bigint;
      vehicleSnapshot?: Prisma.InputJsonValue;
      mileagePackagePriceAmount?: bigint;
      energyPackagePriceAmount?: bigint;
      benefitPackagePriceAmount?: bigint;
    };

    if (dto.subscriptionPlanId) {
      ensureNoLegacySubscriptionPlanQuoteFields(dto);
      if (!dto.vehicleId) {
        throw new BadRequestException("报价必须选择具体车辆");
      }
      const vehicle = await this.findAvailableVehicleForQuote(dto.vehicleId);
      const plan = await this.findSubscriptionPlanOrThrow(dto.subscriptionPlanId);
      ensureSubscriptionPlanAvailableForQuote(plan);
      if (vehicle.modelDefinitionId !== plan.vehiclePackage.modelDefinitionId) {
        throw new BadRequestException("所选套餐不适用于该车型");
      }
      ensurePeriodInRange(dto.periodMonths, plan);
      const vehicleSalePriceAmount = vehicle.currentSalePriceAmount;
      if (!vehicleSalePriceAmount || vehicleSalePriceAmount <= 0n) {
        throw new BadRequestException("当前车辆销售价未初始化，无法生成报价");
      }
      const vehicleBaseFeePricing = calculateVehicleBaseFeeForSubscriptionPlan(
        plan,
        vehicleSalePriceAmount,
        dto.vehicleBaseFeeAmount
      );
      const mileagePackagePriceAmount = plan.mileagePackage.priceAmount;
      const energyPackagePriceAmount = plan.energyPackage.priceAmount;
      const benefitPackagePriceAmount = plan.benefitPackage?.priceAmount ?? 0n;
      const monthlyFeeAmount =
        vehicleBaseFeePricing.vehicleBaseFeeAmount +
        mileagePackagePriceAmount +
        energyPackagePriceAmount +
        benefitPackagePriceAmount;
      const vehicleSnapshot = toJsonValue({
        assetLocation: vehicle.assetLocation,
        batteryCapacityKwh: vehicle.batteryCapacityKwh?.toNumber() ?? null,
        batteryUsageType: vehicle.batteryUsageType,
        batteryUsageTypeLabel: VEHICLE_BATTERY_USAGE_TYPE_LABELS[vehicle.batteryUsageType],
        brand: vehicle.brand,
        currentMileageKm: vehicle.currentMileageKm,
        currentSalePriceAmount: Number(vehicleSalePriceAmount),
        plateNo: vehicle.plateNo,
        series: vehicle.series,
        status: vehicle.status,
        modelCode: vehicle.modelDefinition.modelCode,
        vehicleNo: vehicle.vehicleNo,
        vin: vehicle.vin
      });
      const modelSnapshot = buildVehicleModelSnapshot({
        modelCode: vehicle.modelDefinition.modelCode,
        modelDefinitionId: vehicle.modelDefinitionId,
        modelDisplayName: vehicle.modelDefinition.displayName
      });
      quoteData = {
        benefitPackageId: plan.benefitPackage?.id ?? null,
        depositRuleSnapshot,
        energyLimitCount: plan.energyPackage.monthlyEnergyCount,
        energyLimitKwh: plan.energyPackage.monthlyEnergyKwh,
        energyPackageId: plan.energyPackage.id,
        energyPackagePriceAmount,
        benefitPackagePriceAmount,
        mileageLimitKm: plan.mileagePackage.monthlyMileageKm,
        mileagePackageId: plan.mileagePackage.id,
        mileagePackagePriceAmount,
        monthlyFeeAmount,
        monthlyFeeCapAmount: vehicleBaseFeePricing.vehicleBaseFeeCapAmount,
        monthlyFeeRate: plan.monthlyFeeRate,
        ...modelSnapshot,
        overMileageFeeAmount: plan.mileagePackage.overMileageFeeAmount,
        packageSnapshot: toJsonValue({
          benefitPackage: plan.benefitPackage ? toPackageView(plan.benefitPackage) : null,
          energyPackage: toPackageView(plan.energyPackage),
          mileagePackage: toPackageView(plan.mileagePackage),
          pricing: {
            benefitPackagePriceAmount: Number(benefitPackagePriceAmount),
            currentSalePriceAmount: Number(vehicleSalePriceAmount),
            energyPackagePriceAmount: Number(energyPackagePriceAmount),
            fixedRate: vehicleBaseFeePricing.fixedRate,
            mileagePackagePriceAmount: Number(mileagePackagePriceAmount),
            monthlyFeeAmount: Number(monthlyFeeAmount),
            vehicleBaseFeeAmount: Number(vehicleBaseFeePricing.vehicleBaseFeeAmount),
            vehicleBaseFeeCapAmount: Number(vehicleBaseFeePricing.vehicleBaseFeeCapAmount),
            vehicleBaseFeeMode: plan.monthlyFeeMode,
            vehicleBaseFeeModeLabel: vehicleBaseFeePricing.vehicleBaseFeeModeLabel
          },
          subscriptionPlan: toSubscriptionPlanView(plan),
          vehicleBaseFeeAmount: Number(vehicleBaseFeePricing.vehicleBaseFeeAmount),
          vehicleBaseFeeCapAmount: Number(vehicleBaseFeePricing.vehicleBaseFeeCapAmount),
          vehicleBaseFeeMode: plan.monthlyFeeMode,
          vehicleBaseFeeModeLabel: vehicleBaseFeePricing.vehicleBaseFeeModeLabel,
          vehiclePackage: toPackageView(plan.vehiclePackage)
        }),
        productId: plan.productId,
        productVersionId: plan.productVersionId,
        subscriptionPlanId: plan.id,
        vehicleBaseFeeAmount: vehicleBaseFeePricing.vehicleBaseFeeAmount,
        vehicleBaseFeeCapAmount: vehicleBaseFeePricing.vehicleBaseFeeCapAmount,
        vehicleId: vehicle.id,
        vehiclePackageId: plan.vehiclePackage.id,
        vehiclePurchasePriceAmount: vehicle.purchasePriceAmount,
        vehicleSalePriceAmount,
        vehicleSnapshot
      };
    } else if (componentQuote) {
      const vehiclePurchasePriceAmount = requirePositiveInteger(dto.vehiclePurchasePriceAmount, "车辆采购价必须大于 0");
      const monthlyFeeAmount = requirePositiveInteger(dto.monthlyFeeAmount, "报价月费必须大于 0");
      if (!dto.productVersionId) {
        throw new BadRequestException("请选择产品版本。");
      }
      if (!dto.productId || !dto.vehiclePackageId || !dto.mileagePackageId || !dto.energyPackageId) {
        throw new BadRequestException("请选择完整的订阅产品、产品版本、车型包、里程包和补能包");
      }
      const version = await this.findVersionOrThrow(dto.productVersionId);
      ensureSubscriptionProductType(version.product.productType);
      if (version.status !== ProductVersionStatus.ACTIVE || version.product.status !== ProductStatus.ACTIVE) {
        throw new BadRequestException("产品版本必须为启用状态");
      }
      if (version.productId !== dto.productId) {
        throw new BadRequestException("产品与产品版本不一致");
      }
      const [vehiclePackage, mileagePackage, energyPackage, benefitPackage] = await Promise.all([
        this.prisma.vehiclePackage.findFirst({ include: vehiclePackageInclude, where: { deletedAt: null, id: dto.vehiclePackageId, status: RecordStatus.ACTIVE } }),
        this.prisma.mileagePackage.findFirst({ include: packageInclude, where: { deletedAt: null, id: dto.mileagePackageId, status: RecordStatus.ACTIVE } }),
        this.prisma.energyPackage.findFirst({ include: packageInclude, where: { deletedAt: null, id: dto.energyPackageId, status: RecordStatus.ACTIVE } }),
        dto.benefitPackageId
          ? this.prisma.benefitPackage.findFirst({ include: packageInclude, where: { deletedAt: null, id: dto.benefitPackageId, status: RecordStatus.ACTIVE } })
          : Promise.resolve(null)
      ]);
      if (!vehiclePackage || !mileagePackage || !energyPackage || (dto.benefitPackageId && !benefitPackage)) {
        throw new BadRequestException("所选订阅组件不存在或未启用");
      }
      ensurePackagesSameVersion(dto.productVersionId, vehiclePackage, mileagePackage, energyPackage, benefitPackage);
      ensurePeriodInRange(dto.periodMonths, vehiclePackage);
      assertMonthlyFeeWithinCap(monthlyFeeAmount, vehiclePurchasePriceAmount, vehiclePackage.monthlyFeeRate);
      ensurePurchasePriceInRange(vehiclePurchasePriceAmount, vehiclePackage);
      const modelSnapshot = buildVehicleModelSnapshot({
        modelCode: vehiclePackage.modelDefinition.modelCode,
        modelDefinitionId: vehiclePackage.modelDefinitionId,
        modelDisplayName: vehiclePackage.modelDefinition.displayName
      });
      quoteData = {
        benefitPackageId: benefitPackage?.id ?? null,
        energyLimitCount: energyPackage.monthlyEnergyCount,
        energyLimitKwh: energyPackage.monthlyEnergyKwh,
        energyPackageId: energyPackage.id,
        mileageLimitKm: mileagePackage.monthlyMileageKm,
        mileagePackageId: mileagePackage.id,
        monthlyFeeAmount: BigInt(monthlyFeeAmount),
        monthlyFeeRate: vehiclePackage.monthlyFeeRate,
        ...modelSnapshot,
        overMileageFeeAmount: mileagePackage.overMileageFeeAmount,
        packageSnapshot: toJsonValue({
          benefitPackage: benefitPackage ? toPackageView(benefitPackage) : null,
          depositRule: {
            defaultRate: Number(depositRule.defaultRate),
            depositAmount: Number(depositRule.depositAmount),
            grade: depositRule.grade,
            id: depositRule.id
          },
          energyPackage: toPackageView(energyPackage),
          mileagePackage: toPackageView(mileagePackage),
          monthlyFeeCapAmount: Math.floor(vehiclePurchasePriceAmount * Number(vehiclePackage.monthlyFeeRate)),
          vehiclePackage: toPackageView(vehiclePackage)
        }),
        productId: version.productId,
        productVersionId: version.id,
        vehiclePackageId: vehiclePackage.id,
        vehiclePurchasePriceAmount: BigInt(vehiclePurchasePriceAmount)
      };
    } else {
      const vehiclePurchasePriceAmount = requirePositiveInteger(dto.vehiclePurchasePriceAmount, "车辆采购价必须大于 0");
      const monthlyFeeAmount = requirePositiveInteger(dto.monthlyFeeAmount, "报价月费必须大于 0");
      if (!dto.productVersionId || !dto.modelDefinitionId) {
        throw new BadRequestException("请选择产品版本和车辆型号。");
      }
      const modelIdentity = await requireActiveVehicleModelDefinition(
        this.prisma,
        dto.modelDefinitionId
      );
      const priceRule = await this.findActivePriceRule(
        dto.productVersionId,
        modelIdentity.modelDefinitionId
      );
      ensurePeriodInRange(dto.periodMonths, priceRule);
      assertMonthlyFeeWithinCap(monthlyFeeAmount, vehiclePurchasePriceAmount, priceRule.monthlyFeeRate);
      const modelSnapshot = buildVehicleModelSnapshot(modelIdentity);
      quoteData = {
        energyLimitCount: dto.energyLimitCount ?? priceRule.energyLimitCount,
        energyLimitKwh: dto.energyLimitKwh ?? priceRule.energyLimitKwh,
        mileageLimitKm: dto.mileageLimitKm ?? priceRule.baseMileageKm,
        monthlyFeeAmount: BigInt(monthlyFeeAmount),
        monthlyFeeRate: priceRule.monthlyFeeRate,
        ...modelSnapshot,
        overMileageFeeAmount: priceRule.overMileageFeeAmount,
        productId: priceRule.productVersion.productId,
        productVersionId: dto.productVersionId,
        vehiclePurchasePriceAmount: BigInt(vehiclePurchasePriceAmount)
      };
    }

    const quote = await withUniqueBusinessNoRetry(() => this.prisma.subscriptionQuote.create({
      data: {
        applicationId,
        createdBy: user.id,
        customerId: application.customerId,
        depositAmount: depositRule.depositAmount,
        benefitPackageId: quoteData.benefitPackageId,
        depositRuleSnapshot: quoteData.depositRuleSnapshot,
        energyLimitCount: quoteData.energyLimitCount,
        energyLimitKwh: quoteData.energyLimitKwh,
        energyPackageId: quoteData.energyPackageId,
        energyPackagePriceAmount: quoteData.energyPackagePriceAmount,
        benefitPackagePriceAmount: quoteData.benefitPackagePriceAmount,
        mileageLimitKm: quoteData.mileageLimitKm,
        mileagePackageId: quoteData.mileagePackageId,
        mileagePackagePriceAmount: quoteData.mileagePackagePriceAmount,
        monthlyFeeAmount: quoteData.monthlyFeeAmount,
        monthlyFeeCapAmount: quoteData.monthlyFeeCapAmount,
        monthlyFeeRate: quoteData.monthlyFeeRate,
        modelCodeSnapshot: quoteData.modelCodeSnapshot,
        modelDefinitionIdSnapshot: quoteData.modelDefinitionIdSnapshot,
        modelDisplayNameSnapshot: quoteData.modelDisplayNameSnapshot,
        overMileageFeeAmount: quoteData.overMileageFeeAmount,
        packageSnapshot: quoteData.packageSnapshot,
        periodMonths: dto.periodMonths,
        productId: quoteData.productId,
        productVersionId: quoteData.productVersionId,
        quoteNo: createBusinessNo("QUO"),
        riskResultId: riskResult.id,
        subscriptionPlanId: quoteData.subscriptionPlanId,
        updatedBy: user.id,
        vehicleBaseFeeAmount: quoteData.vehicleBaseFeeAmount,
        vehicleBaseFeeCapAmount: quoteData.vehicleBaseFeeCapAmount,
        vehicleId: quoteData.vehicleId,
        vehiclePackageId: quoteData.vehiclePackageId,
        vehiclePurchasePriceAmount: quoteData.vehiclePurchasePriceAmount,
        vehicleSalePriceAmount: quoteData.vehicleSalePriceAmount,
        vehicleSnapshot: quoteData.vehicleSnapshot
      },
      include: quoteInclude
    }));

    await this.writeAudit(AuditAction.CREATE, "subscription_quote", quote.id, undefined, toQuoteView(quote), user, context);
    return toQuoteView(quote);
  }

  async updateQuote(id: string, dto: UpdateQuoteDto, user: RequestUser, context: RequestContext) {
    const before = await this.findQuoteOrThrow(id);
    ensureCanAccessQuote(before, user);
    if (before.status !== QuoteStatus.DRAFT) {
      throw new BadRequestException("Only draft quotes can be updated.");
    }
    const monthlyFeeAmount = dto.monthlyFeeAmount ?? Number(before.monthlyFeeAmount);
    const periodMonths = dto.periodMonths ?? before.periodMonths;
    if (before.subscriptionPlan) {
      ensureSubscriptionPlanAvailableForQuote(before.subscriptionPlan);
      ensurePeriodInRange(periodMonths, before.subscriptionPlan);
    } else {
      const priceRule = await this.findActivePriceRule(
        before.productVersionId,
        before.modelDefinitionIdSnapshot
      );
      ensurePeriodInRange(periodMonths, priceRule);
    }
    assertMonthlyFeeWithinCap(
      monthlyFeeAmount,
      Number(before.vehiclePurchasePriceAmount),
      before.subscriptionPlan?.monthlyFeeCapRate ?? before.monthlyFeeRate
    );

    const quote = await this.prisma.subscriptionQuote.update({
      data: {
        energyLimitCount: dto.energyLimitCount,
        energyLimitKwh: dto.energyLimitKwh,
        mileageLimitKm: dto.mileageLimitKm,
        monthlyFeeAmount:
          dto.monthlyFeeAmount === undefined ? undefined : BigInt(dto.monthlyFeeAmount),
        periodMonths: dto.periodMonths,
        status: dto.status,
        updatedBy: user.id
      },
      include: quoteInclude,
      where: { id }
    });
    await this.writeAudit(AuditAction.UPDATE, "subscription_quote", id, toQuoteView(before), toQuoteView(quote), user, context);
    return toQuoteView(quote);
  }

  async confirmQuote(id: string, user: RequestUser, context: RequestContext) {
    const before = await this.findQuoteOrThrow(id);
    ensureCanAccessQuote(before, user);
    if (before.status !== QuoteStatus.DRAFT) {
      throw new BadRequestException("Only draft quotes can be confirmed.");
    }
    const result = await this.prisma.$transaction(async (tx) => {
      let vehicleBefore = null;
      let vehicleAfter = null;

      if (before.vehicleId) {
        vehicleBefore = await tx.vehicle.findUnique({ where: { id: before.vehicleId } });
        if (!vehicleBefore || vehicleBefore.deletedAt || vehicleBefore.status !== VehicleStatus.AVAILABLE) {
          throw new BadRequestException("所选车辆已不可租用，请重新选择车辆");
        }
        vehicleAfter = await tx.vehicle.update({
          data: { status: VehicleStatus.RESERVED, updatedBy: user.id },
          where: { id: before.vehicleId }
        });
      }

      const quote = await tx.subscriptionQuote.update({
        data: {
          confirmedAt: new Date(),
          confirmedBy: user.id,
          status: QuoteStatus.CONFIRMED,
          updatedBy: user.id
        },
        include: quoteInclude,
        where: { id }
      });

      return { quote, vehicleAfter, vehicleBefore };
    });
    const quote = result.quote;
    await this.writeAudit(AuditAction.APPROVE, "subscription_quote", id, toQuoteView(before), toQuoteView(quote), user, context);
    if (result.vehicleBefore && result.vehicleAfter) {
      await this.auditService.write({
        action: AuditAction.UPDATE,
        after: toJsonValue(result.vehicleAfter),
        before: toJsonValue(result.vehicleBefore),
        entityId: result.vehicleAfter.id,
        entityType: "vehicle",
        ipAddress: context.ipAddress,
        module: "vehicle",
        operatorId: user.id,
        userAgent: context.userAgent
      });
    }
    return toQuoteView(quote);
  }

  async cancelQuote(id: string, user: RequestUser, context: RequestContext) {
    const before = await this.findQuoteOrThrow(id);
    ensureCanAccessQuote(before, user);
    if (before.status === QuoteStatus.CONFIRMED) {
      throw new BadRequestException("Confirmed quotes cannot be cancelled in this phase.");
    }
    const quote = await this.prisma.subscriptionQuote.update({
      data: { cancelledAt: new Date(), status: QuoteStatus.CANCELLED, updatedBy: user.id },
      include: quoteInclude,
      where: { id }
    });
    await this.writeAudit(AuditAction.REJECT, "subscription_quote", id, toQuoteView(before), toQuoteView(quote), user, context);
    return toQuoteView(quote);
  }

  private async findProductOrThrow(id: string) {
    const product = await this.prisma.product.findUnique({ include: productInclude, where: { id } });
    if (!product || product.deletedAt) {
      throw new NotFoundException("Product not found.");
    }
    return product;
  }

  private async findVersionOrThrow(id: string) {
    const version = await this.prisma.productVersion.findUnique({
      include: versionInclude,
      where: { id }
    });
    if (!version || version.deletedAt) {
      throw new NotFoundException("Product version not found.");
    }
    return version;
  }

  private async findPriceRuleOrThrow(id: string) {
    const rule = await this.prisma.productPriceRule.findUnique({
      include: priceRuleInclude,
      where: { id }
    });
    if (!rule || rule.deletedAt) {
      throw new NotFoundException("Product price rule not found.");
    }
    return rule;
  }

  private async findVehiclePackageOrThrow(id: string) {
    const row = await this.prisma.vehiclePackage.findUnique({ include: vehiclePackageInclude, where: { id } });
    if (!row || row.deletedAt) {
      throw new NotFoundException("Vehicle package not found.");
    }
    return row;
  }

  private async findMileagePackageOrThrow(id: string) {
    const row = await this.prisma.mileagePackage.findUnique({ include: packageInclude, where: { id } });
    if (!row || row.deletedAt) {
      throw new NotFoundException("Mileage package not found.");
    }
    return row;
  }

  private async findEnergyPackageOrThrow(id: string) {
    const row = await this.prisma.energyPackage.findUnique({ include: packageInclude, where: { id } });
    if (!row || row.deletedAt) {
      throw new NotFoundException("Energy package not found.");
    }
    return row;
  }

  private async findBenefitPackageOrThrow(id: string) {
    const row = await this.prisma.benefitPackage.findUnique({ include: packageInclude, where: { id } });
    if (!row || row.deletedAt) {
      throw new NotFoundException("Benefit package not found.");
    }
    return row;
  }

  private async findAvailableVehicleForQuote(id: string) {
    const vehicle = await this.prisma.vehicle.findUnique({
      include: {
        modelDefinition: {
          select: { displayName: true, id: true, modelCode: true }
        }
      },
      where: { id }
    });
    if (!vehicle || vehicle.deletedAt) {
      throw new NotFoundException("车辆不存在");
    }
    if (vehicle.status !== VehicleStatus.AVAILABLE) {
      throw new BadRequestException("所选车辆当前不可租用");
    }
    if (
      vehicle.salePriceStatus !== SalePriceStatus.EFFECTIVE ||
      !vehicle.currentSalePriceAmount ||
      vehicle.currentSalePriceAmount <= 0n
    ) {
      throw new BadRequestException("当前车辆销售价未初始化，无法生成报价");
    }
    return vehicle;
  }

  private async findQuoteOrThrow(id: string) {
    const quote = await this.prisma.subscriptionQuote.findUnique({
      include: quoteInclude,
      where: { id }
    });
    if (!quote || quote.deletedAt) {
      throw new NotFoundException("Quote not found.");
    }
    return quote;
  }

  private async findSubscriptionPlanOrThrow(id: string) {
    const plan = await this.prisma.subscriptionPlan.findUnique({
      include: subscriptionPlanInclude,
      where: { id }
    });
    if (!plan || plan.deletedAt) {
      throw new NotFoundException("Subscription plan not found.");
    }
    return plan;
  }

  private async resolveSubscriptionPlanPackages(input: {
    benefitPackageId?: string | null;
    energyPackageId: string;
    mileagePackageId: string;
    productId: string;
    productVersionId: string;
    vehiclePackageId: string;
  }) {
    const [product, productVersion, vehiclePackage, mileagePackage, energyPackage, benefitPackage] = await Promise.all([
      this.prisma.product.findUnique({ where: { id: input.productId } }),
      this.prisma.productVersion.findUnique({ where: { id: input.productVersionId } }),
      this.prisma.vehiclePackage.findUnique({ include: vehiclePackageInclude, where: { id: input.vehiclePackageId } }),
      this.prisma.mileagePackage.findUnique({ include: packageInclude, where: { id: input.mileagePackageId } }),
      this.prisma.energyPackage.findUnique({ include: packageInclude, where: { id: input.energyPackageId } }),
      input.benefitPackageId
        ? this.prisma.benefitPackage.findUnique({ include: packageInclude, where: { id: input.benefitPackageId } })
        : Promise.resolve(null)
    ]);

    if (!product || product.deletedAt || !productVersion || productVersion.deletedAt) {
      throw new NotFoundException("Product or product version not found.");
    }
    ensureSubscriptionProductType(product.productType);
    if (
      !vehiclePackage ||
      vehiclePackage.deletedAt ||
      !mileagePackage ||
      mileagePackage.deletedAt ||
      !energyPackage ||
      energyPackage.deletedAt ||
      (input.benefitPackageId && (!benefitPackage || benefitPackage.deletedAt))
    ) {
      throw new BadRequestException("所选订阅组件不存在或已删除。");
    }
    if (
      productVersion.productId !== product.id ||
      [vehiclePackage, mileagePackage, energyPackage, benefitPackage].some(
        (item) => item && (item.productId !== product.id || item.productVersionId !== productVersion.id)
      )
    ) {
      throw new BadRequestException("所选订阅组件不属于同一个产品版本。");
    }

    return {
      benefitPackage,
      energyPackage,
      mileagePackage,
      product,
      productVersion,
      vehiclePackage
    };
  }

  private async findActivePriceRule(productVersionId: string, modelDefinitionId: string) {
    trackVehicleModelUsage({
      decisionPath: "MODEL_DEFINITION_ID",
      modelDefinitionId,
      module: "product",
      operation: "productPriceRule.activeLookup",
      riskLevel: "LOW",
      usageKind: "BUSINESS_DECISION"
    });

    const version = await this.findVersionOrThrow(productVersionId);
    ensureSubscriptionProductType(version.product.productType);
    if (version.product.status !== ProductStatus.ACTIVE || version.status !== ProductVersionStatus.ACTIVE) {
      throw new BadRequestException("An active product and product version are required.");
    }
    const rule = await this.prisma.productPriceRule.findFirst({
      include: priceRuleInclude,
      where: {
        deletedAt: null,
        modelDefinitionId,
        productVersionId,
        status: RecordStatus.ACTIVE
      }
    });
    if (!rule) {
      throw new BadRequestException(`No active price rule found for modelDefinitionId ${modelDefinitionId}.`);
    }
    return rule;
  }

  private async ensurePackageVersion(productId: string, productVersionId: string) {
    const version = await this.findVersionOrThrow(productVersionId);
    ensureSubscriptionProductType(version.product.productType);
    if (version.productId !== productId) {
      throw new BadRequestException("组件归属产品必须与产品版本一致");
    }
    if (version.product.deletedAt || version.product.status === ProductStatus.INACTIVE) {
      throw new BadRequestException("该产品状态不允许配置订阅组件");
    }
    return version;
  }

  private nextPackageNo(
    table: "benefitPackage" | "energyPackage" | "mileagePackage" | "vehiclePackage",
    prefix: string
  ) {
    void table;
    return createBusinessNo(prefix);
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
      module: entityType.startsWith("subscription_quote") ? "quote" : "product",
      operatorId: user.id,
      userAgent: context.userAgent
    });
  }
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

function optionalBigInt(value?: number | null) {
  return value === undefined || value === null ? null : BigInt(value);
}

function requirePositiveInteger(value: number | undefined, message: string): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    throw new BadRequestException(message);
  }
  return value;
}

function ensureNoLegacySubscriptionPlanQuoteFields(dto: CreateQuoteDto) {
  if (
    dto.vehiclePurchasePriceAmount !== undefined ||
    dto.monthlyFeeAmount !== undefined ||
    dto.vehiclePackageId !== undefined ||
    dto.mileagePackageId !== undefined ||
    dto.energyPackageId !== undefined ||
    dto.benefitPackageId !== undefined
  ) {
    throw new BadRequestException("订阅套餐报价不再接收车辆采购价、套餐月费或底层组件字段");
  }
}

function calculateVehicleBaseFeeForSubscriptionPlan(
  plan: SubscriptionPlanWithDetails,
  vehicleSalePriceAmount: bigint,
  requestedVehicleBaseFeeAmount?: number
) {
  const vehiclePackageRate = Number(plan.vehiclePackage.monthlyFeeRate);
  if (!Number.isFinite(vehiclePackageRate) || vehiclePackageRate <= 0) {
    throw new BadRequestException("车型包车辆基础费上限率必须大于 0");
  }

  const vehicleBaseFeeCapAmount = BigInt(Math.floor(Number(vehicleSalePriceAmount) * vehiclePackageRate));
  let fixedRate: number | null = null;
  let vehicleBaseFeeAmount: bigint;

  switch (plan.monthlyFeeMode) {
    case MonthlyFeeMode.FIXED_AMOUNT:
      if (!plan.baseMonthlyFeeAmount || plan.baseMonthlyFeeAmount <= 0n) {
        throw new BadRequestException("固定金额套餐必须配置车辆基础月费");
      }
      vehicleBaseFeeAmount = plan.baseMonthlyFeeAmount;
      break;
    case MonthlyFeeMode.RATE_FORMULA:
      fixedRate = Number(plan.monthlyFeeRate ?? plan.vehiclePackage.monthlyFeeRate);
      if (!Number.isFinite(fixedRate) || fixedRate <= 0) {
        throw new BadRequestException("固定费率套餐的车辆基础月费费率必须大于 0");
      }
      if (fixedRate > vehiclePackageRate) {
        throw new BadRequestException("固定费率套餐的车辆基础月费费率不能高于车型包上限率");
      }
      vehicleBaseFeeAmount = BigInt(Math.floor(Number(vehicleSalePriceAmount) * fixedRate));
      break;
    case MonthlyFeeMode.MANUAL_QUOTE:
      vehicleBaseFeeAmount = BigInt(
        requirePositiveInteger(requestedVehicleBaseFeeAmount, "车辆基础费报价必须大于 0")
      );
      break;
    default:
      throw new BadRequestException("不支持的车辆基础月费模式");
  }

  assertVehicleBaseFeeAmountWithinCap(vehicleBaseFeeAmount, vehicleBaseFeeCapAmount);

  return {
    fixedRate,
    vehicleBaseFeeAmount,
    vehicleBaseFeeCapAmount,
    vehicleBaseFeeModeLabel: VEHICLE_BASE_FEE_MODE_LABELS[plan.monthlyFeeMode]
  };
}

function assertVehicleBaseFeeAmountWithinCap(vehicleBaseFeeAmount: bigint, capAmount: bigint) {
  if (vehicleBaseFeeAmount > capAmount) {
    throw new BadRequestException("车辆基础费超过车型包系数允许上限");
  }
}

function toJsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value, (_, item) => (typeof item === "bigint" ? Number(item) : item))) as Prisma.InputJsonValue;
}

function ensureProductAllowsVersion(product: Pick<ProductWithDetails, "productType" | "status">) {
  ensureSubscriptionProductType(product.productType);
  if (product.status === ProductStatus.INACTIVE) {
    throw new BadRequestException("该产品已停用，不能创建版本");
  }
}

export function ensureValidPeriod(minPeriodMonths: number, maxPeriodMonths: number) {
  if (maxPeriodMonths < minPeriodMonths) {
    throw new BadRequestException("maxPeriodMonths must be greater than minPeriodMonths.");
  }
}

export function ensurePeriodInRange(
  periodMonths: number,
  rule: { maxPeriodMonths: number; minPeriodMonths: number }
) {
  if (periodMonths < rule.minPeriodMonths || periodMonths > rule.maxPeriodMonths) {
    throw new BadRequestException("订阅周期不在套餐允许范围内");
  }
}

function ensureSubscriptionPlanCanActivate(plan: {
  benefitPackage?: { deletedAt: Date | null; productId: string; productVersionId: string; status: RecordStatus } | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  energyPackage: { deletedAt: Date | null; productId: string; productVersionId: string; status: RecordStatus };
  mileagePackage: { deletedAt: Date | null; productId: string; productVersionId: string; status: RecordStatus };
  product: { deletedAt: Date | null; id: string; productType: ProductType; status: ProductStatus };
  productVersion: { deletedAt: Date | null; id: string; productId: string };
  vehiclePackage: { deletedAt: Date | null; productId: string; productVersionId: string; status: RecordStatus };
}) {
  ensureSubscriptionProductType(plan.product.productType);
  ensureValidDateRange(plan.effectiveFrom, plan.effectiveTo);
  if (plan.product.deletedAt || plan.product.status === ProductStatus.INACTIVE || plan.productVersion.deletedAt) {
    throw new BadRequestException("产品或产品版本状态不允许启用订阅套餐。");
  }
  if (!isSubscriptionPlanComponentsActive(plan)) {
    throw new BadRequestException("请先启用套餐关联的车辆使用费、里程包、补能包和权益包。");
  }
}

function ensureSubscriptionPlanAvailableForQuote(plan: SubscriptionPlanWithDetails) {
  if (!isSubscriptionPlanCurrentlyAvailable(plan)) {
    throw new BadRequestException("所选订阅套餐不可报价，请确认套餐、产品版本和组件均已启用。");
  }
}

function isSubscriptionPlanCurrentlyAvailable(plan: SubscriptionPlanWithDetails) {
  return (
    plan.status === SubscriptionPlanStatus.ACTIVE &&
    plan.product.status === ProductStatus.ACTIVE &&
    plan.productVersion.status === ProductVersionStatus.ACTIVE &&
    isDateInRange(plan.effectiveFrom, plan.effectiveTo) &&
    isSubscriptionPlanComponentsActive(plan)
  );
}

function isSubscriptionPlanComponentsActive(plan: {
  benefitPackage?: { deletedAt: Date | null; productId: string; productVersionId: string; status: RecordStatus } | null;
  energyPackage: { deletedAt: Date | null; productId: string; productVersionId: string; status: RecordStatus };
  mileagePackage: { deletedAt: Date | null; productId: string; productVersionId: string; status: RecordStatus };
  product: { id: string };
  productVersion: { id: string; productId: string };
  vehiclePackage: { deletedAt: Date | null; productId: string; productVersionId: string; status: RecordStatus };
}) {
  const packages = [plan.vehiclePackage, plan.mileagePackage, plan.energyPackage, plan.benefitPackage].filter(Boolean);
  return (
    plan.productVersion.productId === plan.product.id &&
    packages.every(
      (item) =>
        item &&
        !item.deletedAt &&
        item.status === RecordStatus.ACTIVE &&
        item.productId === plan.product.id &&
        item.productVersionId === plan.productVersion.id
    )
  );
}

function isDateInRange(effectiveFrom: Date, effectiveTo: Date | null, today = new Date()) {
  const todayTime = dateOnlyTime(today);
  return dateOnlyTime(effectiveFrom) <= todayTime && (!effectiveTo || dateOnlyTime(effectiveTo) >= todayTime);
}

function dateOnlyTime(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function ensurePackagesSameVersion(
  productVersionId: string,
  ...packages: Array<{ productVersionId: string } | null>
) {
  if (packages.some((item) => item && item.productVersionId !== productVersionId)) {
    throw new BadRequestException("所选订阅组件不属于同一个产品版本，请重新选择");
  }
}

function ensurePurchasePriceInRange(
  vehiclePurchasePriceAmount: number,
  vehiclePackage: { maxPurchasePriceAmount: bigint | null; minPurchasePriceAmount: bigint | null }
) {
  if (
    vehiclePackage.minPurchasePriceAmount !== null &&
    vehiclePurchasePriceAmount < Number(vehiclePackage.minPurchasePriceAmount)
  ) {
    throw new BadRequestException("车辆采购价低于车型包适用区间");
  }
  if (
    vehiclePackage.maxPurchasePriceAmount !== null &&
    vehiclePurchasePriceAmount > Number(vehiclePackage.maxPurchasePriceAmount)
  ) {
    throw new BadRequestException("车辆采购价高于车型包适用区间");
  }
}

export function assertMonthlyFeeWithinCap(
  monthlyFeeAmount: number,
  vehiclePurchasePriceAmount: number,
  monthlyFeeRate: Prisma.Decimal | number
) {
  const cap = Math.floor(vehiclePurchasePriceAmount * Number(monthlyFeeRate));
  if (monthlyFeeAmount > cap) {
    throw new BadRequestException("monthlyFeeAmount exceeds product price rule cap.");
  }
}

function canViewAllQuotes(user: RequestUser) {
  return user.roles.some((role) => ["ADMIN", "GM", "OP", "RC", "FI", "AS"].includes(role));
}

function ensureCanAccessQuote(quote: QuoteWithDetails, user: RequestUser) {
  if (!canViewAllQuotes(user) && quote.application.salesUserId !== user.id) {
    throw new ForbiddenException("Quote is outside your scope.");
  }
}

export function ensureSubscriptionProductType(productType?: ProductType | null) {
  if (!productType) {
    return CURRENT_PRODUCT_TYPE;
  }
  if (productType !== CURRENT_PRODUCT_TYPE) {
    throw new BadRequestException(RENT_TO_OWN_NOT_OPEN_MESSAGE);
  }
  return productType;
}

export function ensureNoRentToOwnQuoteFields(dto: CreateQuoteDto) {
  const blockedFields = [
    "buyoutAmount",
    "downPaymentAmount",
    "finalPaymentAmount",
    "installmentPlan",
    "rentToOwn",
    "titleTransferTerms"
  ] as const;
  const field = blockedFields.find((key) => dto[key] !== undefined);
  if (field) {
    throw new BadRequestException(`当前阶段暂未开放以租代购报价字段：${field}。`);
  }
}

type RecordSource = Record<string, unknown>;
type ProductViewSource = ProductWithDetails & {
  versions?: unknown;
};
type ProductVersionViewSource = RecordSource &
  Partial<ProductListVersion> &
  Partial<VersionWithDetails> & {
    benefitPackages?: unknown;
    energyPackages?: unknown;
    mileagePackages?: unknown;
    priceRules?: unknown;
    product?: unknown;
    vehiclePackages?: unknown;
  };

function isRecord(value: unknown): value is RecordSource {
  return typeof value === "object" && value !== null;
}

function isNonNullable<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function warnProductMapper(message: string, context: Record<string, unknown>) {
  productMapperLogger.warn(`${message} ${JSON.stringify(context)}`);
}

function toRecordArray(value: unknown, field: string, context: Record<string, unknown>) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    warnProductMapper("Expected relation array while building product view.", { ...context, field });
    return [];
  }
  return value.filter((item): item is RecordSource => {
    const valid = isRecord(item);
    if (!valid) {
      warnProductMapper("Skipped invalid relation item while building product view.", { ...context, field });
    }
    return valid;
  });
}

function toStringOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "object") {
    return null;
  }
  return String(value);
}

function toStringOrDash(value: unknown) {
  return toStringOrNull(value) ?? "-";
}

function toNumberOrZero(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return 0;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toNumberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toModelDefinitionSummary(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }

  return {
    customerDisplayName: toStringOrNull(value.customerDisplayName),
    displayName: toStringOrDash(value.displayName),
    enabled: Boolean(value.enabled),
    id: toStringOrDash(value.id),
    modelCode: toStringOrDash(value.modelCode)
  };
}

function formatDateOnly(value: unknown) {
  const date = toDateOrNull(value);
  return date ? date.toISOString().slice(0, 10) : "-";
}

function formatOptionalDateOnly(value: unknown) {
  const date = toDateOrNull(value);
  return date ? date.toISOString().slice(0, 10) : null;
}

function toDateOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function toProductView(product: ProductWithDetails) {
  const source = product as ProductViewSource;
  const versionSources = toRecordArray(source.versions, "product.versions", { productId: source.id });
  const versions = versionSources
    .map((version) => safeToVersionView(version, source.id))
    .filter(isNonNullable);
  const activeVersion = versions.find((version) => version.status === ProductVersionStatus.ACTIVE) ?? null;

  return {
    activeVersion,
    createdAt: product.createdAt,
    description: product.description,
    id: product.id,
    name: product.name,
    productNo: product.productNo,
    productType: product.productType,
    status: product.status,
    versions
  };
}

function safeToVersionView(version: ProductVersionViewSource | null | undefined, productId?: string | null) {
  try {
    return toVersionView(version, productId);
  } catch (error) {
    warnProductMapper("Skipped invalid product version while building product view.", {
      productId,
      versionId: isRecord(version) ? version.id : undefined,
      reason: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

function toVersionView(version?: ProductVersionViewSource | null, parentProductId?: string | null) {
  if (!version) {
    return null;
  }
  if (!isRecord(version)) {
    warnProductMapper("Skipped non-object product version while building product view.", { productId: parentProductId });
    return null;
  }

  const versionId = toStringOrNull(version.id);
  if (!versionId) {
    warnProductMapper("Skipped product version without id while building product view.", { productId: parentProductId });
    return null;
  }

  const product = isRecord(version.product) ? version.product : null;
  const productId = toStringOrNull(version.productId) ?? toStringOrNull(product?.id) ?? parentProductId ?? "-";

  return {
    approvedAt: version.approvedAt,
    approver: version.approver,
    effectiveFrom: formatDateOnly(version.effectiveFrom),
    effectiveTo: formatOptionalDateOnly(version.effectiveTo),
    id: versionId,
    benefitPackages: toRecordArray(version.benefitPackages, "version.benefitPackages", { productId, versionId }).map(toPackageView),
    energyPackages: toRecordArray(version.energyPackages, "version.energyPackages", { productId, versionId }).map(toPackageView),
    mileagePackages: toRecordArray(version.mileagePackages, "version.mileagePackages", { productId, versionId }).map(toPackageView),
    priceRules: toRecordArray(version.priceRules, "version.priceRules", { productId, versionId })
      .map(toPriceRuleView)
      .filter(isNonNullable),
    product: product
      ? {
          id: toStringOrNull(product.id) ?? productId,
          name: toStringOrDash(product.name),
          productNo: toStringOrDash(product.productNo),
          status: toStringOrDash(product.status)
        }
      : null,
    productId,
    status: toStringOrDash(version.status),
    vehiclePackages: toRecordArray(version.vehiclePackages, "version.vehiclePackages", { productId, versionId }).map(toPackageView),
    versionNo: toStringOrDash(version.versionNo)
  };
}

function toPriceRuleView(rule?: RecordSource | null) {
  if (!rule) {
    return null;
  }
  const modelDefinition = toModelDefinitionSummary(rule.modelDefinition);
  return {
    baseMileageKm: rule.baseMileageKm,
    energyLimitCount: rule.energyLimitCount,
    energyLimitKwh: rule.energyLimitKwh,
    id: toStringOrDash(rule.id),
    maxPeriodMonths: rule.maxPeriodMonths,
    minPeriodMonths: rule.minPeriodMonths,
    modelDefinition,
    modelDefinitionId: toStringOrNull(rule.modelDefinitionId),
    modelCode: modelDefinition?.modelCode ?? "-",
    modelDisplayName: modelDefinition?.displayName ?? "-",
    monthlyFeeRate: toNumberOrZero(rule.monthlyFeeRate),
    overMileageFeeAmount: toNumberOrZero(rule.overMileageFeeAmount),
    productVersionId: toStringOrDash(rule.productVersionId),
    status: toStringOrDash(rule.status)
  };
}

function toSubscriptionPlanView(plan: SubscriptionPlanWithDetails) {
  const source = plan as SubscriptionPlanWithDetails & RecordSource;
  const product = isRecord(source.product) ? source.product : null;
  const productVersion = isRecord(source.productVersion) ? source.productVersion : null;
  const productId = toStringOrDash(source.productId);
  const productVersionId = toStringOrDash(source.productVersionId);
  const monthlyFeeMode = toStringOrDash(source.monthlyFeeMode);

  return {
    baseMonthlyFeeAmount: toNumberOrNull(source.baseMonthlyFeeAmount),
    benefitPackage: source.benefitPackageId ? toPackageView(isRecord(source.benefitPackage) ? source.benefitPackage : null) : null,
    benefitPackageId: source.benefitPackageId ?? null,
    createdAt: source.createdAt,
    deletedAt: source.deletedAt,
    effectiveFrom: formatDateOnly(source.effectiveFrom),
    effectiveTo: formatOptionalDateOnly(source.effectiveTo),
    energyPackage: toPackageView(isRecord(source.energyPackage) ? source.energyPackage : null),
    energyPackageId: toStringOrDash(source.energyPackageId),
    id: toStringOrDash(source.id),
    maxPeriodMonths: source.maxPeriodMonths ?? 0,
    mileagePackage: toPackageView(isRecord(source.mileagePackage) ? source.mileagePackage : null),
    mileagePackageId: toStringOrDash(source.mileagePackageId),
    minPeriodMonths: source.minPeriodMonths ?? 0,
    monthlyFeeCapRate: toNumberOrNull(source.monthlyFeeCapRate),
    monthlyFeeMode,
    monthlyFeeModeLabel: VEHICLE_BASE_FEE_MODE_LABELS[monthlyFeeMode as MonthlyFeeMode] ?? monthlyFeeMode,
    monthlyFeeRate: toNumberOrZero(source.monthlyFeeRate),
    planName: toStringOrDash(source.planName),
    planNo: toStringOrDash(source.planNo),
    product: product
      ? {
          ...product,
          id: toStringOrDash(product.id),
          name: toStringOrDash(product.name),
          productNo: toStringOrDash(product.productNo),
          status: toStringOrDash(product.status)
        }
      : { id: productId, name: "-", productNo: "-", status: "-" },
    productId,
    productVersion: productVersion
      ? {
          id: toStringOrDash(productVersion.id),
          productId: toStringOrDash(productVersion.productId),
          status: toStringOrDash(productVersion.status),
          versionNo: toStringOrDash(productVersion.versionNo)
        }
      : { id: productVersionId, productId, status: "-", versionNo: "-" },
    productVersionId,
    remark: source.remark,
    status: toStringOrDash(source.status),
    updatedAt: source.updatedAt,
    vehiclePackage: toPackageView(isRecord(source.vehiclePackage) ? source.vehiclePackage : null),
    vehiclePackageId: toStringOrDash(source.vehiclePackageId)
  };
}

function toAvailableSubscriptionPlanView(plan: SubscriptionPlanWithDetails) {
  return {
    benefitDescription: plan.benefitPackage?.description ?? plan.benefitPackage?.packageName ?? null,
    benefitPackagePriceAmount: plan.benefitPackage ? Number(plan.benefitPackage.priceAmount) : 0,
    energyPackagePriceAmount: Number(plan.energyPackage.priceAmount),
    maxPeriodMonths: plan.maxPeriodMonths,
    baseMonthlyFeeAmount:
      plan.baseMonthlyFeeAmount === null ? null : Number(plan.baseMonthlyFeeAmount),
    maxPurchasePriceAmount:
      plan.vehiclePackage.maxPurchasePriceAmount === null ? null : Number(plan.vehiclePackage.maxPurchasePriceAmount),
    minPeriodMonths: plan.minPeriodMonths,
    minPurchasePriceAmount:
      plan.vehiclePackage.minPurchasePriceAmount === null ? null : Number(plan.vehiclePackage.minPurchasePriceAmount),
    monthlyEnergyCount: plan.energyPackage.monthlyEnergyCount,
    monthlyEnergyKwh: plan.energyPackage.monthlyEnergyKwh,
    monthlyFeeCapRate: Number(plan.vehiclePackage.monthlyFeeRate),
    monthlyFeeMode: plan.monthlyFeeMode,
    monthlyFeeModeLabel: VEHICLE_BASE_FEE_MODE_LABELS[plan.monthlyFeeMode],
    monthlyFeeRate: Number(plan.monthlyFeeRate),
    monthlyMileageKm: plan.mileagePackage.monthlyMileageKm,
    mileagePackagePriceAmount: Number(plan.mileagePackage.priceAmount),
    overMileageFeeAmount: Number(plan.mileagePackage.overMileageFeeAmount),
    planName: plan.planName,
    planNo: plan.planNo,
    productId: plan.productId,
    productName: plan.product.name,
    productVersionId: plan.productVersionId,
    subscriptionPlanId: plan.id,
    modelCode: plan.vehiclePackage.modelDefinition.modelCode,
    vehiclePackage: toPackageView(plan.vehiclePackage),
    versionNo: plan.productVersion.versionNo
  };
}

function toPackageView(row?: RecordSource | null) {
  if (!row) {
    warnProductMapper("Missing package relation while building product view.", {});
    return {
      id: "-",
      packageName: "-",
      packageNo: "-",
      product: null,
      productId: "-",
      productVersion: null,
      productVersionId: "-",
      remark: null,
      status: "-"
    };
  }
  const product = isRecord(row.product) ? row.product : null;
  const productVersion = isRecord(row.productVersion) ? row.productVersion : null;
  const result: Record<string, unknown> = {
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
    id: toStringOrDash(row.id),
    packageName: toStringOrDash(row.packageName),
    packageNo: toStringOrDash(row.packageNo),
    product: product
      ? {
          id: toStringOrDash(product.id),
          name: toStringOrDash(product.name),
          productNo: toStringOrDash(product.productNo),
          status: toStringOrDash(product.status)
        }
      : null,
    productId: toStringOrDash(row.productId),
    productVersion: productVersion
      ? {
          id: toStringOrDash(productVersion.id),
          productId: toStringOrDash(productVersion.productId),
          status: toStringOrDash(productVersion.status),
          versionNo: toStringOrDash(productVersion.versionNo)
        }
      : null,
    productVersionId: toStringOrDash(row.productVersionId),
    remark: row.remark,
    status: toStringOrDash(row.status),
    updatedAt: row.updatedAt
  };

  if ("modelDefinitionId" in row) {
    const modelDefinition = toModelDefinitionSummary(row.modelDefinition);
    result.brand = row.brand;
    result.configName = row.configName;
    result.maxPeriodMonths = row.maxPeriodMonths;
    result.maxPurchasePriceAmount = row.maxPurchasePriceAmount === null ? null : toNumberOrZero(row.maxPurchasePriceAmount);
    result.minPeriodMonths = row.minPeriodMonths;
    result.minPurchasePriceAmount = row.minPurchasePriceAmount === null ? null : toNumberOrZero(row.minPurchasePriceAmount);
    result.modelDefinition = modelDefinition;
    result.modelDefinitionId = toStringOrNull(row.modelDefinitionId);
    result.modelCode = modelDefinition?.modelCode ?? "-";
    result.modelDisplayName = modelDefinition?.displayName ?? "-";
    result.monthlyFeeRate = toNumberOrZero(row.monthlyFeeRate);
    result.series = row.series;
    result.vehicleModelName = row.vehicleModelName;
  }
  if ("monthlyMileageKm" in row) {
    result.monthlyMileageKm = row.monthlyMileageKm;
    result.overMileageFeeAmount = toNumberOrZero(row.overMileageFeeAmount);
    result.priceAmount = toNumberOrZero(row.priceAmount);
  }
  if ("monthlyEnergyKwh" in row) {
    result.monthlyEnergyCount = row.monthlyEnergyCount;
    result.monthlyEnergyKwh = row.monthlyEnergyKwh;
    result.priceAmount = toNumberOrZero(row.priceAmount);
    result.serviceDescription = row.serviceDescription;
    result.stationScope = row.stationScope;
  }
  if ("benefitType" in row) {
    result.benefitCount = row.benefitCount;
    result.benefitType = row.benefitType;
    result.description = row.description;
    result.priceAmount = toNumberOrZero(row.priceAmount);
  }

  return result;
}

function toQuoteView(quote: QuoteWithDetails) {
  const computedMonthlyFeeCapAmount = Math.floor(
    Number(quote.vehiclePurchasePriceAmount) * Number(quote.monthlyFeeRate)
  );
  const monthlyFeeCapAmount =
    quote.vehicleBaseFeeCapAmount !== null
      ? Number(quote.vehicleBaseFeeCapAmount)
      : quote.monthlyFeeCapAmount === null
        ? computedMonthlyFeeCapAmount
        : Number(quote.monthlyFeeCapAmount);
  return {
    application: quote.application,
    applicationId: quote.applicationId,
    cancelledAt: quote.cancelledAt,
    confirmedAt: quote.confirmedAt,
    confirmedBy: quote.confirmedBy,
    confirmer: quote.confirmer,
    createdAt: quote.createdAt,
    customer: quote.customer,
    customerId: quote.customerId,
    customerSelectedSnapshot: quote.customerSelectedSnapshot,
    depositAmount: Number(quote.depositAmount),
    depositRuleSnapshot: quote.depositRuleSnapshot,
    benefitPackagePriceAmount:
      quote.benefitPackagePriceAmount === null ? null : Number(quote.benefitPackagePriceAmount),
    energyPackagePriceAmount:
      quote.energyPackagePriceAmount === null ? null : Number(quote.energyPackagePriceAmount),
    energyLimitCount: quote.energyLimitCount,
    energyLimitKwh: quote.energyLimitKwh,
    expiredAt: quote.expiredAt,
    id: quote.id,
    mileagePackagePriceAmount:
      quote.mileagePackagePriceAmount === null ? null : Number(quote.mileagePackagePriceAmount),
    mileageLimitKm: quote.mileageLimitKm,
    monthlyFeeAmount: Number(quote.monthlyFeeAmount),
    monthlyFeeCapAmount,
    monthlyFeeRate: Number(quote.monthlyFeeRate),
    modelCodeSnapshot: quote.modelCodeSnapshot,
    modelDefinitionIdSnapshot: quote.modelDefinitionIdSnapshot,
    modelDisplayName: quote.modelDisplayNameSnapshot,
    modelDisplayNameSnapshot: quote.modelDisplayNameSnapshot,
    modelDisplaySource: "SNAPSHOT",
    order: quote.order && !quote.order.deletedAt
      ? {
          id: quote.order.id,
          orderNo: quote.order.orderNo,
          orderStatus: quote.order.orderStatus
        }
      : null,
    overMileageFeeAmount: Number(quote.overMileageFeeAmount),
    packageSnapshot: quote.packageSnapshot,
    periodMonths: quote.periodMonths,
    productId: quote.productId,
    productVersion: {
      id: quote.productVersion.id,
      product: quote.productVersion.product,
      versionNo: quote.productVersion.versionNo
    },
    productVersionId: quote.productVersionId,
    quoteNo: quote.quoteNo,
    riskResultId: quote.riskResultId,
    status: quote.status,
    subscriptionPlan: quote.subscriptionPlan ? toSubscriptionPlanView(quote.subscriptionPlan) : null,
    subscriptionPlanId: quote.subscriptionPlanId,
    benefitPackage: quote.benefitPackage ? toPackageView(quote.benefitPackage) : null,
    benefitPackageId: quote.benefitPackageId,
    energyPackage: quote.energyPackage ? toPackageView(quote.energyPackage) : null,
    energyPackageId: quote.energyPackageId,
    mileagePackage: quote.mileagePackage ? toPackageView(quote.mileagePackage) : null,
    mileagePackageId: quote.mileagePackageId,
    vehiclePackage: quote.vehiclePackage ? toPackageView(quote.vehiclePackage) : null,
    vehiclePackageId: quote.vehiclePackageId,
    vehicle: quote.vehicle ? toQuoteVehicleView(quote.vehicle) : null,
    vehicleBaseFeeAmount: quote.vehicleBaseFeeAmount === null ? null : Number(quote.vehicleBaseFeeAmount),
    vehicleBaseFeeCapAmount:
      quote.vehicleBaseFeeCapAmount === null ? null : Number(quote.vehicleBaseFeeCapAmount),
    vehicleId: quote.vehicleId,
    vehiclePurchasePriceAmount: Number(quote.vehiclePurchasePriceAmount),
    vehicleSalePriceAmount:
      quote.vehicleSalePriceAmount === null ? null : Number(quote.vehicleSalePriceAmount),
    vehicleSnapshot: quote.vehicleSnapshot
  };
}

function toQuoteVehicleView(vehicle: NonNullable<QuoteWithDetails["vehicle"]>) {
  return {
    assetLocation: vehicle.assetLocation,
    batteryCapacityKwh: vehicle.batteryCapacityKwh?.toNumber() ?? null,
    batteryUsageType: vehicle.batteryUsageType,
    batteryUsageTypeLabel: VEHICLE_BATTERY_USAGE_TYPE_LABELS[vehicle.batteryUsageType],
    brand: vehicle.brand,
    currentMileageKm: vehicle.currentMileageKm,
    currentSalePriceAmount:
      vehicle.currentSalePriceAmount === null ? null : Number(vehicle.currentSalePriceAmount),
    id: vehicle.id,
    plateNo: vehicle.plateNo,
    series: vehicle.series,
    status: vehicle.status,
    modelDefinitionId: vehicle.modelDefinitionId,
    modelCode: vehicle.modelDefinition.modelCode,
    modelDisplayName: vehicle.modelDefinition.displayName,
    vehicleNo: vehicle.vehicleNo,
    vin: vehicle.vin
  };
}
