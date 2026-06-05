import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ApplicationActionType,
  ApplicationMaterialType,
  ApplicationStatus,
  AuditAction,
  CustomerStatus,
  MaterialStatus,
  Prisma
} from "@prisma/client";
import { PermissionCode } from "@subscription-saas/shared";
import { randomUUID } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { createBusinessNo, withUniqueBusinessNoRetry } from "../common/business-number";
import { PrismaService } from "../prisma/prisma.service";
import { RiskService, riskResultInclude, toRiskResultView } from "../risk/risk.service";
import {
  ApproveApplicationDto,
  NeedMoreInfoDto,
  RejectApplicationDto,
  SubmitApplicationDto
} from "./dto/application-review.dto";
import { CreateApplicationDto } from "./dto/create-application.dto";
import {
  CreateCustomerDto,
  CustomerIdentityDto,
  CustomerProfileDto
} from "./dto/create-customer.dto";
import { CreateFollowupDto } from "./dto/create-followup.dto";
import {
  CreateMaterialDto,
  DeleteMaterialFileDto,
  ReviewMaterialDto
} from "./dto/create-material.dto";
import { UpdateApplicationDto } from "./dto/update-application.dto";
import { UpdateCustomerDto } from "./dto/update-customer.dto";

const customerInclude = {
  applications: {
    orderBy: { createdAt: "desc" as const },
    where: { deletedAt: null }
  },
  identity: true,
  ownerUser: {
    select: { id: true, name: true, username: true }
  },
  profile: true
} satisfies Prisma.CustomerInclude;

const materialInclude = {
  file: {
    include: {
      uploader: {
        select: { id: true, name: true, username: true }
      }
    }
  },
  reviewer: {
    select: { id: true, name: true, username: true }
  }
} satisfies Prisma.ApplicationMaterialInclude;

const materialGroupInclude = {
  files: {
    include: {
      file: true,
      uploader: {
        select: { id: true, name: true, username: true }
      },
      deleter: {
        select: { id: true, name: true, username: true }
      }
    },
    orderBy: { uploadedAt: "desc" as const }
  },
  reviewer: {
    select: { id: true, name: true, username: true }
  }
} satisfies Prisma.ApplicationMaterialGroupInclude;

const materialFileInclude = {
  file: true,
  uploader: {
    select: { id: true, name: true, username: true }
  },
  deleter: {
    select: { id: true, name: true, username: true }
  }
} satisfies Prisma.ApplicationMaterialFileInclude;

const applicationInclude = {
  customer: {
    select: {
      customerNo: true,
      id: true,
      identity: true,
      mobile: true,
      name: true,
      ownerUserId: true,
      profile: true,
      sourceChannel: true,
      status: true
    }
  },
  materials: {
    include: materialInclude,
    orderBy: { createdAt: "desc" as const },
    where: { deletedAt: null }
  },
  materialGroups: {
    include: materialGroupInclude,
    orderBy: { materialType: "asc" as const },
    where: { deletedAt: null }
  },
  riskResults: {
    include: riskResultInclude,
    orderBy: { createdAt: "desc" as const },
    where: { deletedAt: null }
  },
  orders: {
    orderBy: { createdAt: "desc" as const },
    select: { deletedAt: true, id: true, orderNo: true, orderStatus: true },
    where: { deletedAt: null }
  },
  salesUser: {
    select: { id: true, name: true, username: true }
  },
  actionLogs: {
    include: {
      material: {
        select: {
          id: true,
          materialName: true,
          materialType: true
        }
      },
      materialFile: {
        select: {
          fileName: true,
          id: true,
          materialType: true
        }
      },
      materialGroup: {
        select: {
          id: true,
          materialName: true,
          materialType: true
        }
      },
      operator: {
        select: { id: true, name: true, username: true }
      }
    },
    orderBy: { createdAt: "desc" as const },
    where: { deletedAt: null }
  }
} satisfies Prisma.ApplicationInclude;

type CustomerWithDetails = Prisma.CustomerGetPayload<{ include: typeof customerInclude }>;
type ApplicationWithDetails = Prisma.ApplicationGetPayload<{ include: typeof applicationInclude }>;
type Tx = Prisma.TransactionClient;

export interface UploadedMaterialFile {
  buffer: Buffer;
  mimetype?: string;
  originalname: string;
  size: number;
}

export interface MaterialPreview {
  filename: string;
  mimeType?: string | null;
  sizeBytes: number;
  stream: ReadStream;
}

@Injectable()
export class CustomerService {
  constructor(
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly riskService: RiskService
  ) {}

  async listCustomers(user: RequestUser) {
    const customers = await this.prisma.customer.findMany({
      include: customerInclude,
      orderBy: { createdAt: "desc" },
      where: this.customerScopeWhere(user)
    });

    return customers.map(toCustomerView);
  }

  async createCustomer(dto: CreateCustomerDto, user: RequestUser, context: RequestContext) {
    const hasFullScope = canViewAll(user);
    const ownerUserId = hasFullScope && dto.ownerUserId ? dto.ownerUserId : user.id;
    const customer = await withUniqueBusinessNoRetry(() => this.prisma.$transaction(async (tx) => {
      const created = await tx.customer.create({
        data: {
          createdBy: user.id,
          customerNo: createBusinessNo("CUS"),
          customerType: dto.customerType,
          grade: hasFullScope ? dto.grade : undefined,
          mobile: dto.mobile,
          name: dto.name,
          ownerUserId,
          remark: dto.remark,
          sourceChannel: dto.sourceChannel,
          status: hasFullScope ? (dto.status ?? CustomerStatus.LEAD) : CustomerStatus.LEAD,
          updatedBy: user.id
        }
      });

      if (dto.identity) {
        await tx.customerIdentity.create({
          data: {
            ...identityData(dto.identity),
            createdBy: user.id,
            customerId: created.id,
            updatedBy: user.id
          }
        });
      }

      if (dto.profile) {
        await tx.customerProfile.create({
          data: {
            ...profileData(dto.profile),
            createdBy: user.id,
            customerId: created.id,
            updatedBy: user.id
          }
        });
      }

      return tx.customer.findUniqueOrThrow({
        include: customerInclude,
        where: { id: created.id }
      });
    }));

    await this.auditService.write({
      action: AuditAction.CREATE,
      after: toCustomerView(customer),
      entityId: customer.id,
      entityType: "customer",
      ipAddress: context.ipAddress,
      module: "customer",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toCustomerView(customer);
  }

  async getCustomer(id: string, user: RequestUser) {
    const customer = await this.findCustomerOrThrow(id);
    ensureCanAccessCustomer(customer, user);
    return toCustomerView(customer);
  }

  async updateCustomer(
    id: string,
    dto: UpdateCustomerDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.findCustomerOrThrow(id);
    ensureCanAccessCustomer(before, user);

    const hasFullScope = canViewAll(user);
    const ownerUserId = hasFullScope ? (dto.ownerUserId ?? before.ownerUserId) : before.ownerUserId;
    const customer = await this.prisma.$transaction(async (tx) => {
      await tx.customer.update({
        data: {
          customerType: dto.customerType,
          grade: hasFullScope ? dto.grade : undefined,
          mobile: dto.mobile,
          name: dto.name,
          ownerUserId,
          remark: dto.remark,
          sourceChannel: dto.sourceChannel,
          status: hasFullScope ? dto.status : undefined,
          updatedBy: user.id
        },
        where: { id }
      });

      if (dto.identity) {
        await tx.customerIdentity.upsert({
          create: {
            ...identityData(dto.identity),
            createdBy: user.id,
            customerId: id,
            updatedBy: user.id
          },
          update: {
            ...identityData(dto.identity),
            updatedBy: user.id
          },
          where: { customerId: id }
        });
      }

      if (dto.profile) {
        await tx.customerProfile.upsert({
          create: {
            ...profileData(dto.profile),
            createdBy: user.id,
            customerId: id,
            updatedBy: user.id
          },
          update: {
            ...profileData(dto.profile),
            updatedBy: user.id
          },
          where: { customerId: id }
        });
      }

      return tx.customer.findUniqueOrThrow({
        include: customerInclude,
        where: { id }
      });
    });

    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: toCustomerView(customer),
      before: toCustomerView(before),
      entityId: id,
      entityType: "customer",
      ipAddress: context.ipAddress,
      module: "customer",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toCustomerView(customer);
  }

  async listFollowups(customerId: string, user: RequestUser) {
    const customer = await this.findCustomerOrThrow(customerId);
    ensureCanAccessCustomer(customer, user);

    return this.prisma.customerFollowup.findMany({
      include: {
        followupUser: {
          select: { id: true, name: true, username: true }
        }
      },
      orderBy: { createdAt: "desc" },
      where: { customerId, deletedAt: null }
    });
  }

  async createFollowup(
    customerId: string,
    dto: CreateFollowupDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const customer = await this.findCustomerOrThrow(customerId);
    ensureCanAccessCustomer(customer, user);

    const followup = await this.prisma.customerFollowup.create({
      data: {
        content: dto.content,
        createdBy: user.id,
        customerId,
        followupType: dto.followupType,
        followupUserId: user.id,
        nextFollowupAt: dto.nextFollowupAt ? new Date(dto.nextFollowupAt) : undefined,
        updatedBy: user.id
      }
    });

    await this.auditService.write({
      action: AuditAction.CREATE,
      after: followup,
      entityId: followup.id,
      entityType: "customer_followup",
      ipAddress: context.ipAddress,
      module: "customer",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return followup;
  }

  async listApplications(user: RequestUser) {
    const applications = await this.prisma.application.findMany({
      include: applicationInclude,
      orderBy: { createdAt: "desc" },
      where: this.applicationScopeWhere(user)
    });

    return applications.map((application) => toApplicationView(application, user));
  }

  async createApplication(dto: CreateApplicationDto, user: RequestUser, context: RequestContext) {
    const customer = await this.findCustomerOrThrow(dto.customerId);
    ensureCanAccessCustomer(customer, user);

    const application = await withUniqueBusinessNoRetry(() => this.prisma.$transaction(async (tx) => {
      const created = await tx.application.create({
        data: {
          applicationNo: createBusinessNo("APP"),
          createdBy: user.id,
          customerId: dto.customerId,
          intendedModel: dto.intendedModel,
          intendedPeriodMonths: dto.intendedPeriodMonths,
          salesUserId: customer.ownerUserId ?? user.id,
          updatedBy: user.id
        }
      });

      await tx.customer.update({
        data: {
          status:
            customer.status === CustomerStatus.LEAD
              ? CustomerStatus.PENDING_APPLICATION
              : customer.status,
          updatedBy: user.id
        },
        where: { id: customer.id }
      });

      await createApplicationActionLog(tx, {
        actionType: ApplicationActionType.CREATE,
        applicationId: created.id,
        operator: user,
        toStatus: ApplicationStatus.DRAFT
      });

      return tx.application.findUniqueOrThrow({
        include: applicationInclude,
        where: { id: created.id }
      });
    }));

    await this.auditService.write({
      action: AuditAction.CREATE,
      after: toApplicationView(application),
      entityId: application.id,
      entityType: "application",
      ipAddress: context.ipAddress,
      module: "application",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toApplicationView(application);
  }

  async getApplication(id: string, user: RequestUser) {
    const application = await this.findApplicationOrThrow(id);
    ensureCanAccessApplication(application, user);
    return toApplicationView(application, user);
  }

  async updateApplication(
    id: string,
    dto: UpdateApplicationDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.findApplicationOrThrow(id);
    ensureCanManageApplication(before, user);

    if (!canEditApplication(before.status)) {
      throw new BadRequestException("Only draft or need-more-info applications can be updated.");
    }

    const application = await this.prisma.application.update({
      data: {
        intendedModel: dto.intendedModel,
        intendedPeriodMonths: dto.intendedPeriodMonths,
        updatedBy: user.id
      },
      include: applicationInclude,
      where: { id }
    });

    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: toApplicationView(application),
      before: toApplicationView(before),
      entityId: id,
      entityType: "application",
      ipAddress: context.ipAddress,
      module: "application",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toApplicationView(application);
  }

  async submitApplication(
    id: string,
    dto: SubmitApplicationDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.findApplicationOrThrow(id);
    ensureCanManageApplication(before, user);

    if (!canEditApplication(before.status)) {
      throw new BadRequestException("Only draft or need-more-info applications can be submitted.");
    }
    assertCanSubmitApplication(before);

    const application = await this.prisma.$transaction(async (tx) => {
      await tx.application.update({
        data: {
          status: ApplicationStatus.SUBMITTED,
          submittedAt: new Date(),
          updatedBy: user.id
        },
        where: { id }
      });

      await tx.customer.update({
        data: { status: CustomerStatus.UNDER_REVIEW, updatedBy: user.id },
        where: { id: before.customerId }
      });

      await createApplicationActionLog(tx, {
        actionType: ApplicationActionType.SUBMIT,
        applicationId: id,
        comment: normalizeOptionalText(dto.comment),
        fromStatus: before.status,
        operator: user,
        toStatus: ApplicationStatus.SUBMITTED
      });

      return tx.application.findUniqueOrThrow({
        include: applicationInclude,
        where: { id }
      });
    });

    await this.auditApplicationChange(AuditAction.UPDATE, before, application, user, context);
    return toApplicationView(application);
  }

  async uploadMaterial(
    id: string,
    dto: CreateMaterialDto,
    files: UploadedMaterialFile[] | undefined,
    user: RequestUser,
    context: RequestContext
  ) {
    const application = await this.findApplicationOrThrow(id);
    ensureCanManageApplication(application, user);

    if (!canUploadMaterialForApplication(application, user)) {
      throw new BadRequestException("Materials can only be uploaded before review is finalized.");
    }

    const uploadFiles = (files ?? []).filter((file) => file.buffer?.length);

    if (uploadFiles.length === 0) {
      throw new BadRequestException("Material file is required.");
    }

    const storedFiles = await Promise.all(
      uploadFiles.map(async (file) => ({ file, storage: await this.saveLocalFile(file) }))
    );

    const group = await this.prisma.$transaction(async (tx) => {
      const materialGroup = await upsertMaterialGroup(tx, {
        applicationId: id,
        materialType: dto.materialType,
        user
      });

      const materialFiles = [];

      for (const { file, storage } of storedFiles) {
        const fileObject = await tx.fileObject.create({
          data: {
            bucket: storage.bucket,
            objectKey: storage.objectKey,
            originalName: file.originalname,
            mimeType: file.mimetype,
            sizeBytes: BigInt(file.size),
            uploadedBy: user.id
          }
        });

        const materialFile = await tx.applicationMaterialFile.create({
          data: {
            applicationId: id,
            createdBy: user.id,
            fileId: fileObject.id,
            fileName: file.originalname,
            materialGroupId: materialGroup.id,
            materialType: dto.materialType,
            mimeType: file.mimetype,
            sizeBytes: BigInt(file.size),
            updatedBy: user.id,
            uploadedBy: user.id
          },
          include: materialFileInclude
        });

        materialFiles.push(materialFile);
      }

      await createApplicationActionLog(tx, {
        actionType: ApplicationActionType.UPLOAD_MATERIAL_FILE,
        applicationId: id,
        comment: buildMaterialFileActionComment(
          "上传资料文件",
          dto.materialType,
          materialFiles.map((file) => file.fileName),
          normalizeOptionalText(dto.reviewRemark)
        ),
        materialFileId: materialFiles[0]?.id,
        materialGroupId: materialGroup.id,
        operator: user,
        toStatus: application.status
      });

      return tx.applicationMaterialGroup.findUniqueOrThrow({
        include: materialGroupInclude,
        where: { id: materialGroup.id }
      });
    });

    await this.auditService.write({
      action: AuditAction.CREATE,
      after: toMaterialGroupView(group, application, user),
      entityId: group.id,
      entityType: "application_material_group",
      ipAddress: context.ipAddress,
      module: "application",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toMaterialGroupView(group, application, user);
  }

  async previewMaterial(
    id: string,
    materialId: string,
    user: RequestUser
  ): Promise<MaterialPreview> {
    const application = await this.findApplicationOrThrow(id);
    ensureCanAccessApplication(application, user);

    const material = await this.prisma.applicationMaterial.findFirst({
      include: { file: true },
      where: { applicationId: id, deletedAt: null, id: materialId }
    });

    if (!material) {
      throw new NotFoundException("Application material not found.");
    }

    const absolutePath = await this.resolveLocalFilePath(
      material.file.bucket,
      material.file.objectKey
    );
    let fileStat: Awaited<ReturnType<typeof stat>>;

    try {
      fileStat = await stat(absolutePath);
    } catch {
      throw new NotFoundException("Material file is not available for preview.");
    }

    return {
      filename: material.file.originalName,
      mimeType: material.file.mimeType,
      sizeBytes: fileStat.size,
      stream: createReadStream(absolutePath)
    };
  }

  async previewMaterialFile(
    id: string,
    fileRecordId: string,
    user: RequestUser
  ): Promise<MaterialPreview> {
    const application = await this.findApplicationOrThrow(id);
    ensureCanAccessApplication(application, user);

    const materialFile = await this.prisma.applicationMaterialFile.findFirst({
      include: { file: true },
      where: { applicationId: id, id: fileRecordId }
    });

    if (!materialFile || materialFile.isDeleted) {
      throw new NotFoundException("Application material file not found.");
    }

    const absolutePath = await this.resolveLocalFilePath(
      materialFile.file.bucket,
      materialFile.file.objectKey
    );
    let fileStat: Awaited<ReturnType<typeof stat>>;

    try {
      fileStat = await stat(absolutePath);
    } catch {
      throw new NotFoundException("Material file is not available for preview.");
    }

    return {
      filename: materialFile.fileName,
      mimeType: materialFile.mimeType,
      sizeBytes: fileStat.size,
      stream: createReadStream(absolutePath)
    };
  }

  async reviewMaterial(
    id: string,
    materialId: string,
    dto: ReviewMaterialDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const application = await this.findApplicationOrThrow(id);
    ensureCanAccessApplication(application, user);
    assertReviewMaterialInput(dto.status, dto.comment);

    const before = await this.prisma.applicationMaterial.findFirst({
      include: materialInclude,
      where: { applicationId: id, deletedAt: null, id: materialId }
    });

    if (!before) {
      throw new NotFoundException("Application material not found.");
    }

    const reviewedAt = new Date();
    const comment = normalizeOptionalText(dto.comment);
    const material = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.applicationMaterial.update({
        data: {
          reviewComment: comment,
          reviewRemark: comment,
          reviewedAt,
          reviewedBy: user.id,
          status: dto.status,
          updatedBy: user.id
        },
        include: materialInclude,
        where: { id: materialId }
      });

      await createApplicationActionLog(tx, {
        actionType: ApplicationActionType.REVIEW_MATERIAL,
        applicationId: id,
        comment,
        fromStatus: application.status,
        materialId,
        operator: user,
        toStatus: application.status
      });

      return updated;
    });

    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: toMaterialView(material),
      before: toMaterialView(before),
      entityId: material.id,
      entityType: "application_material",
      ipAddress: context.ipAddress,
      module: "application",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toMaterialView(material);
  }

  async reviewMaterialGroup(
    id: string,
    materialGroupId: string,
    dto: ReviewMaterialDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const application = await this.findApplicationOrThrow(id);
    ensureCanAccessApplication(application, user);
    assertCanReviewMaterialGroup(application, user);
    assertReviewMaterialInput(dto.status, dto.comment);

    const before = await this.prisma.applicationMaterialGroup.findFirst({
      include: materialGroupInclude,
      where: { applicationId: id, deletedAt: null, id: materialGroupId }
    });

    if (!before) {
      throw new NotFoundException("Application material group not found.");
    }

    assertCanReviewMaterialGroupStatus(before, dto.status);

    const reviewedAt = new Date();
    const comment = normalizeOptionalText(dto.comment);
    const group = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.applicationMaterialGroup.update({
        data: {
          reviewComment: comment,
          reviewedAt,
          reviewedBy: user.id,
          reviewStatus: dto.status,
          updatedBy: user.id
        },
        include: materialGroupInclude,
        where: { id: materialGroupId }
      });

      await createApplicationActionLog(tx, {
        actionType: ApplicationActionType.REVIEW_MATERIAL_GROUP,
        applicationId: id,
        comment,
        fromStatus: application.status,
        materialGroupId,
        operator: user,
        toStatus: application.status
      });

      return updated;
    });

    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: toMaterialGroupView(group, application, user),
      before: toMaterialGroupView(before, application, user),
      entityId: group.id,
      entityType: "application_material_group",
      ipAddress: context.ipAddress,
      module: "application",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toMaterialGroupView(group, application, user);
  }

  async deleteMaterialFile(
    id: string,
    fileRecordId: string,
    dto: DeleteMaterialFileDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const application = await this.findApplicationOrThrow(id);
    ensureCanAccessApplication(application, user);
    const reason = assertDeleteMaterialFileInput(dto.reason);

    const before = await this.prisma.applicationMaterialFile.findFirst({
      include: materialFileInclude,
      where: { applicationId: id, id: fileRecordId }
    });

    if (!before || before.isDeleted) {
      throw new NotFoundException("Application material file not found.");
    }

    if (!canDeleteMaterialFile(application, user)) {
      throw new ForbiddenException("You do not have permission to delete this material file.");
    }

    const deletedAt = new Date();
    const materialFile = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.applicationMaterialFile.update({
        data: {
          deletedAt,
          deletedBy: user.id,
          deleteReason: reason,
          isDeleted: true,
          updatedBy: user.id
        },
        include: materialFileInclude,
        where: { id: fileRecordId }
      });

      await createApplicationActionLog(tx, {
        actionType: ApplicationActionType.DELETE_MATERIAL_FILE,
        applicationId: id,
        comment: buildMaterialFileActionComment(
          "删除资料文件",
          before.materialType,
          [before.fileName],
          reason
        ),
        fromStatus: application.status,
        materialFileId: fileRecordId,
        materialGroupId: before.materialGroupId,
        operator: user,
        toStatus: application.status
      });

      return updated;
    });

    await this.auditService.write({
      action: AuditAction.DELETE,
      after: toMaterialFileView(materialFile, application, user),
      before: toMaterialFileView(before, application, user),
      entityId: materialFile.id,
      entityType: "application_material_file",
      ipAddress: context.ipAddress,
      module: "application",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toMaterialFileView(materialFile, application, user);
  }

  async needMoreInfo(id: string, dto: NeedMoreInfoDto, user: RequestUser, context: RequestContext) {
    const before = await this.findApplicationOrThrow(id);
    ensureReviewable(before);
    const comment = normalizeRequiredText(dto.comment ?? dto.reason, "comment");

    const application = await this.prisma.$transaction(async (tx) => {
      await tx.application.update({
        data: {
          rejectedReason: comment,
          status: ApplicationStatus.NEED_MORE_INFO,
          updatedBy: user.id
        },
        where: { id }
      });

      await createApplicationActionLog(tx, {
        actionType: ApplicationActionType.NEED_MORE_INFO,
        applicationId: id,
        comment,
        fromStatus: before.status,
        operator: user,
        toStatus: ApplicationStatus.NEED_MORE_INFO
      });

      return tx.application.findUniqueOrThrow({
        include: applicationInclude,
        where: { id }
      });
    });

    await this.auditApplicationChange(AuditAction.UPDATE, before, application, user, context);
    return toApplicationView(application);
  }

  async approveApplication(
    id: string,
    dto: ApproveApplicationDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.findApplicationOrThrow(id);
    ensureReviewable(before);
    assertCanApproveApplication(before);
    const approvedAt = new Date();
    const comment = normalizeOptionalText(dto.comment ?? dto.remark);

    const { application, riskResult } = await this.prisma.$transaction(async (tx) => {
      await tx.application.update({
        data: {
          approvedAt,
          rejectedReason: null,
          status: ApplicationStatus.APPROVED,
          updatedBy: user.id
        },
        where: { id }
      });

      await tx.customer.update({
        data: {
          grade: dto.grade,
          riskScore: dto.riskScore,
          status: CustomerStatus.APPROVED,
          updatedBy: user.id
        },
        where: { id: before.customerId }
      });

      const riskResult = await this.riskService.createApprovalRiskResult(tx, {
        applicationId: id,
        approvedAt,
        customerId: before.customerId,
        grade: dto.grade,
        maxVehiclePurchasePriceAmount: dto.maxVehiclePurchasePriceAmount,
        operatorId: user.id,
        remark: comment,
        riskScore: dto.riskScore
      });

      await createApplicationActionLog(tx, {
        actionType: ApplicationActionType.APPROVE,
        applicationId: id,
        comment,
        fromStatus: before.status,
        operator: user,
        toStatus: ApplicationStatus.APPROVED
      });

      const application = await tx.application.findUniqueOrThrow({
        include: applicationInclude,
        where: { id }
      });

      return { application, riskResult };
    });

    await this.auditApplicationChange(AuditAction.APPROVE, before, application, user, context);
    await this.auditService.write({
      action: AuditAction.APPROVE,
      after: toRiskResultView(riskResult),
      entityId: riskResult.id,
      entityType: "risk_result",
      ipAddress: context.ipAddress,
      module: "risk",
      operatorId: user.id,
      userAgent: context.userAgent
    });
    return toApplicationView(application);
  }

  async rejectApplication(
    id: string,
    dto: RejectApplicationDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.findApplicationOrThrow(id);
    ensureReviewable(before);
    const comment = normalizeRequiredText(dto.comment ?? dto.reason, "comment");

    const application = await this.prisma.$transaction(async (tx) => {
      await tx.application.update({
        data: {
          rejectedReason: comment,
          status: ApplicationStatus.REJECTED,
          updatedBy: user.id
        },
        where: { id }
      });

      await tx.customer.update({
        data: { status: CustomerStatus.REJECTED, updatedBy: user.id },
        where: { id: before.customerId }
      });

      await createApplicationActionLog(tx, {
        actionType: ApplicationActionType.REJECT,
        applicationId: id,
        comment,
        fromStatus: before.status,
        operator: user,
        toStatus: ApplicationStatus.REJECTED
      });

      return tx.application.findUniqueOrThrow({
        include: applicationInclude,
        where: { id }
      });
    });

    await this.auditApplicationChange(AuditAction.REJECT, before, application, user, context);
    return toApplicationView(application);
  }

  private customerScopeWhere(user: RequestUser): Prisma.CustomerWhereInput {
    return {
      deletedAt: null,
      ...(canViewAll(user) ? {} : { ownerUserId: user.id })
    };
  }

  private applicationScopeWhere(user: RequestUser): Prisma.ApplicationWhereInput {
    return {
      deletedAt: null,
      ...(canViewAll(user) ? {} : { salesUserId: user.id })
    };
  }

  private async findCustomerOrThrow(id: string) {
    const customer = await this.prisma.customer.findUnique({
      include: customerInclude,
      where: { id }
    });

    if (!customer || customer.deletedAt) {
      throw new NotFoundException("Customer not found.");
    }

    return customer;
  }

  private async findApplicationOrThrow(id: string) {
    const application = await this.prisma.application.findUnique({
      include: applicationInclude,
      where: { id }
    });

    if (!application || application.deletedAt) {
      throw new NotFoundException("Application not found.");
    }

    return application;
  }

  private async auditApplicationChange(
    action: AuditAction,
    before: ApplicationWithDetails,
    after: ApplicationWithDetails,
    user: RequestUser,
    context: RequestContext
  ) {
    await this.auditService.write({
      action,
      after: toApplicationView(after),
      before: toApplicationView(before),
      entityId: after.id,
      entityType: "application",
      ipAddress: context.ipAddress,
      module: "application",
      operatorId: user.id,
      userAgent: context.userAgent
    });
  }

  private async saveLocalFile(file: UploadedMaterialFile) {
    const baseDir = path.resolve(
      process.cwd(),
      this.configService.get<string>("LOCAL_FILE_STORAGE_DIR") ?? "./uploads"
    );
    const bucket = "application-materials";
    const directory = path.join(baseDir, bucket);
    const safeName = sanitizeFilename(file.originalname);
    const objectKey = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${safeName}`;
    const absolutePath = path.join(directory, objectKey);

    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, file.buffer);

    return { bucket, objectKey };
  }

  private async resolveLocalFilePath(bucket: string, objectKey: string) {
    const baseDir = path.resolve(
      process.cwd(),
      this.configService.get<string>("LOCAL_FILE_STORAGE_DIR") ?? "./uploads"
    );
    const absolutePath = path.resolve(baseDir, bucket, objectKey);

    if (!absolutePath.startsWith(baseDir + path.sep)) {
      throw new BadRequestException("Invalid file path.");
    }

    return absolutePath;
  }
}

function canViewAll(user: RequestUser) {
  return user.roles.some((role) => ["ADMIN", "GM", "OP", "RC"].includes(role));
}

function ensureCanAccessCustomer(customer: CustomerWithDetails, user: RequestUser) {
  if (!canViewAll(user) && customer.ownerUserId !== user.id) {
    throw new ForbiddenException("Customer is outside your scope.");
  }
}

function ensureCanAccessApplication(application: ApplicationWithDetails, user: RequestUser) {
  if (!canAccessScopedApplication(application, user)) {
    throw new ForbiddenException("Application is outside your scope.");
  }
}

export function canAccessScopedApplication(
  application: Pick<ApplicationWithDetails, "salesUserId">,
  user: RequestUser
) {
  return canViewAll(user) || application.salesUserId === user.id;
}

function ensureCanManageApplication(application: ApplicationWithDetails, user: RequestUser) {
  ensureCanAccessApplication(application, user);
}

function ensureReviewable(application: ApplicationWithDetails) {
  if (application.status !== ApplicationStatus.SUBMITTED) {
    throw new BadRequestException("Only submitted applications can be reviewed.");
  }
}

export function canEditApplication(status: ApplicationStatus) {
  return status === ApplicationStatus.DRAFT || status === ApplicationStatus.NEED_MORE_INFO;
}

function canUploadMaterialForApplication(
  application: Pick<ApplicationWithDetails, "salesUserId" | "status">,
  user: RequestUser
) {
  return (
    user.permissions.includes(PermissionCode.APPLICATION_MATERIAL_UPLOAD) &&
    canAccessScopedApplication(application, user) &&
    canUploadMaterial(application.status, user, application.salesUserId)
  );
}

function canUploadMaterial(status: ApplicationStatus, user: RequestUser, salesUserId?: string) {
  if (user.roles.includes("ADMIN")) {
    return true;
  }

  if (status === ApplicationStatus.DRAFT || status === ApplicationStatus.NEED_MORE_INFO) {
    return canViewAll(user) || salesUserId === user.id;
  }

  if (status === ApplicationStatus.SUBMITTED) {
    return user.roles.some((role) => role === "OP" || role === "RC");
  }

  return false;
}

export function isUploadableStatus(status: ApplicationStatus) {
  return (
    status === ApplicationStatus.DRAFT ||
    status === ApplicationStatus.SUBMITTED ||
    status === ApplicationStatus.NEED_MORE_INFO
  );
}

export function canDeleteMaterialFile(
  application: Pick<ApplicationWithDetails, "salesUserId" | "status">,
  user: RequestUser
) {
  if (!user.permissions.includes(PermissionCode.APPLICATION_MATERIAL_DELETE)) {
    return false;
  }

  if (user.roles.includes("ADMIN")) {
    return true;
  }

  if (application.status === ApplicationStatus.DRAFT || application.status === ApplicationStatus.NEED_MORE_INFO) {
    return canViewAll(user) || application.salesUserId === user.id;
  }

  if (application.status === ApplicationStatus.SUBMITTED) {
    return user.roles.some((role) => role === "OP" || role === "RC");
  }

  return false;
}

function assertCanReviewMaterialGroup(
  application: Pick<ApplicationWithDetails, "status">,
  user: RequestUser
) {
  if (canReviewMaterialGroup(application, user)) {
    return;
  }

  throw new ForbiddenException("You do not have permission to review this material group.");
}

function canReviewMaterialGroup(
  application: Pick<ApplicationWithDetails, "status">,
  user: RequestUser
) {
  if (!user.permissions.includes(PermissionCode.APPLICATION_REVIEW)) {
    return false;
  }

  if (user.roles.includes("ADMIN")) {
    return true;
  }

  return (
    user.roles.includes("RC") &&
    (application.status === ApplicationStatus.SUBMITTED ||
      application.status === ApplicationStatus.NEED_MORE_INFO)
  );
}

function identityData(dto: CustomerIdentityDto) {
  return {
    driverLicenseNo: dto.driverLicenseNo,
    idCardNo: dto.idCardNo,
    licenseValidUntil: dto.licenseValidUntil ? new Date(dto.licenseValidUntil) : undefined,
    realnameVerified: dto.realnameVerified
  };
}

function profileData(dto: CustomerProfileDto) {
  return {
    companyName: dto.companyName,
    emergencyContactMobile: dto.emergencyContactMobile,
    emergencyContactName: dto.emergencyContactName,
    housingFundMonths: dto.housingFundMonths,
    monthlyIncomeAmount:
      dto.monthlyIncomeAmount === undefined ? undefined : BigInt(dto.monthlyIncomeAmount),
    occupation: dto.occupation,
    residenceAddress: dto.residenceAddress,
    socialSecurityMonths: dto.socialSecurityMonths
  };
}

function sanitizeFilename(filename: string) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "material";
}

const requiredMaterialTypes: ApplicationMaterialType[] = [
  ApplicationMaterialType.ID_CARD,
  ApplicationMaterialType.DRIVER_LICENSE,
  ApplicationMaterialType.CREDIT_AUTH
];

function isRequiredMaterialType(type: ApplicationMaterialType) {
  return requiredMaterialTypes.includes(type);
}

export function assertCanSubmitApplication(application: ApplicationWithDetails) {
  const groups = materialGroupByType(application.materialGroups);
  const missingTypes = requiredMaterialTypes.filter((type) => {
    const group = groups.get(type);
    return !group || activeMaterialFiles(group).length === 0;
  });
  const rejectedTypes = requiredMaterialTypes.filter(
    (type) => groups.get(type)?.reviewStatus === MaterialStatus.REJECTED
  );

  if (missingTypes.length > 0) {
    throw new BadRequestException(
      `Missing required materials: ${missingTypes.map(getMaterialTypeName).join(", ")}.`
    );
  }

  if (rejectedTypes.length > 0) {
    throw new BadRequestException(
      `Rejected required materials must be re-uploaded: ${rejectedTypes
        .map(getMaterialTypeName)
        .join(", ")}.`
    );
  }
}

export function assertCanApproveApplication(application: ApplicationWithDetails) {
  const invalidTypes = requiredMaterialTypes.filter((type) => {
    const group = materialGroupByType(application.materialGroups).get(type);
    return !group || activeMaterialFiles(group).length === 0 || !isApprovedMaterialStatus(group.reviewStatus);
  });

  if (invalidTypes.length > 0) {
    throw new BadRequestException(
      `Required materials are not approved: ${invalidTypes.map(getMaterialTypeName).join(", ")}.`
    );
  }
}

function materialGroupByType(groups: ApplicationWithDetails["materialGroups"]) {
  return new Map(groups.map((group) => [group.materialType, group]));
}

function activeMaterialFiles(group: Pick<ApplicationWithDetails["materialGroups"][number], "files">) {
  return group.files.filter((file) => !file.isDeleted);
}

export function isApprovedMaterialStatus(status: MaterialStatus) {
  return status === MaterialStatus.APPROVED || status === MaterialStatus.VERIFIED;
}

export function assertReviewMaterialInput(status: MaterialStatus, comment?: string) {
  if (
    status !== MaterialStatus.APPROVED &&
    status !== MaterialStatus.NEED_MORE_INFO &&
    status !== MaterialStatus.REJECTED
  ) {
    throw new BadRequestException("Material review status must be APPROVED, NEED_MORE_INFO, or REJECTED.");
  }

  if (
    (status === MaterialStatus.NEED_MORE_INFO || status === MaterialStatus.REJECTED) &&
    !normalizeOptionalText(comment)
  ) {
    throw new BadRequestException("comment is required for this material review status.");
  }
}

export function assertDeleteMaterialFileInput(reason?: string | null) {
  return normalizeRequiredText(reason, "reason");
}

export function assertCanReviewMaterialGroupStatus(
  group: Pick<
    ApplicationWithDetails["materialGroups"][number],
    "files" | "materialType" | "required"
  >,
  status: MaterialStatus
) {
  if (status === MaterialStatus.APPROVED && group.required && activeMaterialFiles(group).length === 0) {
    throw new BadRequestException(
      `Required material cannot be approved without files: ${getMaterialTypeName(group.materialType)}.`
    );
  }
}

function normalizeOptionalText(value?: string | null) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeRequiredText(value: string | undefined | null, field: string) {
  const normalized = normalizeOptionalText(value);

  if (!normalized) {
    throw new BadRequestException(`${field} is required.`);
  }

  return normalized;
}

async function createApplicationActionLog(
  tx: Tx,
  input: {
    actionType: ApplicationActionType;
    applicationId: string;
    comment?: string;
    fromStatus?: ApplicationStatus | null;
    materialId?: string;
    materialFileId?: string;
    materialGroupId?: string;
    operator: RequestUser;
    toStatus?: ApplicationStatus | null;
  }
) {
  await tx.applicationActionLog.create({
    data: {
      actionType: input.actionType,
      applicationId: input.applicationId,
      comment: input.comment,
      createdBy: input.operator.id,
      fromStatus: input.fromStatus,
      materialFileId: input.materialFileId,
      materialGroupId: input.materialGroupId,
      materialId: input.materialId,
      operatorId: input.operator.id,
      operatorName: input.operator.name,
      toStatus: input.toStatus,
      updatedBy: input.operator.id
    }
  });
}

async function upsertMaterialGroup(
  tx: Tx,
  input: {
    applicationId: string;
    materialType: ApplicationMaterialType;
    user: RequestUser;
  }
) {
  return tx.applicationMaterialGroup.upsert({
    create: {
      applicationId: input.applicationId,
      createdBy: input.user.id,
      materialName: getMaterialTypeName(input.materialType),
      materialType: input.materialType,
      required: isRequiredMaterialType(input.materialType),
      updatedBy: input.user.id
    },
    update: {
      materialName: getMaterialTypeName(input.materialType),
      required: isRequiredMaterialType(input.materialType),
      updatedBy: input.user.id
    },
    where: {
      applicationId_materialType: {
        applicationId: input.applicationId,
        materialType: input.materialType
      }
    }
  });
}

function buildMaterialFileActionComment(
  action: string,
  materialType: ApplicationMaterialType,
  fileNames: string[],
  comment?: string
) {
  const text = `${action}: ${getMaterialTypeName(materialType)} - ${fileNames.join(", ")}`;
  return comment ? `${text}; ${comment}` : text;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getMaterialTypeLabel(type: ApplicationMaterialType) {
  const labels: Record<ApplicationMaterialType, string> = {
    BANK_FLOW: "银行流水",
    CREDIT_AUTH: "征信授权",
    DRIVER_LICENSE: "驾驶证",
    ID_CARD: "身份证",
    OTHER: "其他",
    RESIDENCE_PROOF: "居住证明",
    WORK_PROOF: "工作证明"
  };

  return labels[type];
}

function getMaterialTypeName(type: ApplicationMaterialType) {
  const labels: Record<ApplicationMaterialType, string> = {
    BANK_FLOW: "银行流水",
    CREDIT_AUTH: "征信授权",
    DRIVER_LICENSE: "驾驶证",
    ID_CARD: "身份证",
    OTHER: "其他",
    RESIDENCE_PROOF: "居住证明",
    WORK_PROOF: "工作证明"
  };

  return labels[type];
}

export function getAvailableApplicationActions(
  application: Pick<ApplicationWithDetails, "salesUserId" | "status">,
  user: RequestUser
) {
  const permissions = new Set(user.permissions);
  const actions: string[] = [];

  if (
    permissions.has(PermissionCode.APPLICATION_MATERIAL_UPLOAD) &&
    canUploadMaterialForApplication(application, user)
  ) {
    actions.push("uploadMaterial");
  }

  if (
    permissions.has(PermissionCode.APPLICATION_SUBMIT) &&
    (canViewAll(user) || application.salesUserId === user.id) &&
    canEditApplication(application.status)
  ) {
    actions.push("submit");
  }

  if (
    permissions.has(PermissionCode.APPLICATION_REVIEW) &&
    application.status === ApplicationStatus.SUBMITTED
  ) {
    actions.push("reviewMaterial", "approve", "needMoreInfo", "reject");
  }

  if (
    permissions.has(PermissionCode.QUOTE_CREATE) &&
    (canViewAll(user) || application.salesUserId === user.id) &&
    application.status === ApplicationStatus.APPROVED
  ) {
    actions.push("createQuote");
  }

  return actions;
}

export function toCustomerView(customer: CustomerWithDetails) {
  return {
    applications: customer.applications.map((application) => ({
      applicationNo: application.applicationNo,
      id: application.id,
      intendedModel: application.intendedModel,
      status: application.status
    })),
    createdAt: customer.createdAt,
    customerNo: customer.customerNo,
    customerType: customer.customerType,
    grade: customer.grade,
    id: customer.id,
    identity: customer.identity,
    mobile: customer.mobile,
    name: customer.name,
    ownerUser: customer.ownerUser,
    profile: customer.profile
      ? {
          ...customer.profile,
          monthlyIncomeAmount:
            customer.profile.monthlyIncomeAmount === null
              ? null
              : Number(customer.profile.monthlyIncomeAmount)
        }
      : null,
    remark: customer.remark,
    riskScore: customer.riskScore,
    sourceChannel: customer.sourceChannel,
    status: customer.status
  };
}

export function toApplicationView(application: ApplicationWithDetails, user?: RequestUser) {
  return {
    actionLogs: application.actionLogs.map(toApplicationActionLogView),
    applicationNo: application.applicationNo,
    approvedAt: application.approvedAt,
    availableActions: user ? getAvailableApplicationActions(application, user) : [],
    createdAt: application.createdAt,
    customer: {
      ...application.customer,
      profile: application.customer.profile
        ? {
            ...application.customer.profile,
            monthlyIncomeAmount:
              application.customer.profile.monthlyIncomeAmount === null
                ? null
                : Number(application.customer.profile.monthlyIncomeAmount)
          }
        : null
    },
    customerId: application.customerId,
    id: application.id,
    intendedModel: application.intendedModel,
    intendedPeriodMonths: application.intendedPeriodMonths,
    materials: application.materialGroups.map((group) => toMaterialGroupView(group, application, user)),
    orders: (application.orders ?? [])
      .filter((order) => !order.deletedAt)
      .map((order) => ({
        id: order.id,
        orderNo: order.orderNo,
        orderStatus: order.orderStatus
      })),
    rejectedReason: application.rejectedReason,
    riskResult: application.riskResults[0] ? toRiskResultView(application.riskResults[0]) : null,
    salesUser: application.salesUser,
    salesUserId: application.salesUserId,
    status: application.status,
    submittedAt: application.submittedAt
  };
}

function toMaterialView(
  material: Prisma.ApplicationMaterialGetPayload<{ include: typeof materialInclude }>
) {
  return {
    createdAt: material.createdAt,
    file: {
      bucket: material.file.bucket,
      id: material.file.id,
      mimeType: material.file.mimeType,
      objectKey: material.file.objectKey,
      originalName: material.file.originalName,
      sizeBytes: Number(material.file.sizeBytes),
      uploader: material.file.uploader
    },
    fileId: material.fileId,
    id: material.id,
    materialName: material.materialName ?? getMaterialTypeName(material.materialType),
    materialType: material.materialType,
    reviewComment: material.reviewComment ?? material.reviewRemark,
    reviewedAt: material.reviewedAt,
    reviewer: material.reviewer,
    reviewRemark: material.reviewRemark,
    status: material.status
  };
}

function toMaterialGroupView(
  group: Prisma.ApplicationMaterialGroupGetPayload<{ include: typeof materialGroupInclude }>,
  application: Pick<ApplicationWithDetails, "salesUserId" | "status">,
  user?: RequestUser
) {
  return {
    canReview: user ? canReviewMaterialGroup(application, user) : false,
    canUpload: user ? canUploadMaterialForApplication(application, user) : false,
    files: group.files
      .filter((file) => !file.isDeleted)
      .map((file) => toMaterialFileView(file, application, user)),
    id: group.id,
    materialGroupId: group.id,
    materialName: group.materialName ?? getMaterialTypeName(group.materialType),
    materialType: group.materialType,
    required: group.required,
    reviewComment: group.reviewComment,
    reviewedAt: group.reviewedAt,
    reviewer: group.reviewer,
    reviewStatus: group.reviewStatus,
    status: group.reviewStatus
  };
}

function toMaterialFileView(
  file: Prisma.ApplicationMaterialFileGetPayload<{ include: typeof materialFileInclude }>,
  application: Pick<ApplicationWithDetails, "salesUserId" | "status">,
  user?: RequestUser
) {
  return {
    canDelete: user ? canDeleteMaterialFile(application, user) && !file.isDeleted : false,
    deletedAt: file.deletedAt,
    deletedBy: file.deleter,
    deleteReason: file.deleteReason,
    fileId: file.fileId,
    fileName: file.fileName,
    fileRecordId: file.id,
    id: file.id,
    isDeleted: file.isDeleted,
    materialType: file.materialType,
    mimeType: file.mimeType,
    sizeBytes: Number(file.sizeBytes),
    uploadedAt: file.uploadedAt,
    uploadedBy: file.uploader,
    uploader: file.uploader
  };
}

function toApplicationActionLogView(
  actionLog: ApplicationWithDetails["actionLogs"][number]
) {
  return {
    actionType: actionLog.actionType,
    comment: actionLog.comment,
    createdAt: actionLog.createdAt,
    fromStatus: actionLog.fromStatus,
    id: actionLog.id,
    material: actionLog.material,
    materialFile: actionLog.materialFile,
    materialFileId: actionLog.materialFileId,
    materialGroup: actionLog.materialGroup,
    materialGroupId: actionLog.materialGroupId,
    materialId: actionLog.materialId,
    operator: actionLog.operator,
    operatorId: actionLog.operatorId,
    operatorName: actionLog.operatorName,
    toStatus: actionLog.toStatus
  };
}
