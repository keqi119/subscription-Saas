import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import {
  DeliveryEvidenceFileLifecycleStatus,
  DeliveryEvidenceMediaType,
  DeliveryEvidenceRequirementLevel,
  DeliveryEvidenceReviewStatus,
  DeliveryEvidenceStatus,
  DeliveryEvidenceType,
  Prisma
} from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";

export const DELIVERY_EVIDENCE_NOT_READY_MESSAGE = "交付证据尚未全部上传并审核通过。";

export type DeliveryEvidenceBlockingCode =
  | "HANDOVER_EVIDENCE_MISSING"
  | "HANDOVER_EVIDENCE_REJECTED"
  | "HANDOVER_EVIDENCE_REVIEW_PENDING"
  | "DAMAGE_EVIDENCE_MISSING"
  | "DAMAGE_EVIDENCE_REJECTED"
  | "DAMAGE_EVIDENCE_REVIEW_PENDING"
  | "DAMAGE_STATE_CONFLICT";

export interface DeliveryEvidenceBlockingReason {
  code: DeliveryEvidenceBlockingCode;
  evidenceType?: DeliveryEvidenceType;
  itemId?: string;
  message: string;
}

export interface DeliveryEvidenceReadiness {
  blockingDetails: DeliveryEvidenceBlockingReason[];
  blockingReasons: string[];
  handoverId: string | null;
  orderId: string;
  ready: boolean;
}

export interface DeliveryEvidenceFieldState {
  damageDeclared?: boolean | null;
  noVisibleDamageDeclared?: boolean | null;
}

type EvidenceReadinessMode = "FIELD_COMPLETENESS" | "OPS_REVIEW";

type ChecklistScopeInput = {
  handoverId?: string | null;
  orderId: string;
};

type EvidenceDefinition = {
  acceptance?: string;
  allowedMediaTypes: DeliveryEvidenceMediaType[];
  allowsMultiple: boolean;
  conditionKey?: string;
  conditionValue?: string;
  description?: string;
  evidenceType: DeliveryEvidenceType;
  fileRequired: boolean;
  isConditional: boolean;
  isRequired: boolean;
  requirementLevel: DeliveryEvidenceRequirementLevel;
  title: string;
};

export const DELIVERY_EVIDENCE_CHECKLIST_DEFINITIONS: EvidenceDefinition[] = [
  {
    acceptance: "customer face and plate visible",
    allowedMediaTypes: [DeliveryEvidenceMediaType.PHOTO],
    allowsMultiple: false,
    evidenceType: DeliveryEvidenceType.CUSTOMER_WITH_VEHICLE_FRONT,
    fileRequired: true,
    isConditional: false,
    isRequired: true,
    requirementLevel: DeliveryEvidenceRequirementLevel.REQUIRED,
    title: "客户与车辆正面合影"
  },
  {
    allowedMediaTypes: [DeliveryEvidenceMediaType.PHOTO],
    allowsMultiple: false,
    evidenceType: DeliveryEvidenceType.VEHICLE_FRONT,
    fileRequired: true,
    isConditional: false,
    isRequired: true,
    requirementLevel: DeliveryEvidenceRequirementLevel.REQUIRED,
    title: "车辆车头正面"
  },
  {
    allowedMediaTypes: [DeliveryEvidenceMediaType.PHOTO],
    allowsMultiple: false,
    evidenceType: DeliveryEvidenceType.VEHICLE_REAR,
    fileRequired: true,
    isConditional: false,
    isRequired: true,
    requirementLevel: DeliveryEvidenceRequirementLevel.REQUIRED,
    title: "车辆车尾正面"
  },
  {
    allowedMediaTypes: [DeliveryEvidenceMediaType.PHOTO],
    allowsMultiple: false,
    evidenceType: DeliveryEvidenceType.VIN_OR_FRAME_NUMBER,
    fileRequired: true,
    isConditional: false,
    isRequired: true,
    requirementLevel: DeliveryEvidenceRequirementLevel.REQUIRED,
    title: "车架号 / VIN"
  },
  {
    allowedMediaTypes: [DeliveryEvidenceMediaType.PHOTO],
    allowsMultiple: false,
    description: "可在 metadata.handoverMileageKm 中记录交付里程。",
    evidenceType: DeliveryEvidenceType.ODOMETER_DASHBOARD,
    fileRequired: true,
    isConditional: false,
    isRequired: true,
    requirementLevel: DeliveryEvidenceRequirementLevel.REQUIRED,
    title: "仪表台公里数"
  },
  {
    allowedMediaTypes: [DeliveryEvidenceMediaType.PHOTO],
    allowsMultiple: false,
    evidenceType: DeliveryEvidenceType.INTERIOR_REAR,
    fileRequired: true,
    isConditional: false,
    isRequired: true,
    requirementLevel: DeliveryEvidenceRequirementLevel.REQUIRED,
    title: "后排内饰"
  },
  {
    allowedMediaTypes: [DeliveryEvidenceMediaType.PHOTO],
    allowsMultiple: false,
    evidenceType: DeliveryEvidenceType.INTERIOR_FRONT,
    fileRequired: true,
    isConditional: false,
    isRequired: true,
    requirementLevel: DeliveryEvidenceRequirementLevel.REQUIRED,
    title: "前排内饰"
  },
  {
    allowedMediaTypes: [DeliveryEvidenceMediaType.VIDEO],
    allowsMultiple: false,
    evidenceType: DeliveryEvidenceType.WALKAROUND_VIDEO,
    fileRequired: true,
    isConditional: false,
    isRequired: true,
    requirementLevel: DeliveryEvidenceRequirementLevel.REQUIRED,
    title: "车辆环绕视频"
  },
  {
    allowedMediaTypes: [DeliveryEvidenceMediaType.PHOTO, DeliveryEvidenceMediaType.VIDEO],
    allowsMultiple: false,
    evidenceType: DeliveryEvidenceType.WHEEL_CLOSEUP_FRONT_LEFT,
    fileRequired: true,
    isConditional: false,
    isRequired: true,
    requirementLevel: DeliveryEvidenceRequirementLevel.REQUIRED,
    title: "左前轮毂近拍"
  },
  {
    allowedMediaTypes: [DeliveryEvidenceMediaType.PHOTO, DeliveryEvidenceMediaType.VIDEO],
    allowsMultiple: false,
    evidenceType: DeliveryEvidenceType.WHEEL_CLOSEUP_FRONT_RIGHT,
    fileRequired: true,
    isConditional: false,
    isRequired: true,
    requirementLevel: DeliveryEvidenceRequirementLevel.REQUIRED,
    title: "右前轮毂近拍"
  },
  {
    allowedMediaTypes: [DeliveryEvidenceMediaType.PHOTO, DeliveryEvidenceMediaType.VIDEO],
    allowsMultiple: false,
    evidenceType: DeliveryEvidenceType.WHEEL_CLOSEUP_REAR_LEFT,
    fileRequired: true,
    isConditional: false,
    isRequired: true,
    requirementLevel: DeliveryEvidenceRequirementLevel.REQUIRED,
    title: "左后轮毂近拍"
  },
  {
    allowedMediaTypes: [DeliveryEvidenceMediaType.PHOTO, DeliveryEvidenceMediaType.VIDEO],
    allowsMultiple: false,
    evidenceType: DeliveryEvidenceType.WHEEL_CLOSEUP_REAR_RIGHT,
    fileRequired: true,
    isConditional: false,
    isRequired: true,
    requirementLevel: DeliveryEvidenceRequirementLevel.REQUIRED,
    title: "右后轮毂近拍"
  },
  {
    allowedMediaTypes: [DeliveryEvidenceMediaType.PHOTO, DeliveryEvidenceMediaType.VIDEO],
    allowsMultiple: true,
    conditionKey: "damage",
    conditionValue: "DECLARED",
    evidenceType: DeliveryEvidenceType.DAMAGE_STATIC_CLOSEUP,
    fileRequired: true,
    isConditional: true,
    isRequired: false,
    requirementLevel: DeliveryEvidenceRequirementLevel.CONDITIONAL,
    title: "损伤/瑕疵静止近拍"
  },
  {
    allowedMediaTypes: [],
    allowsMultiple: false,
    conditionKey: "damage",
    conditionValue: "NO_VISIBLE_DAMAGE",
    evidenceType: DeliveryEvidenceType.NO_VISIBLE_DAMAGE_DECLARATION,
    fileRequired: false,
    isConditional: true,
    isRequired: false,
    requirementLevel: DeliveryEvidenceRequirementLevel.CONDITIONAL,
    title: "无可见损伤声明"
  }
] as const;

const DEFINITION_BY_TYPE = new Map(
  DELIVERY_EVIDENCE_CHECKLIST_DEFINITIONS.map((definition) => [definition.evidenceType, definition])
);

const REQUIRED_FILE_EVIDENCE_DEFINITIONS = DELIVERY_EVIDENCE_CHECKLIST_DEFINITIONS.filter(
  (definition) => definition.isRequired
);
const MAX_DAMAGE_CLOSEUP_FILES = 20;

const evidenceFileInclude = {
  file: true,
  uploader: { select: { id: true, name: true, username: true } }
} satisfies Prisma.VehicleDeliveryEvidenceFileInclude;

const evidenceItemInclude = {
  files: {
    include: evidenceFileInclude,
    orderBy: { uploadedAt: "asc" as const },
    where: { lifecycleStatus: DeliveryEvidenceFileLifecycleStatus.ACTIVE }
  },
  reviewer: { select: { id: true, name: true, username: true } }
} satisfies Prisma.VehicleDeliveryEvidenceItemInclude;

type EvidenceItemWithFiles = Prisma.VehicleDeliveryEvidenceItemGetPayload<{ include: typeof evidenceItemInclude }>;
type DeliveryEvidenceDb = Prisma.TransactionClient | PrismaService;

@Injectable()
export class DeliveryEvidenceService {
  constructor(private readonly prisma: PrismaService) {}

  async initializeChecklist(
    orderId: string,
    handoverId?: string | null,
    db: DeliveryEvidenceDb = this.prisma
  ) {
    const scope = await this.resolveScope({ handoverId, orderId }, db);
    const existing = await this.findScopedItems(scope, db);
    const existingTypes = new Set(existing.map((item) => item.evidenceType));

    for (const definition of DELIVERY_EVIDENCE_CHECKLIST_DEFINITIONS) {
      if (existingTypes.has(definition.evidenceType)) {
        continue;
      }
      await db.vehicleDeliveryEvidenceItem.create({
        data: {
          allowsMultiple: definition.allowsMultiple,
          conditionKey: definition.conditionKey,
          conditionValue: definition.conditionValue,
          description: definition.description,
          evidenceType: definition.evidenceType,
          handoverId: scope.handoverId,
          isConditional: definition.isConditional,
          isRequired: definition.isRequired,
          metadata: toJsonValue({
            acceptance: definition.acceptance,
            allowedMediaTypes: definition.allowedMediaTypes,
            fileRequired: definition.fileRequired,
            seed: true
          }),
          orderId: scope.orderId,
          requirementLevel: definition.requirementLevel,
          status: DeliveryEvidenceStatus.NOT_STARTED,
          title: definition.title,
          vehicleDeliveryId: scope.vehicleDeliveryId
        }
      });
    }

    return this.getChecklist(scope, db);
  }

  async getChecklist(input: ChecklistScopeInput | string, db: DeliveryEvidenceDb = this.prisma) {
    const scope = await this.resolveScope(typeof input === "string" ? { orderId: input } : input, db);
    const items = await this.findScopedItems(scope, db);
    const readiness = this.buildReadiness(scope, items);

    return {
      ...readiness,
      items: items.map(toEvidenceItemView)
    };
  }

  async attachEvidenceFile(
    itemId: string,
    fileId: string,
    mediaType: DeliveryEvidenceMediaType,
    actorId?: string,
    db: DeliveryEvidenceDb = this.prisma,
    lifecycleActorId: string | undefined = actorId
  ) {
    return this.runMutation(db, async (transaction) => {
      const item = await this.findItemOrThrow(itemId, transaction);
      const definition = getDefinition(item.evidenceType);
      assertFileAllowed(definition, mediaType);
      assertEvidenceFileCapacity(definition, item.files.length);

      const file = await transaction.fileObject.findUnique({ where: { id: fileId } });
      if (!file) {
        throw new NotFoundException("文件不存在。");
      }

      await transaction.vehicleDeliveryEvidenceFile.create({
        data: {
          evidenceItemId: item.id,
          fileId: file.id,
          lifecycleActorId,
          lifecycleStatus: DeliveryEvidenceFileLifecycleStatus.ACTIVE,
          mediaType,
          objectKey: file.objectKey,
          uploadedBy: actorId
        }
      });

      await transaction.vehicleDeliveryEvidenceItem.update({
        data: {
          rejectionReason: null,
          reviewStatus: DeliveryEvidenceReviewStatus.PENDING,
          status: DeliveryEvidenceStatus.UPLOADED
        },
        where: { id: item.id }
      });

      return toEvidenceItemView(await this.findItemOrThrow(item.id, transaction));
    });
  }

  async validateEvidenceFileMutation(
    itemId: string,
    mediaType: DeliveryEvidenceMediaType,
    replaceEvidenceFileId?: string | null
  ) {
    const item = await this.findItemOrThrow(itemId);
    const definition = getDefinition(item.evidenceType);
    assertFileAllowed(definition, mediaType);
    if (replaceEvidenceFileId) {
      if (definition.allowsMultiple) {
        throw new BadRequestException("多文件资料请直接新增或删除，不支持单文件替换。");
      }
      if (!item.files.some((file) => file.id === replaceEvidenceFileId)) {
        throw new NotFoundException("待替换的交付资料文件不存在或已失效。");
      }
    } else {
      assertEvidenceFileCapacity(definition, item.files.length);
    }
    return {
      allowsMultiple: definition.allowsMultiple,
      currentFileCount: item.files.length,
      evidenceType: item.evidenceType,
      itemId: item.id
    };
  }

  async replaceEvidenceFile(
    itemId: string,
    evidenceFileId: string,
    fileId: string,
    mediaType: DeliveryEvidenceMediaType,
    actorId?: string,
    db: DeliveryEvidenceDb = this.prisma,
    lifecycleActorId: string | undefined = actorId
  ) {
    return this.runMutation(db, async (transaction) => {
      const item = await this.findItemOrThrow(itemId, transaction);
      const definition = getDefinition(item.evidenceType);
      assertFileAllowed(definition, mediaType);
      if (definition.allowsMultiple) {
        throw new BadRequestException("多文件资料请直接新增或删除，不支持单文件替换。");
      }

      const current = item.files.find((file) => file.id === evidenceFileId);
      if (!current) {
        throw new NotFoundException("待替换的交付资料文件不存在或已失效。");
      }
      const file = await transaction.fileObject.findUnique({ where: { id: fileId } });
      if (!file) {
        throw new NotFoundException("文件不存在。");
      }

      const replacement = await transaction.vehicleDeliveryEvidenceFile.create({
        data: {
          evidenceItemId: item.id,
          fileId: file.id,
          lifecycleStatus: DeliveryEvidenceFileLifecycleStatus.ACTIVE,
          mediaType,
          objectKey: file.objectKey,
          uploadedBy: actorId
        }
      });
      await transaction.vehicleDeliveryEvidenceFile.update({
        data: {
          lifecycleActorId,
          lifecycleAt: new Date(),
          lifecycleStatus: DeliveryEvidenceFileLifecycleStatus.SUPERSEDED,
          replacedById: replacement.id
        },
        where: { id: current.id }
      });
      await transaction.vehicleDeliveryEvidenceItem.update({
        data: {
          rejectionReason: null,
          reviewedAt: null,
          reviewedBy: null,
          reviewStatus: DeliveryEvidenceReviewStatus.PENDING,
          status: DeliveryEvidenceStatus.UPLOADED
        },
          where: { id: item.id }
        });

      return toEvidenceItemView(await this.findItemOrThrow(item.id, transaction));
    });
  }

  async removeEvidenceFile(
    itemId: string,
    evidenceFileId: string,
    lifecycleActorId?: string,
    db: DeliveryEvidenceDb = this.prisma
  ) {
    return this.runMutation(db, async (transaction) => {
      const item = await this.findItemOrThrow(itemId, transaction);
      const current = item.files.find((file) => file.id === evidenceFileId);
      if (!current) {
        throw new NotFoundException("待删除的交付资料文件不存在或已失效。");
      }
      const remainingFileCount = item.files.length - 1;

      await transaction.vehicleDeliveryEvidenceFile.update({
        data: {
          lifecycleActorId,
          lifecycleAt: new Date(),
          lifecycleStatus: DeliveryEvidenceFileLifecycleStatus.REMOVED
        },
        where: { id: current.id }
      });
      await transaction.vehicleDeliveryEvidenceItem.update({
        data: remainingFileCount > 0
          ? {
              rejectionReason: null,
              reviewedAt: null,
              reviewedBy: null,
              reviewStatus: DeliveryEvidenceReviewStatus.PENDING,
              status: DeliveryEvidenceStatus.UPLOADED
            }
          : {
              rejectionReason: null,
              reviewedAt: null,
              reviewedBy: null,
              reviewStatus: DeliveryEvidenceReviewStatus.NOT_STARTED,
              status: DeliveryEvidenceStatus.NOT_STARTED
            },
          where: { id: item.id }
        });

      return toEvidenceItemView(await this.findItemOrThrow(item.id, transaction));
    });
  }

  async approveEvidenceItem(itemId: string, reviewerId: string) {
    const item = await this.findItemOrThrow(itemId);
    const definition = getDefinition(item.evidenceType);

    if (definition.fileRequired && !hasAcceptableFile(item, definition)) {
      throw new BadRequestException("该交付证据项缺少符合要求的文件。");
    }
    if (
      item.evidenceType === DeliveryEvidenceType.NO_VISIBLE_DAMAGE_DECLARATION &&
      item.declaredNoDamage !== true
    ) {
      throw new BadRequestException("请先完成无可见损伤声明。");
    }

    const reviewedAt = new Date();
    const updated = await this.prisma.vehicleDeliveryEvidenceItem.update({
      data: {
        rejectionReason: null,
        reviewedAt,
        reviewedBy: reviewerId,
        reviewStatus: DeliveryEvidenceReviewStatus.APPROVED,
        status: DeliveryEvidenceStatus.APPROVED
      },
      include: evidenceItemInclude,
      where: { id: item.id }
    });

    return toEvidenceItemView(updated);
  }

  async rejectEvidenceItem(itemId: string, reviewerId: string, reason: string) {
    const rejectionReason = normalizeRequiredText(reason, "请填写驳回原因。");
    const item = await this.findItemOrThrow(itemId);
    const reviewedAt = new Date();
    const updated = await this.prisma.vehicleDeliveryEvidenceItem.update({
      data: {
        rejectionReason,
        reviewedAt,
        reviewedBy: reviewerId,
        reviewStatus: DeliveryEvidenceReviewStatus.REJECTED,
        status: DeliveryEvidenceStatus.REJECTED
      },
      include: evidenceItemInclude,
      where: { id: item.id }
    });

    return toEvidenceItemView(updated);
  }

  async declareNoVisibleDamage(
    orderId: string,
    actorId?: string,
    handoverId?: string | null,
    remark?: string,
    db: DeliveryEvidenceDb = this.prisma
  ) {
    const scope = await this.resolveScope({ handoverId, orderId }, db);
    const items = await this.findScopedItems(scope, db);
    if (items.some(isDamageDeclared)) {
      throw new BadRequestException("已声明存在损伤，不能再声明无可见损伤。");
    }

    const declaration = items.find(
      (item) => item.evidenceType === DeliveryEvidenceType.NO_VISIBLE_DAMAGE_DECLARATION
    ) ?? await db.vehicleDeliveryEvidenceItem.create({
      data: this.buildEvidenceItemCreateInput(scope, getDefinition(DeliveryEvidenceType.NO_VISIBLE_DAMAGE_DECLARATION))
    });

    const reviewedAt = new Date();
    const updated = await db.vehicleDeliveryEvidenceItem.update({
      data: {
        declaredNoDamage: true,
        metadata: toJsonValue({
          declaredAt: reviewedAt.toISOString(),
          declaredBy: actorId ?? null,
          remark: normalizeOptionalText(remark)
        }),
        rejectionReason: null,
        reviewedAt,
        reviewedBy: actorId ?? null,
        reviewStatus: DeliveryEvidenceReviewStatus.APPROVED,
        status: DeliveryEvidenceStatus.APPROVED
      },
      include: evidenceItemInclude,
      where: { id: declaration.id }
    });

    return toEvidenceItemView(updated);
  }

  async retractNoVisibleDamageDeclaration(
    orderId: string,
    actorId?: string,
    handoverId?: string | null,
    db: DeliveryEvidenceDb = this.prisma
  ) {
    const scope = await this.resolveScope({ handoverId, orderId }, db);
    const items = await this.findScopedItems(scope, db);
    const declarations = items.filter((item) =>
      item.evidenceType === DeliveryEvidenceType.NO_VISIBLE_DAMAGE_DECLARATION &&
      item.declaredNoDamage === true
    );
    const retractedAt = new Date();
    const updated: Array<ReturnType<typeof toEvidenceItemView>> = [];

    for (const declaration of declarations) {
      const item = await db.vehicleDeliveryEvidenceItem.update({
        data: {
          declaredNoDamage: null,
          metadata: toJsonValue({
            retractedAt: retractedAt.toISOString(),
            retractedBy: actorId ?? null
          }),
          rejectionReason: null,
          reviewedAt: null,
          reviewedBy: null,
          reviewStatus: DeliveryEvidenceReviewStatus.NOT_STARTED,
          status: DeliveryEvidenceStatus.NOT_STARTED
        },
        include: evidenceItemInclude,
        where: { id: declaration.id }
      });
      updated.push(toEvidenceItemView(item));
    }

    return updated;
  }

  async declareDamage(orderId: string, actorId?: string, handoverId?: string | null, description?: string) {
    const scope = await this.resolveScope({ handoverId, orderId });
    const items = await this.findScopedItems(scope);
    if (items.some(isApprovedNoDamageDeclaration)) {
      throw new BadRequestException("已声明无可见损伤，不能再声明存在损伤。");
    }

    const damageDefinition = getDefinition(DeliveryEvidenceType.DAMAGE_STATIC_CLOSEUP);
    const existingOpenDamage = items.find((item) =>
      item.evidenceType === DeliveryEvidenceType.DAMAGE_STATIC_CLOSEUP &&
      item.files.length === 0 &&
      item.reviewStatus !== DeliveryEvidenceReviewStatus.APPROVED
    );
    if (existingOpenDamage) {
      const updated = await this.prisma.vehicleDeliveryEvidenceItem.update({
        data: {
          description: normalizeOptionalText(description) ?? existingOpenDamage.description,
          metadata: toJsonValue({
            damageDeclared: true,
            declaredAt: new Date().toISOString(),
            declaredBy: actorId ?? null
          })
        },
        include: evidenceItemInclude,
        where: { id: existingOpenDamage.id }
      });
      return toEvidenceItemView(updated);
    }

    const created = await this.prisma.vehicleDeliveryEvidenceItem.create({
      data: {
        ...this.buildEvidenceItemCreateInput(scope, damageDefinition),
        description: normalizeOptionalText(description) ?? damageDefinition.description,
        metadata: toJsonValue({
          damageDeclared: true,
          declaredAt: new Date().toISOString(),
          declaredBy: actorId ?? null
        })
      },
      include: evidenceItemInclude
    });

    return toEvidenceItemView(created);
  }

  async addDamageCloseup(input: {
    actorId?: string;
    description?: string;
    fileId?: string;
    handoverId?: string | null;
    mediaType?: DeliveryEvidenceMediaType;
    orderId: string;
  }) {
    const item = await this.declareDamage(input.orderId, input.actorId, input.handoverId, input.description);
    if (!input.fileId) {
      return item;
    }
    if (!input.mediaType) {
      throw new BadRequestException("请提供损伤近拍文件类型。");
    }
    return this.attachEvidenceFile(item.id, input.fileId, input.mediaType, input.actorId);
  }

  async validateFieldEvidenceComplete(
    orderId: string,
    handoverId?: string | null,
    fieldState?: DeliveryEvidenceFieldState
  ) {
    return this.validateEvidenceReady({ handoverId, orderId }, {
      fieldState,
      mode: "FIELD_COMPLETENESS"
    });
  }

  async validateEvidenceReadyForOpsReview(orderId: string, handoverId?: string | null) {
    return this.validateEvidenceReady({ handoverId, orderId }, { mode: "OPS_REVIEW" });
  }

  async validateEvidenceReadyForStage2Pdf(
    orderId: string,
    handoverId?: string | null,
    fieldState?: DeliveryEvidenceFieldState
  ) {
    return this.validateFieldEvidenceComplete(orderId, handoverId, fieldState);
  }

  async validateEvidenceReadyForStage2ESign(
    orderId: string,
    handoverId?: string | null,
    fieldState?: DeliveryEvidenceFieldState
  ) {
    return this.validateFieldEvidenceComplete(orderId, handoverId, fieldState);
  }

  async validateEvidenceReadyForDeliveryConfirmation(
    orderId: string,
    handoverId?: string | null,
    fieldState?: DeliveryEvidenceFieldState
  ) {
    return this.validateFieldEvidenceComplete(orderId, handoverId, fieldState);
  }

  async assertEvidenceReadyForStage2Pdf(orderId: string, handoverId?: string | null) {
    assertDeliveryEvidenceReady(await this.validateEvidenceReadyForStage2Pdf(orderId, handoverId));
  }

  async assertEvidenceReadyForStage2ESign(orderId: string, handoverId?: string | null) {
    assertDeliveryEvidenceReady(await this.validateEvidenceReadyForStage2ESign(orderId, handoverId));
  }

  async assertEvidenceReadyForDeliveryConfirmation(orderId: string, handoverId?: string | null) {
    assertDeliveryEvidenceReady(await this.validateEvidenceReadyForDeliveryConfirmation(orderId, handoverId));
  }

  async assertFieldEvidenceComplete(
    orderId: string,
    handoverId?: string | null,
    fieldState?: DeliveryEvidenceFieldState
  ) {
    assertDeliveryEvidenceReady(await this.validateFieldEvidenceComplete(orderId, handoverId, fieldState));
  }

  async assertEvidenceReadyForOpsReview(orderId: string, handoverId?: string | null) {
    assertDeliveryEvidenceReady(await this.validateEvidenceReadyForOpsReview(orderId, handoverId));
  }

  private async validateEvidenceReady(scopeInput: ChecklistScopeInput, options?: {
    fieldState?: DeliveryEvidenceFieldState;
    mode?: EvidenceReadinessMode;
  }) {
    const scope = await this.resolveScope(scopeInput);
    const items = await this.findScopedItems(scope);
    return this.buildReadiness(scope, items, options);
  }

  private async resolveScope(input: ChecklistScopeInput, db: DeliveryEvidenceDb = this.prisma) {
    let orderId = input.orderId;
    let handoverId = input.handoverId ?? null;
    let handoverVehicleDeliveryId: string | null = null;

    if (handoverId) {
      const handover = await db.vehicleDeliveryHandover.findFirst({
        select: { id: true, orderId: true, vehicleDeliveryId: true },
        where: { deletedAt: null, id: handoverId }
      });
      if (!handover) {
        throw new NotFoundException("交付交接记录不存在。");
      }
      if (handover.orderId !== orderId) {
        throw new BadRequestException("交付交接记录与订单不匹配。");
      }
      orderId = handover.orderId;
      handoverId = handover.id;
      handoverVehicleDeliveryId = handover.vehicleDeliveryId;
    }

    const order = await db.subscriptionOrder.findFirst({
      select: { deletedAt: true, id: true },
      where: { id: orderId }
    });
    if (!order || order.deletedAt) {
      throw new NotFoundException("订单不存在。");
    }

    const delivery = await db.vehicleDelivery.findUnique({
      select: { deletedAt: true, id: true },
      where: { orderId }
    });

    return {
      handoverId,
      orderId,
      vehicleDeliveryId: handoverVehicleDeliveryId ?? (delivery && !delivery.deletedAt ? delivery.id : null)
    };
  }

  private findScopedItems(scope: {
    handoverId: string | null;
    orderId: string;
  }, db: DeliveryEvidenceDb = this.prisma) {
    return db.vehicleDeliveryEvidenceItem.findMany({
      include: evidenceItemInclude,
      orderBy: [{ evidenceType: "asc" }, { createdAt: "asc" }],
      where: {
        orderId: scope.orderId,
        ...(scope.handoverId
          ? { OR: [{ handoverId: null }, { handoverId: scope.handoverId }] }
          : {})
      }
    });
  }

  private async findItemOrThrow(itemId: string, db: DeliveryEvidenceDb = this.prisma) {
    const item = await db.vehicleDeliveryEvidenceItem.findFirst({
      include: evidenceItemInclude,
      where: { id: itemId }
    });
    if (!item) {
      throw new NotFoundException("交付证据项不存在。");
    }
    return item;
  }

  private async runMutation<T>(
    db: DeliveryEvidenceDb,
    callback: (transaction: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    if (db !== this.prisma) {
      return callback(db as Prisma.TransactionClient);
    }
    try {
      return await this.prisma.$transaction(callback, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable
      });
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: unknown }).code === "P2034"
      ) {
        throw new ConflictException("交付资料已被其他操作更新，请刷新后重试。");
      }
      throw error;
    }
  }

  private buildEvidenceItemCreateInput(scope: {
    handoverId: string | null;
    orderId: string;
    vehicleDeliveryId: string | null;
  }, definition: EvidenceDefinition): Prisma.VehicleDeliveryEvidenceItemCreateInput {
    return {
      allowsMultiple: definition.allowsMultiple,
      conditionKey: definition.conditionKey,
      conditionValue: definition.conditionValue,
      description: definition.description,
      evidenceType: definition.evidenceType,
      handover: scope.handoverId ? { connect: { id: scope.handoverId } } : undefined,
      isConditional: definition.isConditional,
      isRequired: definition.isRequired,
      metadata: toJsonValue({
        acceptance: definition.acceptance,
        allowedMediaTypes: definition.allowedMediaTypes,
        fileRequired: definition.fileRequired,
        seed: true
      }),
      order: { connect: { id: scope.orderId } },
      requirementLevel: definition.requirementLevel,
      status: DeliveryEvidenceStatus.NOT_STARTED,
      title: definition.title,
      vehicleDelivery: scope.vehicleDeliveryId ? { connect: { id: scope.vehicleDeliveryId } } : undefined
    };
  }

  private buildReadiness(scope: {
    handoverId: string | null;
    orderId: string;
  }, items: EvidenceItemWithFiles[], options?: {
    fieldState?: DeliveryEvidenceFieldState;
    mode?: EvidenceReadinessMode;
  }): DeliveryEvidenceReadiness {
    const blockingDetails: DeliveryEvidenceBlockingReason[] = [];
    const mode = options?.mode ?? "FIELD_COMPLETENESS";

    for (const definition of REQUIRED_FILE_EVIDENCE_DEFINITIONS) {
      const matching = items.filter((item) => item.evidenceType === definition.evidenceType);
      const blocking = mode === "OPS_REVIEW"
        ? evaluateFileEvidenceReadiness(definition, matching)
        : evaluateFileEvidenceFieldCompleteness(definition, matching);
      if (blocking) {
        blockingDetails.push(blocking);
      }
    }

    const damageBlocking = mode === "OPS_REVIEW"
      ? evaluateDamageReadiness(items)
      : evaluateDamageFieldCompleteness(items, options?.fieldState);
    if (damageBlocking) {
      blockingDetails.push(damageBlocking);
    }

    return {
      blockingDetails,
      blockingReasons: blockingDetails.map((detail) => detail.message),
      handoverId: scope.handoverId,
      orderId: scope.orderId,
      ready: blockingDetails.length === 0
    };
  }
}

export function assertDeliveryEvidenceReady(readiness: DeliveryEvidenceReadiness) {
  if (!readiness.ready) {
    throw new BadRequestException(readiness.blockingReasons[0] ?? DELIVERY_EVIDENCE_NOT_READY_MESSAGE);
  }
}

function evaluateFileEvidenceReadiness(
  definition: EvidenceDefinition,
  items: EvidenceItemWithFiles[]
): DeliveryEvidenceBlockingReason | null {
  if (items.some((item) => isApprovedWithAcceptableEvidenceFile(item, definition))) {
    return null;
  }
  if (items.length === 0 || items.every((item) => item.files.length === 0)) {
    return blocking("HANDOVER_EVIDENCE_MISSING", definition, `${definition.title} 尚未上传。`);
  }
  const rejected = items.find((item) =>
    item.status === DeliveryEvidenceStatus.REJECTED ||
    item.reviewStatus === DeliveryEvidenceReviewStatus.REJECTED
  );
  if (rejected) {
    return blocking("HANDOVER_EVIDENCE_REJECTED", definition, `${definition.title} 已驳回，请重新上传。`, rejected.id);
  }
  return blocking("HANDOVER_EVIDENCE_REVIEW_PENDING", definition, `${definition.title} 尚未审核通过。`, items[0]?.id);
}

function evaluateFileEvidenceFieldCompleteness(
  definition: EvidenceDefinition,
  items: EvidenceItemWithFiles[]
): DeliveryEvidenceBlockingReason | null {
  if (items.some((item) => !isRejectedEvidence(item) && hasAcceptableFile(item, definition))) {
    return null;
  }
  if (items.length === 0 || items.every((item) => item.files.length === 0)) {
    return blocking("HANDOVER_EVIDENCE_MISSING", definition, `${definition.title} 尚未上传。`);
  }
  const rejected = items.find(isRejectedEvidence);
  if (rejected) {
    return blocking("HANDOVER_EVIDENCE_REJECTED", definition, `${definition.title} 已驳回，请重新上传。`, rejected.id);
  }
  return null;
}

function evaluateDamageReadiness(items: EvidenceItemWithFiles[]): DeliveryEvidenceBlockingReason | null {
  const damageItems = items.filter((item) => item.evidenceType === DeliveryEvidenceType.DAMAGE_STATIC_CLOSEUP);
  const noDamageItems = items.filter(
    (item) => item.evidenceType === DeliveryEvidenceType.NO_VISIBLE_DAMAGE_DECLARATION
  );
  const damageDefinition = getDefinition(DeliveryEvidenceType.DAMAGE_STATIC_CLOSEUP);
  const noDamageDefinition = getDefinition(DeliveryEvidenceType.NO_VISIBLE_DAMAGE_DECLARATION);
  const damageDeclared = damageItems.some(isDamageDeclared);
  const damageApproved = damageItems.some((item) => isApprovedWithAcceptableEvidenceFile(item, damageDefinition));
  const noDamageApproved = noDamageItems.some(isApprovedNoDamageDeclaration);

  if (damageDeclared && noDamageApproved) {
    return blocking(
      "DAMAGE_STATE_CONFLICT",
      damageDefinition,
      "损伤证据与无可见损伤声明冲突，请保留一种交付损伤状态。"
    );
  }

  if (damageDeclared) {
    if (damageApproved) {
      return null;
    }
    const rejected = damageItems.find((item) =>
      item.status === DeliveryEvidenceStatus.REJECTED ||
      item.reviewStatus === DeliveryEvidenceReviewStatus.REJECTED
    );
    if (rejected) {
      return blocking("DAMAGE_EVIDENCE_REJECTED", damageDefinition, "损伤近拍已驳回，请重新上传。", rejected.id);
    }
    const pending = damageItems.find((item) => item.files.length > 0);
    if (pending) {
      return blocking("DAMAGE_EVIDENCE_REVIEW_PENDING", damageDefinition, "损伤近拍尚未审核通过。", pending.id);
    }
    return blocking("DAMAGE_EVIDENCE_MISSING", damageDefinition, "已声明存在损伤，请上传损伤/瑕疵静止近拍。");
  }

  if (noDamageApproved) {
    return null;
  }

  const rejectedDeclaration = noDamageItems.find((item) =>
    item.status === DeliveryEvidenceStatus.REJECTED ||
    item.reviewStatus === DeliveryEvidenceReviewStatus.REJECTED
  );
  if (rejectedDeclaration) {
    return blocking(
      "DAMAGE_EVIDENCE_REJECTED",
      noDamageDefinition,
      "无可见损伤声明已驳回，请重新处理损伤状态。",
      rejectedDeclaration.id
    );
  }
  const pendingDeclaration = noDamageItems.find((item) => item.declaredNoDamage === true);
  if (pendingDeclaration) {
    return blocking(
      "DAMAGE_EVIDENCE_REVIEW_PENDING",
      noDamageDefinition,
      "无可见损伤声明尚未审核通过。",
      pendingDeclaration.id
    );
  }
  return blocking("DAMAGE_EVIDENCE_MISSING", noDamageDefinition, "请声明无可见损伤或上传损伤近拍证据。");
}

function evaluateDamageFieldCompleteness(
  items: EvidenceItemWithFiles[],
  fieldState?: DeliveryEvidenceFieldState
): DeliveryEvidenceBlockingReason | null {
  const damageItems = items.filter((item) => item.evidenceType === DeliveryEvidenceType.DAMAGE_STATIC_CLOSEUP);
  const noDamageItems = items.filter(
    (item) => item.evidenceType === DeliveryEvidenceType.NO_VISIBLE_DAMAGE_DECLARATION
  );
  const damageDefinition = getDefinition(DeliveryEvidenceType.DAMAGE_STATIC_CLOSEUP);
  const noDamageDefinition = getDefinition(DeliveryEvidenceType.NO_VISIBLE_DAMAGE_DECLARATION);
  const damageDeclared = fieldState?.damageDeclared === true ||
    (fieldState?.damageDeclared !== false && damageItems.some(isDamageDeclared));
  const noDamageDeclared = fieldState?.noVisibleDamageDeclared === true ||
    (
      fieldState?.noVisibleDamageDeclared !== false &&
      noDamageItems.some((item) => item.declaredNoDamage === true && !isRejectedEvidence(item))
    );

  if (damageDeclared && noDamageDeclared) {
    return blocking(
      "DAMAGE_STATE_CONFLICT",
      damageDefinition,
      "损伤证据与无可见损伤声明冲突，请保留一种交付损伤状态。"
    );
  }

  if (damageDeclared) {
    if (damageItems.some((item) => !isRejectedEvidence(item) && hasAcceptableFile(item, damageDefinition))) {
      return null;
    }
    const rejected = damageItems.find(isRejectedEvidence);
    if (rejected) {
      return blocking("DAMAGE_EVIDENCE_REJECTED", damageDefinition, "损伤近拍已驳回，请重新上传。", rejected.id);
    }
    return blocking("DAMAGE_EVIDENCE_MISSING", damageDefinition, "已声明存在损伤，请上传损伤/瑕疵静态近拍。");
  }

  if (noDamageDeclared) {
    return null;
  }

  const rejectedDeclaration = noDamageItems.find(isRejectedEvidence);
  if (rejectedDeclaration) {
    return blocking(
      "DAMAGE_EVIDENCE_REJECTED",
      noDamageDefinition,
      "无可见损伤声明已驳回，请重新处理损伤状态。",
      rejectedDeclaration.id
    );
  }
  return blocking("DAMAGE_EVIDENCE_MISSING", noDamageDefinition, "请声明无可见损伤或上传损伤近拍证据。");
}

function isApprovedWithAcceptableEvidenceFile(item: EvidenceItemWithFiles, definition: EvidenceDefinition) {
  return item.status === DeliveryEvidenceStatus.APPROVED &&
    item.reviewStatus === DeliveryEvidenceReviewStatus.APPROVED &&
    hasAcceptableFile(item, definition);
}

function isApprovedNoDamageDeclaration(item: EvidenceItemWithFiles) {
  return item.declaredNoDamage === true &&
    item.status === DeliveryEvidenceStatus.APPROVED &&
    item.reviewStatus === DeliveryEvidenceReviewStatus.APPROVED;
}

function isRejectedEvidence(item: EvidenceItemWithFiles) {
  return item.status === DeliveryEvidenceStatus.REJECTED ||
    item.reviewStatus === DeliveryEvidenceReviewStatus.REJECTED;
}

function hasAcceptableFile(item: EvidenceItemWithFiles, definition: EvidenceDefinition) {
  if (!definition.fileRequired) {
    return true;
  }
  return item.files.some((file) => definition.allowedMediaTypes.includes(file.mediaType));
}

function isDamageDeclared(item: EvidenceItemWithFiles) {
  return item.evidenceType === DeliveryEvidenceType.DAMAGE_STATIC_CLOSEUP &&
    (
      readBoolean(item.metadata, "damageDeclared") === true ||
      item.files.length > 0 ||
      item.status !== DeliveryEvidenceStatus.NOT_STARTED ||
      item.reviewStatus !== DeliveryEvidenceReviewStatus.NOT_STARTED
    );
}

function blocking(
  code: DeliveryEvidenceBlockingCode,
  definition: EvidenceDefinition,
  message: string,
  itemId?: string
): DeliveryEvidenceBlockingReason {
  return {
    code,
    evidenceType: definition.evidenceType,
    itemId,
    message
  };
}

function assertFileAllowed(definition: EvidenceDefinition, mediaType: DeliveryEvidenceMediaType) {
  if (!definition.fileRequired) {
    throw new BadRequestException("该交付证据项不需要上传文件。");
  }
  if (!definition.allowedMediaTypes.includes(mediaType)) {
    throw new BadRequestException("文件类型不符合该交付证据项要求。");
  }
}

function assertEvidenceFileCapacity(definition: EvidenceDefinition, activeFileCount: number) {
  if (!definition.allowsMultiple && activeFileCount > 0) {
    throw new BadRequestException("该交付证据项只允许关联一个文件。");
  }
  if (
    definition.evidenceType === DeliveryEvidenceType.DAMAGE_STATIC_CLOSEUP &&
    activeFileCount >= MAX_DAMAGE_CLOSEUP_FILES
  ) {
    throw new BadRequestException(`损伤近拍最多上传 ${MAX_DAMAGE_CLOSEUP_FILES} 个文件。`);
  }
}

function getDefinition(evidenceType: DeliveryEvidenceType) {
  const definition = DEFINITION_BY_TYPE.get(evidenceType);
  if (!definition) {
    throw new BadRequestException(`Unsupported delivery evidence type: ${evidenceType}`);
  }
  return definition;
}

function toEvidenceItemView(item: EvidenceItemWithFiles) {
  const definition = getDefinition(item.evidenceType);
  return {
    allowsMultiple: item.allowsMultiple,
    allowedMediaTypes: definition.allowedMediaTypes,
    conditionKey: item.conditionKey,
    conditionValue: item.conditionValue,
    declaredNoDamage: item.declaredNoDamage,
    description: item.description,
    evidenceType: item.evidenceType,
    fileRequired: definition.fileRequired,
    files: item.files.map((file) => ({
      file: file.file
        ? {
            id: file.file.id,
            mimeType: file.file.mimeType,
            objectKey: file.file.objectKey,
            originalName: file.file.originalName,
            sizeBytes: Number(file.file.sizeBytes)
          }
        : null,
      fileId: file.fileId,
      id: file.id,
      lifecycleStatus: file.lifecycleStatus,
      mediaType: file.mediaType,
      objectKey: file.objectKey,
      uploadedAt: file.uploadedAt,
      uploadedBy: file.uploader
    })),
    handoverId: item.handoverId,
    id: item.id,
    isConditional: item.isConditional,
    isRequired: item.isRequired,
    metadata: item.metadata,
    orderId: item.orderId,
    rejectionReason: item.rejectionReason,
    requirementLevel: item.requirementLevel,
    reviewedAt: item.reviewedAt,
    reviewedBy: item.reviewer,
    reviewStatus: item.reviewStatus,
    status: item.status,
    title: item.title,
    vehicleDeliveryId: item.vehicleDeliveryId
  };
}

function readBoolean(value: unknown, key: string) {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  return typeof value[key] === "boolean" ? value[key] : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeRequiredText(value: string | undefined, message: string) {
  const normalized = value?.trim();
  if (!normalized) {
    throw new BadRequestException(message);
  }
  return normalized;
}

function normalizeOptionalText(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function toJsonValue(value: unknown) {
  return value === undefined ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}
