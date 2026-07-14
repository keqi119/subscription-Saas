import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  ApplicationActionType,
  ApplicationMaterialType,
  ApplicationSource,
  ApplicationStatus,
  CustomerProfileMaterial,
  CustomerProfileMaterialStatus,
  Prisma
} from "@prisma/client";

import { MaterialPreview, UploadedMaterialFile } from "../customer/customer.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { CurrentCustomer } from "./portal-auth.types";
import {
  UpdatePortalProfileMaterialDto,
  UploadPortalProfileMaterialDto
} from "./portal-profile-material.dto";
import {
  buildCustomerProfileMaterialCompleteness,
  CUSTOMER_PROFILE_MATERIAL_REQUIREMENTS,
  CUSTOMER_PROFILE_MATERIAL_STATUS_LABELS,
  getCustomerProfileMaterialLabel,
  isAllowedCustomerProfileMaterialMimeType,
  toApplicationMaterialType
} from "./portal-profile-materials";

@Injectable()
export class PortalProfileMaterialService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService
  ) {}

  getRequirements() {
    return CUSTOMER_PROFILE_MATERIAL_REQUIREMENTS.map((requirement) => ({
      ...requirement,
      label: requirement.label
    }));
  }

  async listMaterials(currentCustomer: CurrentCustomer) {
    const materials = await this.prisma.customerProfileMaterial.findMany({
      orderBy: [{ materialType: "asc" }, { createdAt: "desc" }],
      where: {
        customerId: currentCustomer.customerId,
        deletedAt: null
      }
    });

    return materials.map(toPortalProfileMaterialView);
  }

  async getCompleteness(currentCustomer: CurrentCustomer) {
    return this.getCompletenessForCustomer(currentCustomer.customerId);
  }

  async getCompletenessForCustomer(customerId: string) {
    const materials = await this.prisma.customerProfileMaterial.findMany({
      select: {
        deletedAt: true,
        materialStatus: true,
        materialType: true
      },
      where: {
        customerId,
        deletedAt: null
      }
    });

    return buildCustomerProfileMaterialCompleteness(materials);
  }

  async uploadMaterial(
    dto: UploadPortalProfileMaterialDto,
    files: UploadedMaterialFile[] | undefined,
    currentCustomer: CurrentCustomer
  ) {
    const file = (files ?? []).find((item) => item.buffer?.length);
    if (!file) {
      throw new BadRequestException("请选择要上传的资料文件。");
    }
    assertSupportedProfileMaterialFile(file);

    const storage = await this.storageService.putCustomerProfileMaterial({
      buffer: file.buffer,
      contentType: file.mimetype,
      customerId: currentCustomer.customerId,
      originalName: file.originalname
    });

    const material = await this.prisma.$transaction(async (tx) => {
      await tx.customerProfileMaterial.updateMany({
        data: {
          materialStatus: CustomerProfileMaterialStatus.REPLACED
        },
        where: {
          customerId: currentCustomer.customerId,
          deletedAt: null,
          materialStatus: CustomerProfileMaterialStatus.ACTIVE,
          materialType: dto.materialType
        }
      });

      const material = await tx.customerProfileMaterial.create({
        data: {
          bucket: storage.bucket,
          customerId: currentCustomer.customerId,
          fileName: file.originalname,
          fileSize: file.size,
          materialStatus: CustomerProfileMaterialStatus.ACTIVE,
          materialType: dto.materialType,
          mimeType: file.mimetype,
          objectKey: storage.objectKey,
          originalName: file.originalname,
          remark: normalizeOptionalText(dto.remark),
          snapshot: {
            customerAccountId: currentCustomer.customerAccountId,
            label: getCustomerProfileMaterialLabel(dto.materialType),
            source: "PORTAL_PROFILE_MATERIAL_CENTER",
            uploadedAt: new Date().toISOString()
          }
        }
      });

      await this.projectProfileMaterialToActiveApplications(tx, material, currentCustomer);
      return material;
    });

    return toPortalProfileMaterialView(material);
  }

  async updateMaterial(
    id: string,
    dto: UpdatePortalProfileMaterialDto,
    currentCustomer: CurrentCustomer
  ) {
    const before = await this.findOwnedMaterialOrThrow(id, currentCustomer.customerId);
    const materialStatus = dto.materialStatus ?? before.materialStatus;

    const material = await this.prisma.$transaction(async (tx) => {
      if (
        materialStatus === CustomerProfileMaterialStatus.ACTIVE &&
        before.materialStatus !== CustomerProfileMaterialStatus.ACTIVE
      ) {
        await tx.customerProfileMaterial.updateMany({
          data: { materialStatus: CustomerProfileMaterialStatus.REPLACED },
          where: {
            customerId: currentCustomer.customerId,
            deletedAt: null,
            id: { not: id },
            materialStatus: CustomerProfileMaterialStatus.ACTIVE,
            materialType: before.materialType
          }
        });
      }

      return tx.customerProfileMaterial.update({
        data: {
          deletedAt: materialStatus === CustomerProfileMaterialStatus.ARCHIVED ? new Date() : before.deletedAt,
          materialStatus,
          remark: dto.remark === undefined ? before.remark : normalizeOptionalText(dto.remark)
        },
        where: { id }
      });
    });

    return toPortalProfileMaterialView(material);
  }

  async deleteMaterial(id: string, currentCustomer: CurrentCustomer) {
    await this.findOwnedMaterialOrThrow(id, currentCustomer.customerId);
    const material = await this.prisma.customerProfileMaterial.update({
      data: {
        deletedAt: new Date(),
        materialStatus: CustomerProfileMaterialStatus.ARCHIVED
      },
      where: { id }
    });

    return toPortalProfileMaterialView(material);
  }

  async previewMaterial(id: string, currentCustomer: CurrentCustomer): Promise<MaterialPreview> {
    const material = await this.findOwnedMaterialOrThrow(id, currentCustomer.customerId);
    if (!material.bucket || !material.objectKey) {
      throw new NotFoundException("资料文件不存在。");
    }

    const storedObject = await this.storageService.getCustomerProfileMaterialStream(
      material.bucket,
      material.objectKey
    );

    return {
      filename: material.originalName ?? material.fileName,
      mimeType: material.mimeType ?? storedObject.contentType,
      sizeBytes: storedObject.contentLength ?? material.fileSize ?? 0,
      stream: storedObject.stream
    };
  }

  private async findOwnedMaterialOrThrow(id: string, customerId: string) {
    const material = await this.prisma.customerProfileMaterial.findFirst({
      where: {
        customerId,
        deletedAt: null,
        id
      }
    });

    if (!material) {
      throw new NotFoundException("资料不存在。");
    }

    return material;
  }

  private async projectProfileMaterialToActiveApplications(
    tx: Prisma.TransactionClient,
    material: CustomerProfileMaterial,
    currentCustomer: CurrentCustomer
  ) {
    if (!material.bucket || !material.objectKey) {
      return;
    }

    const applications = await tx.application.findMany({
      select: {
        id: true,
        salesUserId: true,
        status: true
      },
      where: {
        applicationSource: ApplicationSource.SELF_SERVICE,
        customerId: currentCustomer.customerId,
        deletedAt: null,
        status: { in: PORTAL_PROFILE_MATERIAL_SYNC_APPLICATION_STATUSES }
      }
    });

    if (applications.length === 0) {
      return;
    }

    const applicationMaterialType = toApplicationMaterialType(material.materialType);
    const label = getCustomerProfileMaterialLabel(material.materialType);
    const originalName = material.originalName ?? material.fileName;
    const fileName = `客户资料中心 - ${label} - ${originalName}`;

    for (const application of applications) {
      const materialGroup = await tx.applicationMaterialGroup.upsert({
        create: {
          applicationId: application.id,
          createdBy: application.salesUserId,
          materialName: APPLICATION_MATERIAL_LABELS[applicationMaterialType],
          materialType: applicationMaterialType,
          required: REQUIRED_APPLICATION_MATERIAL_TYPES.includes(applicationMaterialType),
          updatedBy: application.salesUserId
        },
        update: {
          materialName: APPLICATION_MATERIAL_LABELS[applicationMaterialType],
          required: REQUIRED_APPLICATION_MATERIAL_TYPES.includes(applicationMaterialType),
          updatedBy: application.salesUserId
        },
        where: {
          applicationId_materialType: {
            applicationId: application.id,
            materialType: applicationMaterialType
          }
        }
      });

      const fileObject = await tx.fileObject.create({
        data: {
          bucket: material.bucket,
          mimeType: material.mimeType,
          objectKey: material.objectKey,
          originalName,
          sizeBytes: BigInt(material.fileSize ?? 0),
          uploadedBy: application.salesUserId
        }
      });

      const materialFile = await tx.applicationMaterialFile.create({
        data: {
          applicationId: application.id,
          createdBy: application.salesUserId,
          fileId: fileObject.id,
          fileName,
          materialGroupId: materialGroup.id,
          materialType: applicationMaterialType,
          mimeType: material.mimeType,
          sizeBytes: BigInt(material.fileSize ?? 0),
          updatedBy: application.salesUserId,
          uploadedBy: application.salesUserId
        }
      });

      await tx.applicationActionLog.create({
        data: {
          actionType: ApplicationActionType.UPLOAD_MATERIAL_FILE,
          applicationId: application.id,
          comment: `来自客户资料中心：${label} - ${originalName}`,
          createdBy: application.salesUserId,
          materialFileId: materialFile.id,
          materialGroupId: materialGroup.id,
          operatorId: application.salesUserId,
          operatorName: `客户门户 ${maskPhone(currentCustomer.phone)}`,
          toStatus: application.status,
          updatedBy: application.salesUserId
        }
      });
    }
  }
}

function toPortalProfileMaterialView(material: CustomerProfileMaterial) {
  return {
    createdAt: material.createdAt,
    fileName: material.fileName,
    fileSize: material.fileSize,
    id: material.id,
    label: getCustomerProfileMaterialLabel(material.materialType),
    materialStatus: material.materialStatus,
    materialStatusLabel: CUSTOMER_PROFILE_MATERIAL_STATUS_LABELS[material.materialStatus],
    materialType: material.materialType,
    mimeType: material.mimeType,
    originalName: material.originalName,
    previewUrl: `/api/portal/profile/materials/${material.id}/preview`,
    remark: material.remark,
    updatedAt: material.updatedAt
  };
}

function assertSupportedProfileMaterialFile(file: UploadedMaterialFile) {
  if (file.mimetype?.startsWith("video/") || file.mimetype?.startsWith("audio/")) {
    throw new BadRequestException("客户资料中心暂不支持视频或音频文件。");
  }

  if (!isAllowedCustomerProfileMaterialMimeType(file.mimetype)) {
    throw new BadRequestException("客户资料中心仅支持图片或 PDF 文件。");
  }
}

function normalizeOptionalText(value?: string | null) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function maskPhone(phone: string) {
  return phone.replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

const APPLICATION_MATERIAL_LABELS: Record<ApplicationMaterialType, string> = {
  BANK_FLOW: "银行流水",
  CREDIT_AUTH: "征信授权",
  DRIVER_LICENSE: "驾驶证",
  ID_CARD: "身份证",
  OTHER: "其他",
  RESIDENCE_PROOF: "居住证明",
  WORK_PROOF: "工作证明"
};

const PORTAL_PROFILE_MATERIAL_SYNC_APPLICATION_STATUSES: ApplicationStatus[] = [
  ApplicationStatus.SUBMITTED,
  ApplicationStatus.NEED_MORE_INFO
];

const REQUIRED_APPLICATION_MATERIAL_TYPES: ApplicationMaterialType[] = [
  ApplicationMaterialType.ID_CARD,
  ApplicationMaterialType.DRIVER_LICENSE
];
