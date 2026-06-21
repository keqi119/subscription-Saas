import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  Prisma,
  ProductStatus,
  ProductType,
  ProductVersionStatus,
  RecordStatus,
  SubscriptionPlanStatus,
  Vehicle,
  VehicleListingMediaCategory,
  VehicleListingStatus
} from "@prisma/client";
import type { Readable } from "node:stream";

import { RequestUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import {
  PutVehicleListingPlansDto,
  UpdateVehicleListingMediaDto,
  UploadVehicleListingMediaDto,
  UpsertVehicleListingProfileDto,
  VehicleListingPlanInputDto
} from "./dto/vehicle-listing.dto";

export interface UploadedVehicleListingFile {
  buffer: Buffer;
  mimetype?: string;
  originalname: string;
  size: number;
}

export interface VehicleListingMediaPreview {
  filename: string;
  mimeType: string | null;
  sizeBytes: number;
  stream: Readable;
}

const listingProfileInclude = {
  media: {
    orderBy: [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }],
    where: { deletedAt: null }
  },
  plans: {
    include: {
      subscriptionPlan: {
        select: {
          id: true,
          planName: true,
          planNo: true,
          status: true
        }
      }
    },
    orderBy: [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }],
    where: { deletedAt: null }
  }
} satisfies Prisma.VehicleListingProfileInclude;

const activePlanInclude = {
  benefitPackage: true,
  energyPackage: true,
  mileagePackage: true,
  product: {
    select: {
      deletedAt: true,
      id: true,
      productType: true,
      status: true
    }
  },
  productVersion: {
    select: {
      deletedAt: true,
      id: true,
      productId: true,
      status: true
    }
  },
  vehiclePackage: true
} satisfies Prisma.SubscriptionPlanInclude;

type ListingProfileWithRelations = Prisma.VehicleListingProfileGetPayload<{
  include: typeof listingProfileInclude;
}>;

type ListingMediaRecord = Prisma.VehicleListingMediaGetPayload<Record<string, never>>;

type ListingPlanRecord = Prisma.VehicleListingPlanGetPayload<{
  include: { subscriptionPlan: { select: { id: true; planName: true; planNo: true; status: true } } };
}>;

type ActiveSubscriptionPlan = Prisma.SubscriptionPlanGetPayload<{
  include: typeof activePlanInclude;
}>;

@Injectable()
export class VehicleListingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService
  ) {}

  async getListingProfile(vehicleId: string) {
    await this.findVehicleOrThrow(vehicleId);
    const profile = await this.prisma.vehicleListingProfile.findUnique({
      include: listingProfileInclude,
      where: { vehicleId }
    });

    return profile && !profile.deletedAt ? toListingProfileView(profile) : null;
  }

  async upsertListingProfile(vehicleId: string, dto: UpsertVehicleListingProfileDto, user: RequestUser) {
    await this.findVehicleOrThrow(vehicleId);
    const data = buildProfileData(dto, user.id);
    const profile = await this.prisma.vehicleListingProfile.upsert({
      create: {
        ...data,
        createdBy: user.id,
        updatedBy: user.id,
        vehicleId
      },
      include: listingProfileInclude,
      update: data,
      where: { vehicleId }
    });

    await this.linkExistingChildren(vehicleId, profile.id);
    return toListingProfileView(profile);
  }

  async publishListingProfile(vehicleId: string, user: RequestUser) {
    await this.findVehicleOrThrow(vehicleId);
    const now = new Date();
    const profile = await this.prisma.vehicleListingProfile.upsert({
      create: {
        createdBy: user.id,
        listingStatus: VehicleListingStatus.PUBLISHED,
        portalVisible: true,
        publishedAt: now,
        updatedBy: user.id,
        vehicleId
      },
      include: listingProfileInclude,
      update: {
        listingStatus: VehicleListingStatus.PUBLISHED,
        portalVisible: true,
        publishedAt: now,
        unpublishedAt: null,
        updatedBy: user.id
      },
      where: { vehicleId }
    });

    await this.linkExistingChildren(vehicleId, profile.id);
    return toListingProfileView(profile);
  }

  async unpublishListingProfile(vehicleId: string, user: RequestUser) {
    await this.findVehicleOrThrow(vehicleId);
    const now = new Date();
    const profile = await this.prisma.vehicleListingProfile.upsert({
      create: {
        createdBy: user.id,
        listingStatus: VehicleListingStatus.UNPUBLISHED,
        portalVisible: false,
        unpublishedAt: now,
        updatedBy: user.id,
        vehicleId
      },
      include: listingProfileInclude,
      update: {
        listingStatus: VehicleListingStatus.UNPUBLISHED,
        portalVisible: false,
        unpublishedAt: now,
        updatedBy: user.id
      },
      where: { vehicleId }
    });

    await this.linkExistingChildren(vehicleId, profile.id);
    return toListingProfileView(profile);
  }

  async listMedia(vehicleId: string) {
    await this.findVehicleOrThrow(vehicleId);
    const rows = await this.prisma.vehicleListingMedia.findMany({
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      where: { deletedAt: null, vehicleId }
    });
    return rows.map(toListingMediaView);
  }

  async uploadMedia(
    vehicleId: string,
    dto: UploadVehicleListingMediaDto,
    files: UploadedVehicleListingFile[] | undefined,
    user: RequestUser
  ) {
    await this.findVehicleOrThrow(vehicleId);
    const file = files?.[0];
    if (!file) {
      throw new BadRequestException("vehicle listing media file is required");
    }
    assertUploadFileAllowed(file);

    const profile = await this.prisma.vehicleListingProfile.findUnique({ where: { vehicleId } });
    const mediaCategory = dto.mediaCategory ?? VehicleListingMediaCategory.EXTERIOR;
    const isCover = dto.isCover ?? mediaCategory === VehicleListingMediaCategory.COVER;
    const stored = await this.storageService.putVehicleListingMedia({
      buffer: file.buffer,
      contentType: file.mimetype,
      metadata: { originalName: file.originalname },
      originalName: file.originalname,
      vehicleId
    });

    if (isCover) {
      await this.clearCover(vehicleId);
    }

    const media = await this.prisma.vehicleListingMedia.create({
      data: {
        bucket: stored.bucket,
        caption: dto.caption ?? null,
        customerVisible: dto.customerVisible ?? true,
        fileName: file.originalname,
        fileSize: file.size,
        isCover,
        listingProfileId: profile?.id,
        mediaCategory,
        mimeType: file.mimetype ?? null,
        objectKey: stored.objectKey,
        originalName: file.originalname,
        sortOrder: dto.sortOrder ?? 0,
        uploadedBy: user.id,
        vehicleId
      }
    });

    return toListingMediaView(media);
  }

  async updateMedia(vehicleId: string, mediaId: string, dto: UpdateVehicleListingMediaDto) {
    await this.findVehicleOrThrow(vehicleId);
    await this.findMediaOrThrow(vehicleId, mediaId);
    if (dto.isCover) {
      await this.clearCover(vehicleId);
    }

    const data: Prisma.VehicleListingMediaUpdateInput = {};
    assignIfDefined(data, "caption", dto.caption);
    assignIfDefined(data, "customerVisible", dto.customerVisible);
    assignIfDefined(data, "isCover", dto.isCover);
    assignIfDefined(data, "mediaCategory", dto.mediaCategory);
    assignIfDefined(data, "sortOrder", dto.sortOrder);

    const media = await this.prisma.vehicleListingMedia.update({
      data,
      where: { id: mediaId }
    });

    return toListingMediaView(media);
  }

  async deleteMedia(vehicleId: string, mediaId: string) {
    await this.findVehicleOrThrow(vehicleId);
    await this.findMediaOrThrow(vehicleId, mediaId);
    const media = await this.prisma.vehicleListingMedia.update({
      data: {
        customerVisible: false,
        deletedAt: new Date(),
        isCover: false
      },
      where: { id: mediaId }
    });

    return toListingMediaView(media);
  }

  async previewMedia(vehicleId: string, mediaId: string): Promise<VehicleListingMediaPreview> {
    await this.findVehicleOrThrow(vehicleId);
    const media = await this.findMediaOrThrow(vehicleId, mediaId);
    if (!media.bucket || !media.objectKey) {
      throw new NotFoundException("vehicle listing media object is missing");
    }

    const downloaded = await this.storageService.getVehicleListingMediaStream(media.bucket, media.objectKey);
    return {
      filename: media.originalName ?? media.fileName,
      mimeType: downloaded.contentType ?? media.mimeType,
      sizeBytes: downloaded.contentLength ?? media.fileSize ?? 0,
      stream: downloaded.stream
    };
  }

  async listListingPlans(vehicleId: string) {
    const vehicle = await this.findVehicleOrThrow(vehicleId);
    const [availablePlans, configuredPlans] = await Promise.all([
      this.findAvailablePlansForVehicle(vehicle),
      this.prisma.vehicleListingPlan.findMany({
        include: {
          subscriptionPlan: {
            select: {
              id: true,
              planName: true,
              planNo: true,
              status: true
            }
          }
        },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        where: { deletedAt: null, vehicleId }
      })
    ]);

    return {
      availablePlans: availablePlans.map(toActiveSubscriptionPlanView),
      plans: configuredPlans.map(toListingPlanView)
    };
  }

  async putListingPlans(vehicleId: string, dto: PutVehicleListingPlansDto, user: RequestUser) {
    const vehicle = await this.findVehicleOrThrow(vehicleId);
    const availablePlans = await this.findAvailablePlansForVehicle(vehicle);
    const availablePlanIds = new Set(availablePlans.map((plan) => plan.id));

    for (const plan of dto.plans) {
      if (!availablePlanIds.has(plan.subscriptionPlanId)) {
        throw new BadRequestException("subscription plan is not active or does not match this vehicle");
      }
    }

    const profile = await this.ensureListingProfile(vehicleId, user.id);
    const nextIds = Array.from(new Set(dto.plans.map((plan) => plan.subscriptionPlanId)));

    await this.prisma.$transaction(async (tx) => {
      await tx.vehicleListingPlan.updateMany({
        data: { deletedAt: new Date(), visible: false },
        where: {
          deletedAt: null,
          subscriptionPlanId: { notIn: nextIds },
          vehicleId
        }
      });

      for (const plan of dto.plans) {
        await tx.vehicleListingPlan.upsert({
          create: buildListingPlanCreate(vehicleId, profile.id, plan),
          update: buildListingPlanUpdate(profile.id, plan),
          where: {
            vehicleId_subscriptionPlanId: {
              subscriptionPlanId: plan.subscriptionPlanId,
              vehicleId
            }
          }
        });
      }
    });

    return this.listListingPlans(vehicleId);
  }

  private async findVehicleOrThrow(vehicleId: string) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: {
        deletedAt: null,
        id: vehicleId
      }
    });

    if (!vehicle) {
      throw new NotFoundException("vehicle not found");
    }

    return vehicle;
  }

  private async findMediaOrThrow(vehicleId: string, mediaId: string) {
    const media = await this.prisma.vehicleListingMedia.findFirst({
      where: {
        deletedAt: null,
        id: mediaId,
        vehicleId
      }
    });

    if (!media) {
      throw new NotFoundException("vehicle listing media not found");
    }

    return media;
  }

  private async clearCover(vehicleId: string) {
    await this.prisma.vehicleListingMedia.updateMany({
      data: { isCover: false },
      where: {
        deletedAt: null,
        isCover: true,
        vehicleId
      }
    });
  }

  private async ensureListingProfile(vehicleId: string, userId: string) {
    const profile = await this.prisma.vehicleListingProfile.upsert({
      create: {
        createdBy: userId,
        updatedBy: userId,
        vehicleId
      },
      update: {
        updatedBy: userId
      },
      where: { vehicleId }
    });

    await this.linkExistingChildren(vehicleId, profile.id);
    return profile;
  }

  private async linkExistingChildren(vehicleId: string, listingProfileId: string) {
    await Promise.all([
      this.prisma.vehicleListingMedia.updateMany({
        data: { listingProfileId },
        where: {
          deletedAt: null,
          listingProfileId: null,
          vehicleId
        }
      }),
      this.prisma.vehicleListingPlan.updateMany({
        data: { listingProfileId },
        where: {
          deletedAt: null,
          listingProfileId: null,
          vehicleId
        }
      })
    ]);
  }

  private async findAvailablePlansForVehicle(vehicle: Pick<Vehicle, "vehicleModel">) {
    if (!vehicle.vehicleModel) {
      return [];
    }

    const today = new Date();
    const plans = await this.prisma.subscriptionPlan.findMany({
      include: activePlanInclude,
      orderBy: { createdAt: "desc" },
      where: {
        deletedAt: null,
        effectiveFrom: { lte: today },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }],
        product: {
          deletedAt: null,
          productType: ProductType.SUBSCRIPTION,
          status: ProductStatus.ACTIVE
        },
        productVersion: {
          deletedAt: null,
          status: ProductVersionStatus.ACTIVE
        },
        status: SubscriptionPlanStatus.ACTIVE,
        vehiclePackage: { vehicleModel: vehicle.vehicleModel }
      }
    });

    return plans.filter(isPlanAvailable);
  }
}

function buildProfileData(dto: UpsertVehicleListingProfileDto, userId: string) {
  const data: Record<string, unknown> = {
    updatedBy: userId
  };

  assignIfDefined(data, "applicationNotice", dto.applicationNotice);
  assignIfDefined(data, "batteryHealthCheckedAt", parseOptionalDateOnly(dto.batteryHealthCheckedAt, "batteryHealthCheckedAt"));
  assignIfDefined(data, "batteryHealthPercent", decimalOrNull(dto.batteryHealthPercent));
  assignIfDefined(data, "batteryRemark", dto.batteryRemark);
  assignIfDefined(data, "conditionGrade", dto.conditionGrade);
  assignIfDefined(data, "conditionSummary", dto.conditionSummary);
  assignIfDefined(data, "customerTags", jsonOrNull(dto.customerTags));
  assignIfDefined(data, "displayName", dto.displayName);
  assignIfDefined(data, "estimatedRangeKm", dto.estimatedRangeKm);
  assignIfDefined(data, "faqSnapshot", jsonOrNull(dto.faqSnapshot));
  assignIfDefined(data, "feeDescription", dto.feeDescription);
  assignIfDefined(data, "hasFireDamage", dto.hasFireDamage);
  assignIfDefined(data, "hasFloodDamage", dto.hasFloodDamage);
  assignIfDefined(data, "hasMajorAccident", dto.hasMajorAccident);
  assignIfDefined(data, "hasStructuralDamage", dto.hasStructuralDamage);
  assignIfDefined(data, "highlightSummary", dto.highlightSummary);
  assignIfDefined(data, "knownDefectsSummary", dto.knownDefectsSummary);
  assignIfDefined(data, "listingStatus", dto.listingStatus);
  assignIfDefined(data, "portalVisible", dto.portalVisible);
  assignIfDefined(data, "sellingPoints", jsonOrNull(dto.sellingPoints));
  assignIfDefined(data, "serviceHighlights", jsonOrNull(dto.serviceHighlights));
  assignIfDefined(data, "shortTitle", dto.shortTitle);
  assignIfDefined(data, "sortOrder", dto.sortOrder);
  assignIfDefined(data, "subtitle", dto.subtitle);

  return data;
}

function buildListingPlanCreate(
  vehicleId: string,
  listingProfileId: string,
  plan: VehicleListingPlanInputDto
): Prisma.VehicleListingPlanUncheckedCreateInput {
  return {
    deletedAt: null,
    displayMonthlyFeeAmount: moneyOrNull(plan.displayMonthlyFeeAmount),
    displayRemark: plan.displayRemark ?? null,
    listingProfileId,
    recommended: plan.recommended ?? false,
    sortOrder: plan.sortOrder ?? 0,
    subscriptionPlanId: plan.subscriptionPlanId,
    vehicleId,
    visible: plan.visible ?? true
  };
}

function buildListingPlanUpdate(
  listingProfileId: string,
  plan: VehicleListingPlanInputDto
): Prisma.VehicleListingPlanUncheckedUpdateInput {
  return {
    deletedAt: null,
    displayMonthlyFeeAmount: moneyOrNull(plan.displayMonthlyFeeAmount),
    displayRemark: plan.displayRemark ?? null,
    listingProfileId,
    recommended: plan.recommended ?? false,
    sortOrder: plan.sortOrder ?? 0,
    visible: plan.visible ?? true
  };
}

function toListingProfileView(profile: ListingProfileWithRelations) {
  return {
    applicationNotice: profile.applicationNotice,
    batteryHealthCheckedAt: profile.batteryHealthCheckedAt,
    batteryHealthPercent: decimalToNumber(profile.batteryHealthPercent),
    batteryRemark: profile.batteryRemark,
    conditionGrade: profile.conditionGrade,
    conditionSummary: profile.conditionSummary,
    createdAt: profile.createdAt,
    createdBy: profile.createdBy,
    customerTags: profile.customerTags,
    deletedAt: profile.deletedAt,
    displayName: profile.displayName,
    estimatedRangeKm: profile.estimatedRangeKm,
    faqSnapshot: profile.faqSnapshot,
    feeDescription: profile.feeDescription,
    hasFireDamage: profile.hasFireDamage,
    hasFloodDamage: profile.hasFloodDamage,
    hasMajorAccident: profile.hasMajorAccident,
    hasStructuralDamage: profile.hasStructuralDamage,
    highlightSummary: profile.highlightSummary,
    id: profile.id,
    knownDefectsSummary: profile.knownDefectsSummary,
    listingStatus: profile.listingStatus,
    media: profile.media.map(toListingMediaView),
    plans: profile.plans.map(toListingPlanView),
    portalVisible: profile.portalVisible,
    publishedAt: profile.publishedAt,
    sellingPoints: profile.sellingPoints,
    serviceHighlights: profile.serviceHighlights,
    shortTitle: profile.shortTitle,
    sortOrder: profile.sortOrder,
    subtitle: profile.subtitle,
    unpublishedAt: profile.unpublishedAt,
    updatedAt: profile.updatedAt,
    updatedBy: profile.updatedBy,
    vehicleId: profile.vehicleId
  };
}

function toListingMediaView(media: ListingMediaRecord) {
  return {
    bucket: media.bucket,
    caption: media.caption,
    createdAt: media.createdAt,
    customerVisible: media.customerVisible,
    deletedAt: media.deletedAt,
    fileName: media.fileName,
    fileSize: media.fileSize,
    id: media.id,
    isCover: media.isCover,
    listingProfileId: media.listingProfileId,
    mediaCategory: media.mediaCategory,
    mimeType: media.mimeType,
    objectKey: media.objectKey,
    originalName: media.originalName,
    previewUrl: `/api/vehicles/${media.vehicleId}/listing-media/${media.id}/preview`,
    sortOrder: media.sortOrder,
    updatedAt: media.updatedAt,
    uploadedBy: media.uploadedBy,
    vehicleId: media.vehicleId
  };
}

function toListingPlanView(plan: ListingPlanRecord) {
  return {
    createdAt: plan.createdAt,
    deletedAt: plan.deletedAt,
    displayMonthlyFeeAmount: numberOrNull(plan.displayMonthlyFeeAmount),
    displayRemark: plan.displayRemark,
    id: plan.id,
    listingProfileId: plan.listingProfileId,
    recommended: plan.recommended,
    sortOrder: plan.sortOrder,
    subscriptionPlan: plan.subscriptionPlan,
    subscriptionPlanId: plan.subscriptionPlanId,
    updatedAt: plan.updatedAt,
    vehicleId: plan.vehicleId,
    visible: plan.visible
  };
}

function toActiveSubscriptionPlanView(plan: ActiveSubscriptionPlan) {
  return {
    packageSummary: [
      plan.vehiclePackage.packageName,
      plan.mileagePackage.packageName,
      plan.energyPackage.packageName,
      plan.benefitPackage?.packageName
    ].filter(Boolean),
    planId: plan.id,
    planName: plan.planName,
    planNo: plan.planNo,
    status: plan.status,
    subscriptionPeriodRange: {
      max: plan.maxPeriodMonths,
      min: plan.minPeriodMonths
    }
  };
}

function isPlanAvailable(plan: ActiveSubscriptionPlan) {
  return (
    plan.status === SubscriptionPlanStatus.ACTIVE &&
    plan.product.status === ProductStatus.ACTIVE &&
    plan.product.productType === ProductType.SUBSCRIPTION &&
    plan.productVersion.status === ProductVersionStatus.ACTIVE &&
    !plan.product.deletedAt &&
    !plan.productVersion.deletedAt &&
    packageBelongsToPlan(plan, plan.vehiclePackage) &&
    packageBelongsToPlan(plan, plan.mileagePackage) &&
    packageBelongsToPlan(plan, plan.energyPackage) &&
    (!plan.benefitPackage || packageBelongsToPlan(plan, plan.benefitPackage))
  );
}

function packageBelongsToPlan(
  plan: ActiveSubscriptionPlan,
  item: { deletedAt: Date | null; productId: string; productVersionId: string; status: RecordStatus }
) {
  return (
    !item.deletedAt &&
    item.status === RecordStatus.ACTIVE &&
    item.productId === plan.productId &&
    item.productVersionId === plan.productVersionId
  );
}

function assertUploadFileAllowed(file: UploadedVehicleListingFile) {
  const mimeType = file.mimetype ?? "";
  if (mimeType.startsWith("video/") || mimeType.startsWith("audio/")) {
    throw new BadRequestException("vehicle listing media does not support video or audio files");
  }
  if (file.size <= 0 || !file.buffer?.length) {
    throw new BadRequestException("vehicle listing media file is empty");
  }
}

function assignIfDefined<T extends object>(target: T, key: string, value: unknown) {
  if (value !== undefined) {
    (target as Record<string, unknown>)[key] = value;
  }
}

function jsonOrNull(value: unknown[] | null | undefined) {
  if (value === undefined) {
    return undefined;
  }
  return value === null ? null : (value as Prisma.InputJsonValue);
}

function decimalOrNull(value: number | null | undefined) {
  if (value === undefined) {
    return undefined;
  }
  return value === null ? null : new Prisma.Decimal(value);
}

function moneyOrNull(value: number | null | undefined) {
  if (value === undefined || value === null) {
    return null;
  }
  return BigInt(value);
}

function numberOrNull(value: bigint | null) {
  return value === null ? null : Number(value);
}

function decimalToNumber(value: Prisma.Decimal | null) {
  return value ? value.toNumber() : null;
}

function parseOptionalDateOnly(value: string | null | undefined, fieldName: string) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === "") {
    return null;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`${fieldName} must be a valid date`);
  }
  return parsed;
}
