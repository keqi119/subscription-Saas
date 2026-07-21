import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  ContractStatus,
  DeliveryHandoverArchiveStatus,
  DeliveryHandoverStatus,
  Prisma
} from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";

export const STAGE2_DELIVERY_HANDOVER_SIGNING_STAGE = "STAGE2_DELIVERY_HANDOVER" as const;
export const STAGE2_HANDOVER_CUSTOMER_SLOT_ID = "STAGE2_HANDOVER_CUSTOMER" as const;
export const STAGE2_HANDOVER_PLATFORM_SLOT_ID = "STAGE2_HANDOVER_PLATFORM" as const;
export const DELIVERY_HANDOVER_ARCHIVE_REQUIRED = true;
export const DELIVERY_HANDOVER_NOT_READY_MESSAGE = "交付交接确认书尚未完成签署和归档。";

const TERMINAL_HANDOVER_STATUSES = [
  DeliveryHandoverStatus.CANCELLED,
  DeliveryHandoverStatus.FAILED
] as const;

type DeliveryHandoverRecord = Prisma.VehicleDeliveryHandoverGetPayload<object>;

@Injectable()
export class DeliveryHandoverService {
  constructor(private readonly prisma: PrismaService) {}

  async getOrCreateDraftHandover(orderId: string, actorId?: string) {
    const existing = await this.findActiveHandover(orderId);
    if (existing) {
      return existing;
    }

    return this.createHandoverRecord(orderId, actorId);
  }

  async validateStage2Prerequisites(orderId: string) {
    const order = await this.prisma.subscriptionOrder.findUnique({
      include: {
        contract: true,
        deliveries: {
          orderBy: { createdAt: "desc" },
          take: 1,
          where: { deletedAt: null }
        }
      },
      where: { id: orderId }
    });

    if (!order || order.deletedAt) {
      throw new NotFoundException("订单不存在。");
    }
    if (!order.contract || order.contract.deletedAt || order.contract.status !== ContractStatus.SIGNED) {
      throw new BadRequestException("Stage 1 合同尚未签署，不能创建交付交接签署。");
    }

    return {
      orderId: order.id,
      stage1ContractId: order.contract.id,
      vehicleDeliveryId: order.deliveries?.[0]?.id ?? null
    };
  }

  async linkStage1Contract(orderId: string) {
    return (await this.validateStage2Prerequisites(orderId)).stage1ContractId;
  }

  async createHandoverRecord(orderId: string, actorId?: string) {
    const existing = await this.findActiveHandover(orderId);
    if (existing) {
      throw new BadRequestException("该订单已存在进行中的交付交接签署记录。");
    }

    const prerequisites = await this.validateStage2Prerequisites(orderId);
    return this.prisma.vehicleDeliveryHandover.create({
      data: {
        archiveStatus: DeliveryHandoverArchiveStatus.NOT_STARTED,
        createdBy: actorId,
        orderId,
        snapshot: toJsonValue({
          archiveRequired: DELIVERY_HANDOVER_ARCHIVE_REQUIRED,
          stage1ContractId: prerequisites.stage1ContractId
        }),
        stage1ContractId: prerequisites.stage1ContractId,
        status: DeliveryHandoverStatus.DRAFT,
        updatedBy: actorId,
        vehicleDeliveryId: prerequisites.vehicleDeliveryId
      }
    });
  }

  async markSourceGenerated(id: string, input: {
    handoverContractId?: string | null;
    sourceDocumentFileId?: string | null;
    sourceObjectKey?: string | null;
    updatedBy?: string;
  }) {
    return this.prisma.vehicleDeliveryHandover.update({
      data: {
        handoverContractId: input.handoverContractId,
        sourceDocumentFileId: input.sourceDocumentFileId,
        sourceObjectKey: input.sourceObjectKey,
        status: DeliveryHandoverStatus.SOURCE_GENERATED,
        updatedBy: input.updatedBy
      },
      where: { id }
    });
  }

  async markSigningStarted(id: string, input: {
    handoverESignTaskId?: string | null;
    updatedBy?: string;
  }) {
    return this.prisma.vehicleDeliveryHandover.update({
      data: {
        handoverESignTaskId: input.handoverESignTaskId,
        status: DeliveryHandoverStatus.PENDING_CUSTOMER_SIGNATURE,
        updatedBy: input.updatedBy
      },
      where: { id }
    });
  }

  async markCustomerSigned(id: string, signedAt: Date, actorId?: string) {
    return this.prisma.vehicleDeliveryHandover.update({
      data: {
        customerSignedAt: signedAt,
        status: DeliveryHandoverStatus.PENDING_PLATFORM_SEAL,
        updatedBy: actorId
      },
      where: { id }
    });
  }

  async markPlatformSigned(id: string, signedAt: Date, actorId?: string) {
    return this.prisma.vehicleDeliveryHandover.update({
      data: {
        platformSignedAt: signedAt,
        updatedBy: actorId
      },
      where: { id }
    });
  }

  async markCompleted(id: string, completedAt: Date, actorId?: string) {
    return this.prisma.vehicleDeliveryHandover.update({
      data: {
        completedAt,
        status: DeliveryHandoverStatus.SIGNED,
        updatedBy: actorId
      },
      where: { id }
    });
  }

  async markArchived(id: string, input: {
    archivedAt: Date;
    signedDocumentFileId?: string | null;
    signedObjectKey?: string | null;
    updatedBy?: string;
  }) {
    return this.prisma.vehicleDeliveryHandover.update({
      data: {
        archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
        archivedAt: input.archivedAt,
        signedDocumentFileId: input.signedDocumentFileId,
        signedObjectKey: input.signedObjectKey,
        status: DeliveryHandoverStatus.ARCHIVED,
        updatedBy: input.updatedBy
      },
      where: { id }
    });
  }

  async markFailed(id: string, failureReason: string, actorId?: string) {
    return this.prisma.vehicleDeliveryHandover.update({
      data: {
        archiveStatus: DeliveryHandoverArchiveStatus.FAILED,
        failedAt: new Date(),
        failureReason,
        status: DeliveryHandoverStatus.FAILED,
        updatedBy: actorId
      },
      where: { id }
    });
  }

  async markCancelled(id: string, actorId?: string) {
    return this.prisma.vehicleDeliveryHandover.update({
      data: {
        cancelledAt: new Date(),
        status: DeliveryHandoverStatus.CANCELLED,
        updatedBy: actorId
      },
      where: { id }
    });
  }

  async assertDeliveryCanBeConfirmed(orderId: string) {
    const handover = await this.findActiveHandover(orderId);
    assertDeliveryHandoverReadyForDelivery(handover);
  }

  private findActiveHandover(orderId: string) {
    return this.prisma.vehicleDeliveryHandover.findFirst({
      orderBy: { createdAt: "desc" },
      where: {
        deletedAt: null,
        orderId,
        status: { notIn: [...TERMINAL_HANDOVER_STATUSES] }
      }
    });
  }
}

export function assertDeliveryHandoverReadyForDelivery(handover: DeliveryHandoverRecord | null | undefined) {
  if (!isDeliveryHandoverReadyForDelivery(handover)) {
    throw new BadRequestException(DELIVERY_HANDOVER_NOT_READY_MESSAGE);
  }
}

export function isDeliveryHandoverReadyForDelivery(handover: Pick<
  DeliveryHandoverRecord,
  "archiveStatus" | "deletedAt" | "status"
> | null | undefined) {
  if (!handover || handover.deletedAt) {
    return false;
  }
  const signed = handover.status === DeliveryHandoverStatus.SIGNED ||
    handover.status === DeliveryHandoverStatus.ARCHIVED;
  if (!signed) {
    return false;
  }
  return !DELIVERY_HANDOVER_ARCHIVE_REQUIRED ||
    handover.archiveStatus === DeliveryHandoverArchiveStatus.ARCHIVED;
}

export function isDeliveryHandoverSigned(handover: Pick<DeliveryHandoverRecord, "deletedAt" | "status"> | null | undefined) {
  return Boolean(
    handover &&
      !handover.deletedAt &&
      (handover.status === DeliveryHandoverStatus.SIGNED || handover.status === DeliveryHandoverStatus.ARCHIVED)
  );
}

export function isDeliveryHandoverArchived(
  handover: Pick<DeliveryHandoverRecord, "archiveStatus" | "deletedAt"> | null | undefined
) {
  return Boolean(
    handover &&
      !handover.deletedAt &&
      handover.archiveStatus === DeliveryHandoverArchiveStatus.ARCHIVED
  );
}

function toJsonValue(value: unknown) {
  return value === undefined ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}
