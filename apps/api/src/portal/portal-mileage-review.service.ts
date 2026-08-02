import { BadRequestException, Injectable } from "@nestjs/common";

import { UploadedMaterialFile } from "../customer/customer.service";
import { MileageReviewService } from "../mileage-review/mileage-review.service";
import {
  detectRasterMimeType,
  isSupportedRasterMimeType
} from "../mileage-review/mileage-review-evidence";
import { StorageService } from "../storage/storage.service";
import { CurrentCustomer } from "./portal-auth.types";
import {
  PortalMileageReviewListQueryDto,
  PortalMileageReviewVersionDto,
  SavePortalMileageReviewDraftDto,
  UploadPortalMileageReviewEvidenceDto
} from "./portal-mileage-review.dto";

const MAX_EVIDENCE_BYTES = 20 * 1024 * 1024;

@Injectable()
export class PortalMileageReviewService {
  constructor(
    private readonly mileageReviewService: MileageReviewService,
    private readonly storageService: StorageService
  ) {}

  listReviews(currentCustomer: CurrentCustomer, query: PortalMileageReviewListQueryDto) {
    return this.mileageReviewService.listCustomerReviews(currentCustomer.customerId, query);
  }

  getReview(id: string, currentCustomer: CurrentCustomer) {
    return this.mileageReviewService.getCustomerReview(id, currentCustomer.customerId);
  }

  saveDraft(id: string, dto: SavePortalMileageReviewDraftDto, currentCustomer: CurrentCustomer) {
    return this.mileageReviewService.saveCustomerDraft(id, dto, currentCustomer.customerId);
  }

  async uploadEvidence(
    id: string,
    dto: UploadPortalMileageReviewEvidenceDto,
    files: UploadedMaterialFile[] | undefined,
    currentCustomer: CurrentCustomer
  ) {
    const file = (files ?? []).find((item) => item.buffer?.length);
    if (!file) {
      throw new BadRequestException("Mileage review evidence image is required.");
    }
    if (!file.mimetype?.startsWith("image/")) {
      throw new BadRequestException("Mileage review evidence must be an image.");
    }
    if (!isSupportedRasterMimeType(file.mimetype)) {
      throw new BadRequestException("Mileage review evidence must be a JPEG, PNG, or WebP image.");
    }
    const detectedMimeType = detectRasterMimeType(file.buffer);
    if (detectedMimeType !== file.mimetype) {
      throw new BadRequestException(
        "Mileage review evidence content does not match its image type."
      );
    }
    if (file.size <= 0 || file.size > MAX_EVIDENCE_BYTES) {
      throw new BadRequestException("Mileage review evidence image must not exceed 20 MB.");
    }
    const metadata = parseMetadata(dto.metadata);
    const stored = await this.storageService.putMileageReviewEvidence({
      buffer: file.buffer,
      contentType: detectedMimeType,
      customerId: currentCustomer.customerId,
      originalName: file.originalname,
      reviewId: id
    });

    try {
      return await this.mileageReviewService.attachCustomerEvidence(
        id,
        {
          bucket: stored.bucket,
          capturedAt: dto.capturedAt,
          lockVersion: dto.lockVersion,
          metadata,
          mimeType: detectedMimeType,
          objectKey: stored.objectKey,
          originalName: file.originalname,
          sizeBytes: BigInt(file.size)
        },
        currentCustomer.customerId
      );
    } catch (error) {
      await this.storageService
        .deleteObject(stored.bucket, stored.objectKey)
        .catch(() => undefined);
      throw error;
    }
  }

  removeEvidence(
    id: string,
    evidenceId: string,
    dto: PortalMileageReviewVersionDto,
    currentCustomer: CurrentCustomer
  ) {
    return this.mileageReviewService.removeCustomerEvidence(
      id,
      evidenceId,
      dto,
      currentCustomer.customerId
    );
  }

  submitReview(id: string, dto: PortalMileageReviewVersionDto, currentCustomer: CurrentCustomer) {
    return this.mileageReviewService.submitCustomerReview(id, dto, currentCustomer.customerId);
  }

  getEvidenceObject(id: string, evidenceId: string, currentCustomer: CurrentCustomer) {
    return this.mileageReviewService.getCustomerEvidenceObject(
      id,
      evidenceId,
      currentCustomer.customerId
    );
  }
}

function parseMetadata(value?: string): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new BadRequestException("Evidence metadata must be a JSON object.");
  }
}
