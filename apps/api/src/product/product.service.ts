import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import {
  ApplicationStatus,
  AuditAction,
  Prisma,
  ProductStatus,
  ProductType,
  ProductVersionStatus,
  QuoteStatus,
  RecordStatus,
  RiskResultDecision
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import {
  CreatePriceRuleDto,
  CreateBenefitPackageDto,
  CreateEnergyPackageDto,
  CreateMileagePackageDto,
  CreateProductDto,
  CreateProductVersionDto,
  CreateQuoteDto,
  CreateVehiclePackageDto,
  UpdateBenefitPackageDto,
  UpdateEnergyPackageDto,
  UpdateMileagePackageDto,
  UpdatePriceRuleDto,
  UpdateProductDto,
  UpdateProductVersionDto,
  UpdateVehiclePackageDto,
  UpdateQuoteDto
} from "./dto/product.dto";

const packageInclude = {
  product: { select: { id: true, name: true, productNo: true, status: true } },
  productVersion: { select: { id: true, productId: true, status: true, versionNo: true } }
} satisfies Prisma.VehiclePackageInclude;

const productInclude = {
  versions: {
    include: {
      approver: { select: { id: true, name: true, username: true } },
      benefitPackages: { include: packageInclude, where: { deletedAt: null } },
      energyPackages: { include: packageInclude, where: { deletedAt: null } },
      mileagePackages: { include: packageInclude, where: { deletedAt: null } },
      priceRules: { where: { deletedAt: null } },
      vehiclePackages: { include: packageInclude, where: { deletedAt: null } }
    },
    orderBy: { createdAt: "desc" as const },
    where: { deletedAt: null }
  }
} satisfies Prisma.ProductInclude;

const versionInclude = {
  approver: { select: { id: true, name: true, username: true } },
  priceRules: {
    orderBy: { vehicleModel: "asc" as const },
    where: { deletedAt: null }
  },
  benefitPackages: { include: packageInclude, where: { deletedAt: null } },
  energyPackages: { include: packageInclude, where: { deletedAt: null } },
  mileagePackages: { include: packageInclude, where: { deletedAt: null } },
  vehiclePackages: { include: packageInclude, where: { deletedAt: null } },
  product: true
} satisfies Prisma.ProductVersionInclude;

const priceRuleInclude = {
  productVersion: {
    include: { product: true }
  }
} satisfies Prisma.ProductPriceRuleInclude;

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
  vehiclePackage: { include: packageInclude }
} satisfies Prisma.SubscriptionQuoteInclude;

type ProductWithDetails = Prisma.ProductGetPayload<{ include: typeof productInclude }>;
type VersionWithDetails = Prisma.ProductVersionGetPayload<{ include: typeof versionInclude }>;
type PriceRuleWithDetails = Prisma.ProductPriceRuleGetPayload<{ include: typeof priceRuleInclude }>;
type QuoteWithDetails = Prisma.SubscriptionQuoteGetPayload<{ include: typeof quoteInclude }>;
type ProductListVersion = ProductWithDetails["versions"][number];
type Tx = Prisma.TransactionClient;
const CURRENT_PRODUCT_TYPE = ProductType.SUBSCRIPTION;
const RENT_TO_OWN_NOT_OPEN_MESSAGE = "当前阶段暂未开放以租代购产品线。";

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
    const product = await this.prisma.product.create({
      data: {
        createdBy: user.id,
        description: dto.description,
        name: dto.name,
        productNo: await generateBusinessNo(this.prisma, "product", "PRD"),
        productType,
        status: dto.status ?? ProductStatus.DRAFT,
        updatedBy: user.id
      },
      include: productInclude
    });

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

    return versions.map(toVersionView);
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
    if (before.priceRules.length === 0) {
      throw new BadRequestException("At least one price rule is required before activation.");
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
      orderBy: { vehicleModel: "asc" },
      where: { deletedAt: null, productVersionId: versionId }
    });
    return rules.map(toPriceRuleView);
  }

  async createPriceRule(
    versionId: string,
    dto: CreatePriceRuleDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const version = await this.findVersionOrThrow(versionId);
    ensureValidPeriod(dto.minPeriodMonths, dto.maxPeriodMonths);

    const rule = await this.prisma.productPriceRule.create({
      data: {
        baseMileageKm: dto.baseMileageKm,
        createdBy: user.id,
        energyLimitCount: dto.energyLimitCount,
        energyLimitKwh: dto.energyLimitKwh,
        maxPeriodMonths: dto.maxPeriodMonths,
        minPeriodMonths: dto.minPeriodMonths,
        monthlyFeeRate: new Prisma.Decimal(dto.monthlyFeeRate ?? 0.035),
        overMileageFeeAmount: BigInt(dto.overMileageFeeAmount),
        productVersionId: version.id,
        status: dto.status ?? RecordStatus.ACTIVE,
        updatedBy: user.id,
        vehicleModel: dto.vehicleModel
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

    const rule = await this.prisma.productPriceRule.update({
      data: {
        baseMileageKm: dto.baseMileageKm,
        energyLimitCount: dto.energyLimitCount,
        energyLimitKwh: dto.energyLimitKwh,
        maxPeriodMonths: dto.maxPeriodMonths,
        minPeriodMonths: dto.minPeriodMonths,
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
        include: packageInclude,
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
      include: packageInclude,
      orderBy: { createdAt: "desc" },
      where: { deletedAt: null }
    });
    return rows.map(toPackageView);
  }

  async createVehiclePackage(dto: CreateVehiclePackageDto, user: RequestUser, context: RequestContext) {
    const version = await this.ensurePackageVersion(dto.productId, dto.productVersionId);
    ensureValidPeriod(dto.minPeriodMonths, dto.maxPeriodMonths);
    const row = await this.prisma.vehiclePackage.create({
      data: {
        brand: dto.brand,
        configName: dto.configName,
        createdBy: user.id,
        maxPeriodMonths: dto.maxPeriodMonths,
        maxPurchasePriceAmount: optionalBigInt(dto.maxPurchasePriceAmount),
        minPeriodMonths: dto.minPeriodMonths,
        minPurchasePriceAmount: optionalBigInt(dto.minPurchasePriceAmount),
        monthlyFeeRate: new Prisma.Decimal(dto.monthlyFeeRate ?? 0.035),
        packageName: dto.packageName,
        packageNo: await this.nextPackageNo("vehiclePackage", "VPK"),
        productId: version.productId,
        productVersionId: version.id,
        remark: dto.remark,
        series: dto.series,
        status: dto.status ?? RecordStatus.ACTIVE,
        updatedBy: user.id,
        vehicleModel: dto.vehicleModel,
        vehicleModelName: dto.vehicleModelName
      },
      include: packageInclude
    });
    await this.writeAudit(AuditAction.CREATE, "vehicle_package", row.id, undefined, toPackageView(row), user, context);
    return toPackageView(row);
  }

  async updateVehiclePackage(id: string, dto: UpdateVehiclePackageDto, user: RequestUser, context: RequestContext) {
    const before = await this.findVehiclePackageOrThrow(id);
    ensureValidPeriod(dto.minPeriodMonths ?? before.minPeriodMonths, dto.maxPeriodMonths ?? before.maxPeriodMonths);
    const row = await this.prisma.vehiclePackage.update({
      data: {
        brand: dto.brand,
        configName: dto.configName,
        maxPeriodMonths: dto.maxPeriodMonths,
        maxPurchasePriceAmount: dto.maxPurchasePriceAmount === undefined ? undefined : optionalBigInt(dto.maxPurchasePriceAmount),
        minPeriodMonths: dto.minPeriodMonths,
        minPurchasePriceAmount: dto.minPurchasePriceAmount === undefined ? undefined : optionalBigInt(dto.minPurchasePriceAmount),
        monthlyFeeRate: dto.monthlyFeeRate === undefined ? undefined : new Prisma.Decimal(dto.monthlyFeeRate),
        packageName: dto.packageName,
        remark: dto.remark,
        series: dto.series,
        updatedBy: user.id,
        vehicleModelName: dto.vehicleModelName
      },
      include: packageInclude,
      where: { id }
    });
    await this.writeAudit(AuditAction.UPDATE, "vehicle_package", id, toPackageView(before), toPackageView(row), user, context);
    return toPackageView(row);
  }

  async setVehiclePackageStatus(id: string, status: RecordStatus, user: RequestUser, context: RequestContext) {
    const before = await this.findVehiclePackageOrThrow(id);
    const row = await this.prisma.vehiclePackage.update({ data: { status, updatedBy: user.id }, include: packageInclude, where: { id } });
    await this.writeAudit(AuditAction.UPDATE, "vehicle_package", id, toPackageView(before), toPackageView(row), user, context);
    return toPackageView(row);
  }

  async deleteVehiclePackage(id: string, user: RequestUser, context: RequestContext) {
    const before = await this.findVehiclePackageOrThrow(id);
    const row = await this.prisma.vehiclePackage.update({ data: { deletedAt: new Date(), status: RecordStatus.INACTIVE, updatedBy: user.id }, include: packageInclude, where: { id } });
    await this.writeAudit(AuditAction.DELETE, "vehicle_package", id, toPackageView(before), toPackageView(row), user, context);
    return toPackageView(row);
  }

  async listMileagePackages() {
    const rows = await this.prisma.mileagePackage.findMany({ include: packageInclude, orderBy: { createdAt: "desc" }, where: { deletedAt: null } });
    return rows.map(toPackageView);
  }

  async createMileagePackage(dto: CreateMileagePackageDto, user: RequestUser, context: RequestContext) {
    const version = await this.ensurePackageVersion(dto.productId, dto.productVersionId);
    const row = await this.prisma.mileagePackage.create({
      data: {
        createdBy: user.id,
        monthlyMileageKm: dto.monthlyMileageKm,
        overMileageFeeAmount: BigInt(dto.overMileageFeeAmount),
        packageName: dto.packageName,
        packageNo: await this.nextPackageNo("mileagePackage", "MPK"),
        priceAmount: BigInt(dto.priceAmount ?? 0),
        productId: version.productId,
        productVersionId: version.id,
        remark: dto.remark,
        status: dto.status ?? RecordStatus.ACTIVE,
        updatedBy: user.id
      },
      include: packageInclude
    });
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
    const row = await this.prisma.energyPackage.create({
      data: {
        createdBy: user.id,
        monthlyEnergyCount: dto.monthlyEnergyCount,
        monthlyEnergyKwh: dto.monthlyEnergyKwh,
        packageName: dto.packageName,
        packageNo: await this.nextPackageNo("energyPackage", "EPK"),
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
    });
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
    const row = await this.prisma.benefitPackage.create({
      data: {
        benefitCount: dto.benefitCount,
        benefitType: dto.benefitType,
        createdBy: user.id,
        description: dto.description,
        packageName: dto.packageName,
        packageNo: await this.nextPackageNo("benefitPackage", "BPK"),
        priceAmount: BigInt(dto.priceAmount ?? 0),
        productId: version.productId,
        productVersionId: version.id,
        remark: dto.remark,
        status: dto.status ?? RecordStatus.ACTIVE,
        updatedBy: user.id
      },
      include: packageInclude
    });
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

    const componentQuote = Boolean(dto.vehiclePackageId || dto.mileagePackageId || dto.energyPackageId || dto.benefitPackageId);
    let quoteData:
      | {
          benefitPackageId?: string | null;
          energyLimitCount?: number | null;
          energyLimitKwh?: number | null;
          energyPackageId?: string;
          mileageLimitKm: number;
          mileagePackageId?: string;
          monthlyFeeRate: Prisma.Decimal;
          overMileageFeeAmount: bigint;
          packageSnapshot?: Prisma.InputJsonValue;
          productId: string;
          vehicleModel: CreateQuoteDto["vehicleModel"];
          vehiclePackageId?: string;
        }
      | null = null;

    if (componentQuote) {
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
        this.prisma.vehiclePackage.findFirst({ include: packageInclude, where: { deletedAt: null, id: dto.vehiclePackageId, status: RecordStatus.ACTIVE } }),
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
      assertMonthlyFeeWithinCap(dto.monthlyFeeAmount, dto.vehiclePurchasePriceAmount, vehiclePackage.monthlyFeeRate);
      ensurePurchasePriceInRange(dto.vehiclePurchasePriceAmount, vehiclePackage);
      quoteData = {
        benefitPackageId: benefitPackage?.id ?? null,
        energyLimitCount: energyPackage.monthlyEnergyCount,
        energyLimitKwh: energyPackage.monthlyEnergyKwh,
        energyPackageId: energyPackage.id,
        mileageLimitKm: mileagePackage.monthlyMileageKm,
        mileagePackageId: mileagePackage.id,
        monthlyFeeRate: vehiclePackage.monthlyFeeRate,
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
          monthlyFeeCapAmount: Math.floor(dto.vehiclePurchasePriceAmount * Number(vehiclePackage.monthlyFeeRate)),
          vehiclePackage: toPackageView(vehiclePackage)
        }),
        productId: version.productId,
        vehicleModel: vehiclePackage.vehicleModel,
        vehiclePackageId: vehiclePackage.id
      };
    } else {
      const priceRule = await this.findActivePriceRule(dto.productVersionId, dto.vehicleModel);
      ensurePeriodInRange(dto.periodMonths, priceRule);
      assertMonthlyFeeWithinCap(dto.monthlyFeeAmount, dto.vehiclePurchasePriceAmount, priceRule.monthlyFeeRate);
      quoteData = {
        energyLimitCount: dto.energyLimitCount ?? priceRule.energyLimitCount,
        energyLimitKwh: dto.energyLimitKwh ?? priceRule.energyLimitKwh,
        mileageLimitKm: dto.mileageLimitKm ?? priceRule.baseMileageKm,
        monthlyFeeRate: priceRule.monthlyFeeRate,
        overMileageFeeAmount: priceRule.overMileageFeeAmount,
        productId: priceRule.productVersion.productId,
        vehicleModel: dto.vehicleModel
      };
    }

    const quote = await this.prisma.subscriptionQuote.create({
      data: {
        applicationId,
        createdBy: user.id,
        customerId: application.customerId,
        depositAmount: depositRule.depositAmount,
        benefitPackageId: quoteData.benefitPackageId,
        energyLimitCount: quoteData.energyLimitCount,
        energyLimitKwh: quoteData.energyLimitKwh,
        energyPackageId: quoteData.energyPackageId,
        mileageLimitKm: quoteData.mileageLimitKm,
        mileagePackageId: quoteData.mileagePackageId,
        monthlyFeeAmount: BigInt(dto.monthlyFeeAmount),
        monthlyFeeRate: quoteData.monthlyFeeRate,
        overMileageFeeAmount: quoteData.overMileageFeeAmount,
        packageSnapshot: quoteData.packageSnapshot,
        periodMonths: dto.periodMonths,
        productId: quoteData.productId,
        productVersionId: dto.productVersionId,
        quoteNo: await generateBusinessNo(this.prisma, "subscriptionQuote", "QUO"),
        riskResultId: riskResult.id,
        updatedBy: user.id,
        vehicleModel: quoteData.vehicleModel,
        vehiclePackageId: quoteData.vehiclePackageId,
        vehiclePurchasePriceAmount: BigInt(dto.vehiclePurchasePriceAmount)
      },
      include: quoteInclude
    });

    await this.writeAudit(AuditAction.CREATE, "subscription_quote", quote.id, undefined, toQuoteView(quote), user, context);
    return toQuoteView(quote);
  }

  async updateQuote(id: string, dto: UpdateQuoteDto, user: RequestUser, context: RequestContext) {
    const before = await this.findQuoteOrThrow(id);
    ensureCanAccessQuote(before, user);
    if (before.status !== QuoteStatus.DRAFT) {
      throw new BadRequestException("Only draft quotes can be updated.");
    }
    const priceRule = await this.findActivePriceRule(before.productVersionId, before.vehicleModel);
    const monthlyFeeAmount = dto.monthlyFeeAmount ?? Number(before.monthlyFeeAmount);
    const periodMonths = dto.periodMonths ?? before.periodMonths;
    ensurePeriodInRange(periodMonths, priceRule);
    assertMonthlyFeeWithinCap(
      monthlyFeeAmount,
      Number(before.vehiclePurchasePriceAmount),
      before.monthlyFeeRate
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
    const quote = await this.prisma.subscriptionQuote.update({
      data: {
        confirmedAt: new Date(),
        confirmedBy: user.id,
        status: QuoteStatus.CONFIRMED,
        updatedBy: user.id
      },
      include: quoteInclude,
      where: { id }
    });
    await this.writeAudit(AuditAction.APPROVE, "subscription_quote", id, toQuoteView(before), toQuoteView(quote), user, context);
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
    const row = await this.prisma.vehiclePackage.findUnique({ include: packageInclude, where: { id } });
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

  private async findActivePriceRule(productVersionId: string, vehicleModel: CreateQuoteDto["vehicleModel"]) {
    const version = await this.findVersionOrThrow(productVersionId);
    ensureSubscriptionProductType(version.product.productType);
    if (version.product.status !== ProductStatus.ACTIVE || version.status !== ProductVersionStatus.ACTIVE) {
      throw new BadRequestException("An active product and product version are required.");
    }
    const rule = await this.prisma.productPriceRule.findFirst({
      include: priceRuleInclude,
      where: {
        deletedAt: null,
        productVersionId,
        status: RecordStatus.ACTIVE,
        vehicleModel
      }
    });
    if (!rule) {
      throw new BadRequestException(`No active price rule found for ${vehicleModel}.`);
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

  private async nextPackageNo(
    table: "benefitPackage" | "energyPackage" | "mileagePackage" | "vehiclePackage",
    prefix: string
  ) {
    const today = new Date();
    const datePart = today.toISOString().slice(0, 10).replaceAll("-", "");
    const count =
      table === "vehiclePackage"
        ? await this.prisma.vehiclePackage.count()
        : table === "mileagePackage"
          ? await this.prisma.mileagePackage.count()
          : table === "energyPackage"
            ? await this.prisma.energyPackage.count()
            : await this.prisma.benefitPackage.count();
    return `${prefix}${datePart}${String(count + 1).padStart(5, "0")}`;
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

async function generateBusinessNo(
  tx: Pick<Tx, "product" | "subscriptionQuote">,
  table: "product" | "subscriptionQuote",
  prefix: string
) {
  const today = new Date();
  const datePart = today.toISOString().slice(0, 10).replaceAll("-", "");
  const count = table === "product" ? await tx.product.count() : await tx.subscriptionQuote.count();
  return `${prefix}${datePart}${String(count + 1).padStart(5, "0")}`;
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
  rule: Pick<PriceRuleWithDetails, "maxPeriodMonths" | "minPeriodMonths">
) {
  if (periodMonths < rule.minPeriodMonths || periodMonths > rule.maxPeriodMonths) {
    throw new BadRequestException("periodMonths is outside the product price rule range.");
  }
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

function toProductView(product: ProductWithDetails) {
  const versions = Array.isArray(product.versions)
    ? product.versions.map(toVersionView).filter((version) => version !== null)
    : [];
  const activeVersion = product.versions?.find((version) => version?.status === ProductVersionStatus.ACTIVE) ?? null;

  return {
    activeVersion: toVersionView(activeVersion),
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

function toVersionView(version?: ProductListVersion | VersionWithDetails | null) {
  if (!version) {
    return null;
  }
  const product = "product" in version ? version.product : null;

  return {
    approvedAt: version.approvedAt,
    approver: version.approver,
    effectiveFrom: version.effectiveFrom.toISOString().slice(0, 10),
    effectiveTo: version.effectiveTo?.toISOString().slice(0, 10) ?? null,
    id: version.id,
    benefitPackages: version.benefitPackages?.map(toPackageView) ?? [],
    energyPackages: version.energyPackages?.map(toPackageView) ?? [],
    mileagePackages: version.mileagePackages?.map(toPackageView) ?? [],
    priceRules: version.priceRules.map(toPriceRuleView),
    product: product
      ? {
          id: product.id,
          name: product.name,
          productNo: product.productNo,
          status: product.status
        }
      : null,
    productId: version.productId,
    status: version.status,
    vehiclePackages: version.vehiclePackages?.map(toPackageView) ?? [],
    versionNo: version.versionNo
  };
}

function toPriceRuleView(rule: Prisma.ProductPriceRuleGetPayload<{ include?: typeof priceRuleInclude }>) {
  return {
    baseMileageKm: rule.baseMileageKm,
    energyLimitCount: rule.energyLimitCount,
    energyLimitKwh: rule.energyLimitKwh,
    id: rule.id,
    maxPeriodMonths: rule.maxPeriodMonths,
    minPeriodMonths: rule.minPeriodMonths,
    monthlyFeeRate: Number(rule.monthlyFeeRate),
    overMileageFeeAmount: Number(rule.overMileageFeeAmount),
    productVersionId: rule.productVersionId,
    status: rule.status,
    vehicleModel: rule.vehicleModel
  };
}

function toPackageView(
  row:
    | Prisma.VehiclePackageGetPayload<{ include: typeof packageInclude }>
    | Prisma.MileagePackageGetPayload<{ include: typeof packageInclude }>
    | Prisma.EnergyPackageGetPayload<{ include: typeof packageInclude }>
    | Prisma.BenefitPackageGetPayload<{ include: typeof packageInclude }>
) {
  const result: Record<string, unknown> = {
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
    id: row.id,
    packageName: row.packageName,
    packageNo: row.packageNo,
    product: row.product,
    productId: row.productId,
    productVersion: row.productVersion,
    productVersionId: row.productVersionId,
    remark: row.remark,
    status: row.status,
    updatedAt: row.updatedAt
  };

  if ("vehicleModel" in row) {
    result.brand = row.brand;
    result.configName = row.configName;
    result.maxPeriodMonths = row.maxPeriodMonths;
    result.maxPurchasePriceAmount = row.maxPurchasePriceAmount === null ? null : Number(row.maxPurchasePriceAmount);
    result.minPeriodMonths = row.minPeriodMonths;
    result.minPurchasePriceAmount = row.minPurchasePriceAmount === null ? null : Number(row.minPurchasePriceAmount);
    result.monthlyFeeRate = Number(row.monthlyFeeRate);
    result.series = row.series;
    result.vehicleModel = row.vehicleModel;
    result.vehicleModelName = row.vehicleModelName;
  }
  if ("monthlyMileageKm" in row) {
    result.monthlyMileageKm = row.monthlyMileageKm;
    result.overMileageFeeAmount = Number(row.overMileageFeeAmount);
    result.priceAmount = Number(row.priceAmount);
  }
  if ("monthlyEnergyKwh" in row) {
    result.monthlyEnergyCount = row.monthlyEnergyCount;
    result.monthlyEnergyKwh = row.monthlyEnergyKwh;
    result.priceAmount = Number(row.priceAmount);
    result.serviceDescription = row.serviceDescription;
    result.stationScope = row.stationScope;
  }
  if ("benefitType" in row) {
    result.benefitCount = row.benefitCount;
    result.benefitType = row.benefitType;
    result.description = row.description;
    result.priceAmount = Number(row.priceAmount);
  }

  return result;
}

function toQuoteView(quote: QuoteWithDetails) {
  const monthlyFeeCapAmount = Math.floor(
    Number(quote.vehiclePurchasePriceAmount) * Number(quote.monthlyFeeRate)
  );
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
    depositAmount: Number(quote.depositAmount),
    energyLimitCount: quote.energyLimitCount,
    energyLimitKwh: quote.energyLimitKwh,
    expiredAt: quote.expiredAt,
    id: quote.id,
    mileageLimitKm: quote.mileageLimitKm,
    monthlyFeeAmount: Number(quote.monthlyFeeAmount),
    monthlyFeeCapAmount,
    monthlyFeeRate: Number(quote.monthlyFeeRate),
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
    benefitPackage: quote.benefitPackage ? toPackageView(quote.benefitPackage) : null,
    benefitPackageId: quote.benefitPackageId,
    energyPackage: quote.energyPackage ? toPackageView(quote.energyPackage) : null,
    energyPackageId: quote.energyPackageId,
    mileagePackage: quote.mileagePackage ? toPackageView(quote.mileagePackage) : null,
    mileagePackageId: quote.mileagePackageId,
    vehiclePackage: quote.vehiclePackage ? toPackageView(quote.vehiclePackage) : null,
    vehiclePackageId: quote.vehiclePackageId,
    vehicleModel: quote.vehicleModel,
    vehiclePurchasePriceAmount: Number(quote.vehiclePurchasePriceAmount)
  };
}
