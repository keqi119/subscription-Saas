import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  StreamableFile,
  UseGuards
} from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import {
  AttachMileageReviewEvidenceDto,
  MileageReviewListQueryDto,
  MileageReviewVersionDto,
  ReturnMileageReviewDto,
  SaveAdminMileageReviewDraftDto,
  VoidMileageReviewDto
} from "./dto/mileage-review.dto";
import { MileageReviewService } from "./mileage-review.service";

@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class MileageReviewController {
  constructor(private readonly mileageReviewService: MileageReviewService) {}

  @Get("mileage-reviews")
  @RequirePermissions(PermissionCode.MILEAGE_REVIEW_VIEW)
  listReviews(@Query() query: MileageReviewListQueryDto) {
    return this.mileageReviewService.listReviews(query);
  }

  @Get("orders/:orderId/mileage-reviews")
  @RequirePermissions(PermissionCode.MILEAGE_REVIEW_VIEW)
  listOrderReviews(
    @Param("orderId") orderId: string,
    @Query() query: MileageReviewListQueryDto
  ) {
    return this.mileageReviewService.listReviews({ ...query, orderId });
  }

  @Get("mileage-reviews/:id")
  @RequirePermissions(PermissionCode.MILEAGE_REVIEW_VIEW)
  getReview(@Param("id") id: string) {
    return this.mileageReviewService.getReview(id);
  }

  @Get("mileage-reviews/:id/evidence/:evidenceId/preview")
  @RequirePermissions(PermissionCode.MILEAGE_REVIEW_VIEW)
  async previewEvidence(
    @Param("id") id: string,
    @Param("evidenceId") evidenceId: string
  ) {
    const file = await this.mileageReviewService.getEvidenceObject(
      id,
      evidenceId
    );
    return new StreamableFile(file.stream, {
      disposition: contentDisposition("inline", file.originalName),
      length: file.contentLength,
      type: file.mimeType ?? "application/octet-stream"
    });
  }

  @Get("mileage-reviews/:id/evidence/:evidenceId/download")
  @RequirePermissions(PermissionCode.MILEAGE_REVIEW_VIEW)
  async downloadEvidence(
    @Param("id") id: string,
    @Param("evidenceId") evidenceId: string
  ) {
    const file = await this.mileageReviewService.getEvidenceObject(
      id,
      evidenceId
    );
    return new StreamableFile(file.stream, {
      disposition: contentDisposition("attachment", file.originalName),
      length: file.contentLength,
      type: file.mimeType ?? "application/octet-stream"
    });
  }

  @Put("mileage-reviews/:id/admin-draft")
  @RequirePermissions(PermissionCode.MILEAGE_REVIEW_SUBMIT)
  saveAdminDraft(
    @Param("id") id: string,
    @Body() dto: SaveAdminMileageReviewDraftDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.mileageReviewService.saveAdminDraft(id, dto, request.user);
  }

  @Post("mileage-reviews/:id/evidence")
  @RequirePermissions(PermissionCode.MILEAGE_REVIEW_SUBMIT)
  attachEvidence(
    @Param("id") id: string,
    @Body() dto: AttachMileageReviewEvidenceDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.mileageReviewService.attachEvidence(id, dto, request.user);
  }

  @Delete("mileage-reviews/:id/evidence/:evidenceId")
  @RequirePermissions(PermissionCode.MILEAGE_REVIEW_SUBMIT)
  removeEvidence(
    @Param("id") id: string,
    @Param("evidenceId") evidenceId: string,
    @Body() dto: MileageReviewVersionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.mileageReviewService.removeEvidence(
      id,
      evidenceId,
      dto,
      request.user
    );
  }

  @Post("mileage-reviews/:id/submit")
  @RequirePermissions(PermissionCode.MILEAGE_REVIEW_SUBMIT)
  submitReview(
    @Param("id") id: string,
    @Body() dto: MileageReviewVersionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.mileageReviewService.submitReview(id, dto, request.user);
  }

  @Post("mileage-reviews/:id/return")
  @RequirePermissions(PermissionCode.MILEAGE_REVIEW_RETURN)
  returnReview(
    @Param("id") id: string,
    @Body() dto: ReturnMileageReviewDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.mileageReviewService.returnReview(id, dto, request.user);
  }

  @Post("mileage-reviews/:id/confirm")
  @RequirePermissions(PermissionCode.MILEAGE_REVIEW_CONFIRM)
  confirmReview(
    @Param("id") id: string,
    @Body() dto: MileageReviewVersionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.mileageReviewService.confirmReview(id, dto, request.user);
  }

  @Post("mileage-reviews/:id/void-reopen")
  @RequirePermissions(PermissionCode.MILEAGE_REVIEW_VOID)
  voidAndReopenReview(
    @Param("id") id: string,
    @Body() dto: VoidMileageReviewDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.mileageReviewService.voidAndReopenReview(
      id,
      dto,
      request.user
    );
  }
}

function contentDisposition(
  mode: "attachment" | "inline",
  originalName: string
) {
  return `${mode}; filename*=UTF-8''${encodeURIComponent(originalName)}`;
}
