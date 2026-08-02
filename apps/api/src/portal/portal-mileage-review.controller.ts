import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Post,
  Put,
  Query,
  StreamableFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors
} from "@nestjs/common";
import { AnyFilesInterceptor } from "@nestjs/platform-express";

import { UploadedMaterialFile } from "../customer/customer.service";
import { CustomerAuthGuard } from "./portal-auth.guard";
import { CurrentCustomer } from "./portal-auth.types";
import { CurrentPortalCustomer } from "./portal-current-customer.decorator";
import {
  PortalMileageReviewListQueryDto,
  PortalMileageReviewVersionDto,
  SavePortalMileageReviewDraftDto,
  UploadPortalMileageReviewEvidenceDto
} from "./portal-mileage-review.dto";
import { PortalMileageReviewService } from "./portal-mileage-review.service";

@Controller("portal/mileage-reviews")
@UseGuards(CustomerAuthGuard)
export class PortalMileageReviewController {
  constructor(private readonly mileageReviewService: PortalMileageReviewService) {}

  @Get()
  listReviews(
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Query() query: PortalMileageReviewListQueryDto
  ) {
    return this.mileageReviewService.listReviews(currentCustomer, query);
  }

  @Get(":id")
  getReview(@Param("id") id: string, @CurrentPortalCustomer() currentCustomer: CurrentCustomer) {
    return this.mileageReviewService.getReview(id, currentCustomer);
  }

  @Put(":id/draft")
  saveDraft(
    @Param("id") id: string,
    @Body() dto: SavePortalMileageReviewDraftDto,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.mileageReviewService.saveDraft(id, dto, currentCustomer);
  }

  @Post(":id/evidence")
  @UseInterceptors(AnyFilesInterceptor({ limits: { fileSize: 20 * 1024 * 1024 } }))
  uploadEvidence(
    @Param("id") id: string,
    @Body() dto: UploadPortalMileageReviewEvidenceDto,
    @UploadedFiles() files: UploadedMaterialFile[] | undefined,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.mileageReviewService.uploadEvidence(id, dto, files, currentCustomer);
  }

  @Delete(":id/evidence/:evidenceId")
  removeEvidence(
    @Param("id") id: string,
    @Param("evidenceId") evidenceId: string,
    @Body() dto: PortalMileageReviewVersionDto,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.mileageReviewService.removeEvidence(id, evidenceId, dto, currentCustomer);
  }

  @Post(":id/submit")
  submitReview(
    @Param("id") id: string,
    @Body() dto: PortalMileageReviewVersionDto,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.mileageReviewService.submitReview(id, dto, currentCustomer);
  }

  @Get(":id/evidence/:evidenceId/preview")
  @Header("X-Content-Type-Options", "nosniff")
  async previewEvidence(
    @Param("id") id: string,
    @Param("evidenceId") evidenceId: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    const file = await this.mileageReviewService.getEvidenceObject(id, evidenceId, currentCustomer);
    return new StreamableFile(file.stream, {
      disposition: contentDisposition("inline", file.originalName),
      length: file.contentLength,
      type: file.mimeType ?? "application/octet-stream"
    });
  }

  @Get(":id/evidence/:evidenceId/download")
  @Header("X-Content-Type-Options", "nosniff")
  async downloadEvidence(
    @Param("id") id: string,
    @Param("evidenceId") evidenceId: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    const file = await this.mileageReviewService.getEvidenceObject(id, evidenceId, currentCustomer);
    return new StreamableFile(file.stream, {
      disposition: contentDisposition("attachment", file.originalName),
      length: file.contentLength,
      type: file.mimeType ?? "application/octet-stream"
    });
  }
}

function contentDisposition(type: "attachment" | "inline", filename: string) {
  return `${type}; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
