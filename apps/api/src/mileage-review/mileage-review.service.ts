import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional
} from "@nestjs/common";
import {
  MileageReviewSubmissionSource,
  OrderMileageReviewStatus,
  OrderStatus,
  Prisma,
  VehicleMileageReadingStatus,
  VehicleMileageSourceType
} from "@prisma/client";

import { RequestUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { buildMileageReviewCycle } from "./mileage-review.calendar";
import {
  MileageReviewRecord,
  MileageReviewRepository
} from "./mileage-review.repository";
import {
  AttachMileageReviewEvidenceDto,
  ConfirmMileageReviewDto,
  MileageReviewListQueryDto,
  MileageReviewVersionDto,
  ReturnMileageReviewDto,
  SaveAdminMileageReviewDraftDto,
  VoidMileageReviewDto
} from "./dto/mileage-review.dto";
import {
  CreateFirstMileageReviewInput,
  MileageReviewTransaction
} from "./mileage-review.types";
import { MileageReviewSettlementService } from "./mileage-review-settlement.service";

@Injectable()
export class MileageReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: MileageReviewRepository,
    @Optional() private readonly storageService?: StorageService,
    @Optional()
    private readonly settlementService?: MileageReviewSettlementService
  ) {}

  async createFirstReview(
    tx: MileageReviewTransaction,
    input: CreateFirstMileageReviewInput
  ) {
    const baseline = await this.repository.findMileageReading(
      tx,
      input.deliveryReadingId
    );
    if (
      !baseline ||
      baseline.status !== VehicleMileageReadingStatus.ACTIVE ||
      baseline.sourceType !== VehicleMileageSourceType.DELIVERY_BASELINE ||
      baseline.orderId !== input.orderId ||
      baseline.vehicleId !== input.vehicleId
    ) {
      throw new BadRequestException(
        "Delivery baseline mileage reading is invalid."
      );
    }

    const cycle = buildMileageReviewCycle({
      actualDeliveryAt: input.actualDeliveryAt,
      cycleNo: 1
    });

    return this.repository.createFirstReview(tx, {
      baselineMileageKm: baseline.mileageKm,
      baselineReadingId: baseline.id,
      calculationSnapshot: {
        cycle: {
          actualDeliveryAt: input.actualDeliveryAt.toISOString(),
          timezone: "Asia/Shanghai"
        },
        source: {
          deliveryReadingId: baseline.id,
          type: VehicleMileageSourceType.DELIVERY_BASELINE
        }
      },
      createdBy: input.actorId,
      cycleNo: 1,
      dueAt: cycle.dueAt,
      orderId: input.orderId,
      periodEnd: cycle.periodEnd,
      periodStart: cycle.periodStart,
      scheduledReviewAt: cycle.scheduledReviewAt,
      status: OrderMileageReviewStatus.SCHEDULED,
      updatedBy: input.actorId,
      vehicleId: input.vehicleId,
      version: 1
    });
  }

  async activateDueReviews(asOf: Date) {
    assertValidAsOf(asOf);
    const result = await this.repository.activateDueReviews(asOf);
    return { activatedCount: result.count };
  }

  async listReviews(query: MileageReviewListQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const result = await this.repository.list({
      orderId: query.orderId,
      page,
      pageSize,
      status: query.status
    });
    return {
      items: result.items.map((item) => toMileageReviewView(item)),
      page,
      pageSize,
      total: result.total
    };
  }

  async getReview(id: string) {
    return toMileageReviewView(await this.findReviewOrThrow(id));
  }

  async listCustomerReviews(
    customerId: string,
    query: MileageReviewListQueryDto
  ) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const result = await this.repository.listForCustomer(customerId, {
      orderId: query.orderId,
      page,
      pageSize,
      status: query.status
    });
    return {
      items: result.items.map((item) =>
        toMileageReviewView(item, "/api/portal/mileage-reviews")
      ),
      page,
      pageSize,
      total: result.total
    };
  }

  async getCustomerReview(id: string, customerId: string) {
    return toMileageReviewView(
      await this.findCustomerReviewOrThrow(id, customerId),
      "/api/portal/mileage-reviews"
    );
  }

  async saveCustomerDraft(
    id: string,
    dto: {
      lockVersion: number;
      readingAt: string;
      submittedMileageKm: number;
    },
    customerId: string
  ) {
    const review = await this.findCustomerReviewOrThrow(id, customerId);
    assertCustomerReviewWritable(review);
    assertEditableReview(review.status);
    if (
      !Number.isSafeInteger(dto.submittedMileageKm) ||
      dto.submittedMileageKm < review.baselineMileageKm
    ) {
      throw new BadRequestException(
        "Submitted mileage cannot be lower than the confirmed baseline."
      );
    }
    const updated = await this.repository.updateReview({
      customerId,
      data: {
        readingAt: parseReviewDate(dto.readingAt, "readingAt"),
        submissionSource: MileageReviewSubmissionSource.PORTAL,
        submittedByCustomerId: customerId,
        submittedByUserId: null,
        submittedMileageKm: dto.submittedMileageKm,
        updatedBy: customerId
      },
      expectedLockVersion: dto.lockVersion,
      expectedStatuses: editableStatuses(),
      id,
      requireActiveOrder: true
    });
    return toMileageReviewView(updated, "/api/portal/mileage-reviews");
  }

  async attachCustomerEvidence(
    id: string,
    input: {
      bucket: string;
      capturedAt?: string;
      lockVersion: number;
      metadata?: Record<string, unknown>;
      mimeType: string;
      objectKey: string;
      originalName: string;
      sizeBytes: bigint;
    },
    customerId: string
  ) {
    const review = await this.findCustomerReviewOrThrow(id, customerId);
    assertCustomerReviewWritable(review);
    assertEditableReview(review.status);
    assertPrivateImageFile(input);
    await this.assertEvidenceReadable(input);
    const updated = await this.repository.attachPortalEvidence({
      customerId,
      evidenceData: {
        capturedAt: input.capturedAt
          ? parseReviewDate(input.capturedAt, "capturedAt")
          : null,
        createdBy: customerId,
        metadata: safeMetadata(input.metadata),
        reviewId: id,
        submissionSource: MileageReviewSubmissionSource.PORTAL,
        updatedBy: customerId,
        uploadedByCustomerId: customerId,
        uploadedByUserId: null
      },
      expectedLockVersion: input.lockVersion,
      expectedStatuses: editableStatuses(),
      fileData: {
        bucket: input.bucket,
        mimeType: input.mimeType,
        objectKey: input.objectKey,
        originalName: input.originalName,
        sizeBytes: input.sizeBytes,
        uploadedBy: null
      },
      id
    });
    return toMileageReviewView(updated, "/api/portal/mileage-reviews");
  }

  async removeCustomerEvidence(
    id: string,
    evidenceId: string,
    dto: MileageReviewVersionDto,
    customerId: string
  ) {
    const review = await this.findCustomerReviewOrThrow(id, customerId);
    assertCustomerReviewWritable(review);
    assertEditableReview(review.status);
    return toMileageReviewView(
      await this.repository.softDeleteEvidence({
        actorId: customerId,
        customerId,
        evidenceId,
        expectedLockVersion: dto.lockVersion,
        expectedStatuses: editableStatuses(),
        id,
        requireActiveOrder: true
      }),
      "/api/portal/mileage-reviews"
    );
  }

  async submitCustomerReview(
    id: string,
    dto: MileageReviewVersionDto,
    customerId: string
  ) {
    const review = await this.findCustomerReviewOrThrow(id, customerId);
    assertCustomerReviewWritable(review);
    assertEditableReview(review.status);
    if (review.submittedMileageKm === null || !review.readingAt) {
      throw new BadRequestException(
        "Mileage and reading time must be saved before submission."
      );
    }
    await this.assertAtLeastOneReadableEvidence(review);
    const updated = await this.repository.updateReview({
      customerId,
      data: {
        status: OrderMileageReviewStatus.PENDING_REVIEW,
        submissionSource: MileageReviewSubmissionSource.PORTAL,
        submittedAt: new Date(),
        submittedByCustomerId: customerId,
        submittedByUserId: null,
        updatedBy: customerId
      },
      expectedLockVersion: dto.lockVersion,
      expectedStatuses: editableStatuses(),
      id,
      requireActiveOrder: true
    });
    return toMileageReviewView(updated, "/api/portal/mileage-reviews");
  }

  async getCustomerEvidenceObject(
    id: string,
    evidenceId: string,
    customerId: string
  ) {
    await this.findCustomerReviewOrThrow(id, customerId);
    const evidence = await this.repository.findEvidenceForCustomer(
      evidenceId,
      id,
      customerId
    );
    if (!evidence) {
      throw new NotFoundException("Mileage review evidence not found.");
    }
    return this.downloadEvidence(evidence.file);
  }

  async saveAdminDraft(
    id: string,
    dto: SaveAdminMileageReviewDraftDto,
    user: RequestUser
  ) {
    const review = await this.findReviewOrThrow(id);
    assertEditableReview(review.status);
    if (
      !Number.isSafeInteger(dto.submittedMileageKm) ||
      dto.submittedMileageKm < review.baselineMileageKm
    ) {
      throw new BadRequestException(
        "Submitted mileage cannot be lower than the confirmed baseline."
      );
    }
    const readingAt = parseReviewDate(dto.readingAt, "readingAt");
    const updated = await this.repository.updateReview({
      data: {
        readingAt,
        submissionSource: MileageReviewSubmissionSource.ADMIN,
        submittedByCustomerId: null,
        submittedByUserId: user.id,
        submittedMileageKm: dto.submittedMileageKm,
        updatedBy: user.id
      },
      expectedLockVersion: dto.lockVersion,
      expectedStatuses: editableStatuses(),
      id
    });
    return toMileageReviewView(updated);
  }

  async attachEvidence(
    id: string,
    dto: AttachMileageReviewEvidenceDto,
    user: RequestUser
  ) {
    const review = await this.findReviewOrThrow(id);
    assertEditableReview(review.status);
    const file = await this.repository.findFile(dto.fileId);
    if (!file) {
      throw new NotFoundException("Evidence file does not exist.");
    }
    if (file.uploadedBy !== user.id) {
      throw new BadRequestException(
        "Evidence file is not owned by the current operator."
      );
    }
    assertPrivateImageFile(file);
    await this.assertEvidenceReadable(file);

    const updated = await this.repository.attachEvidence({
      data: {
        capturedAt: dto.capturedAt
          ? parseReviewDate(dto.capturedAt, "capturedAt")
          : null,
        createdBy: user.id,
        fileId: file.id,
        metadata: safeMetadata(dto.metadata),
        reviewId: id,
        submissionSource: MileageReviewSubmissionSource.ADMIN,
        updatedBy: user.id,
        uploadedByCustomerId: null,
        uploadedByUserId: user.id
      },
      expectedLockVersion: dto.lockVersion,
      expectedStatuses: editableStatuses(),
      id
    });
    return toMileageReviewView(updated);
  }

  async removeEvidence(
    id: string,
    evidenceId: string,
    dto: MileageReviewVersionDto,
    user: RequestUser
  ) {
    const review = await this.findReviewOrThrow(id);
    assertEditableReview(review.status);
    return toMileageReviewView(
      await this.repository.softDeleteEvidence({
        actorId: user.id,
        evidenceId,
        expectedLockVersion: dto.lockVersion,
        expectedStatuses: editableStatuses(),
        id
      })
    );
  }

  async getEvidenceObject(id: string, evidenceId: string) {
    await this.findReviewOrThrow(id);
    const evidence = await this.repository.findEvidence(evidenceId, id);
    if (!evidence) {
      throw new NotFoundException("Mileage review evidence not found.");
    }
    return this.downloadEvidence(evidence.file);
  }

  private async downloadEvidence(file: {
    bucket: string;
    mimeType: string | null;
    objectKey: string;
    originalName: string;
    sizeBytes: bigint;
  }) {
    assertPrivateImageFile(file);
    try {
      const downloaded = await this.getStorageService().getObject(
        file.bucket,
        file.objectKey
      );
      return {
        ...downloaded,
        mimeType: downloaded.contentType ?? file.mimeType,
        originalName: file.originalName
      };
    } catch {
      throw new NotFoundException("Mileage review evidence object is unavailable.");
    }
  }

  async submitReview(
    id: string,
    dto: MileageReviewVersionDto,
    user: RequestUser
  ) {
    const review = await this.findReviewOrThrow(id);
    assertEditableReview(review.status);
    if (review.submittedMileageKm === null || !review.readingAt) {
      throw new BadRequestException(
        "Mileage and reading time must be saved before submission."
      );
    }
    await this.assertAtLeastOneReadableEvidence(review);
    const updated = await this.repository.updateReview({
      data: {
        status: OrderMileageReviewStatus.PENDING_REVIEW,
        submissionSource: MileageReviewSubmissionSource.ADMIN,
        submittedAt: new Date(),
        submittedByCustomerId: null,
        submittedByUserId: user.id,
        updatedBy: user.id
      },
      expectedLockVersion: dto.lockVersion,
      expectedStatuses: editableStatuses(),
      id
    });
    return toMileageReviewView(updated);
  }

  async returnReview(
    id: string,
    dto: ReturnMileageReviewDto,
    user: RequestUser
  ) {
    const reason = dto.reason.trim();
    if (!reason) {
      throw new BadRequestException("Return reason is required.");
    }
    return toMileageReviewView(
      await this.repository.updateReview({
        data: {
          reviewNote: reason,
          reviewedAt: new Date(),
          reviewedBy: user.id,
          status: OrderMileageReviewStatus.RETURNED,
          updatedBy: user.id
        },
        expectedLockVersion: dto.lockVersion,
        expectedStatuses: [OrderMileageReviewStatus.PENDING_REVIEW],
        id
      })
    );
  }

  async confirmReview(
    id: string,
    dto: ConfirmMileageReviewDto,
    user: RequestUser
  ) {
    const review = await this.findReviewOrThrow(id);
    await this.assertAtLeastOneReadableEvidence(review);
    return toMileageReviewView(
      await this.getSettlementService().settleReview({
        expectedLockVersion: dto.lockVersion,
        idempotencyKey: dto.idempotencyKey,
        reviewId: id,
        userId: user.id
      })
    );
  }

  async voidAndReopenReview(
    id: string,
    dto: VoidMileageReviewDto,
    user: RequestUser
  ) {
    const result = await this.getSettlementService().voidAndReopenReview({
      expectedLockVersion: dto.lockVersion,
      reason: dto.reason,
      reviewId: id,
      userId: user.id
    });
    return {
      replacementReview: toMileageReviewView(result.replacementReview),
      voidedReview: toMileageReviewView(result.voidedReview)
    };
  }

  private async findReviewOrThrow(id: string) {
    const review = await this.repository.findById(id);
    if (!review || review.deletedAt) {
      throw new NotFoundException("Mileage review not found.");
    }
    return review;
  }

  private async findCustomerReviewOrThrow(id: string, customerId: string) {
    const review = await this.repository.findByIdForCustomer(id, customerId);
    if (!review || review.deletedAt) {
      throw new NotFoundException("Mileage review not found.");
    }
    return review;
  }

  private async assertAtLeastOneReadableEvidence(
    review: MileageReviewRecord
  ) {
    const evidence = review.evidence.filter(
      (item) => !item.deletedAt && item.file.mimeType?.startsWith("image/")
    );
    if (evidence.length === 0) {
      throw new BadRequestException(
        "At least one readable image evidence file is required."
      );
    }
    for (const item of evidence) {
      try {
        await this.assertEvidenceReadable(item.file);
        return;
      } catch {
        // Continue until at least one attached image can be read.
      }
    }
    throw new BadRequestException(
      "At least one readable image evidence file is required."
    );
  }

  private async assertEvidenceReadable(file: {
    bucket: string;
    mimeType: string | null;
    objectKey: string;
    sizeBytes: bigint;
  }) {
    try {
      const downloaded = await this.getStorageService().getObject(
        file.bucket,
        file.objectKey
      );
      const readableType = downloaded.contentType ?? file.mimeType;
      if (
        !readableType?.startsWith("image/") ||
        downloaded.contentLength === 0
      ) {
        downloaded.stream.destroy();
        throw new Error("not a readable image");
      }
      downloaded.stream.destroy();
    } catch {
      throw new BadRequestException(
        "Evidence file cannot be read from private storage."
      );
    }
  }

  private getStorageService() {
    if (!this.storageService) {
      throw new Error("Storage service is unavailable.");
    }
    return this.storageService;
  }

  private getSettlementService() {
    if (!this.settlementService) {
      throw new Error("Mileage review settlement service is unavailable.");
    }
    return this.settlementService;
  }
}

export function deriveOverdue(
  review: Pick<{ dueAt: Date; status: OrderMileageReviewStatus }, "dueAt" | "status">,
  asOf = new Date()
) {
  assertValidAsOf(asOf);
  assertValidAsOf(review.dueAt);
  return (
    review.status === OrderMileageReviewStatus.PENDING_SUBMISSION &&
    asOf.getTime() > review.dueAt.getTime()
  );
}

function assertValidAsOf(value: Date) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError("Mileage review evaluation time must be valid.");
  }
}

function editableStatuses(): OrderMileageReviewStatus[] {
  return [
    OrderMileageReviewStatus.PENDING_SUBMISSION,
    OrderMileageReviewStatus.RETURNED
  ];
}

function assertEditableReview(status: OrderMileageReviewStatus) {
  if (!editableStatuses().includes(status)) {
    throw new BadRequestException(
      "Mileage review is not editable in its current status."
    );
  }
}

function assertCustomerReviewWritable(review: MileageReviewRecord) {
  if (review.order.orderStatus !== OrderStatus.ACTIVE) {
    throw new BadRequestException(
      "Final-order mileage review history is read-only."
    );
  }
}

function parseReviewDate(value: string, field: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`${field} must be a valid timestamp.`);
  }
  return parsed;
}

function assertPrivateImageFile(file: {
  bucket: string;
  mimeType: string | null;
  objectKey: string;
  sizeBytes: bigint;
}) {
  if (!file.mimeType?.startsWith("image/")) {
    throw new BadRequestException(
      "Mileage review evidence must be an image."
    );
  }
  if (
    !file.bucket.trim() ||
    !file.objectKey.trim() ||
    /^https?:\/\//i.test(file.objectKey) ||
    file.sizeBytes <= 0n
  ) {
    throw new BadRequestException(
      "Mileage review evidence must reference a private stored object."
    );
  }
}

function safeMetadata(value?: Record<string, unknown>): Prisma.InputJsonObject | undefined {
  if (!value) {
    return undefined;
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > 16_384) {
    throw new BadRequestException("Evidence metadata is too large.");
  }
  return JSON.parse(serialized) as Prisma.InputJsonObject;
}

function toMileageReviewView(
  review: MileageReviewRecord,
  routePrefix = "/api/mileage-reviews"
) {
  const { evidence, ...rest } = review;
  return {
    ...(serializeForApi(rest) as Record<string, unknown>),
    lockVersion: review.lockVersion,
    evidence: evidence.map((item) => {
      const { file, ...evidenceRest } = item;
      const route = `${routePrefix}/${encodeURIComponent(
        review.id
      )}/evidence/${encodeURIComponent(item.id)}`;
      return {
        ...(serializeForApi(evidenceRest) as Record<string, unknown>),
        downloadUrl: `${route}/download`,
        mimeType: file.mimeType,
        originalName: file.originalName,
        previewUrl: file.mimeType?.startsWith("image/")
          ? `${route}/preview`
          : null,
        sizeBytes: file.sizeBytes.toString()
      };
    })
  };
}

function serializeForApi(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(serializeForApi);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        serializeForApi(nested)
      ])
    );
  }
  return value;
}
