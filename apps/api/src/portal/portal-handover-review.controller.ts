import { Body, Controller, Get, Param, Post, Res, StreamableFile, UseGuards } from "@nestjs/common";
import type { Response } from "express";

import { CustomerAuthGuard } from "./portal-auth.guard";
import { CurrentCustomer } from "./portal-auth.types";
import { CurrentPortalCustomer } from "./portal-current-customer.decorator";
import {
  ConfirmPortalHandoverReviewDto,
  ObjectPortalHandoverReviewDto
} from "./portal-handover-review.dto";
import { PortalHandoverReviewService } from "./portal-handover-review.service";

@Controller("portal/handover-reviews")
@UseGuards(CustomerAuthGuard)
export class PortalHandoverReviewController {
  constructor(private readonly portalHandoverReviewService: PortalHandoverReviewService) {}

  @Get()
  listReviews(@CurrentPortalCustomer() currentCustomer: CurrentCustomer) {
    return this.portalHandoverReviewService.listReviews(currentCustomer);
  }

  @Get(":id")
  getReview(
    @Param("id") id: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.portalHandoverReviewService.getReview(id, currentCustomer);
  }

  @Get(":id/evidence-files/:evidenceFileId/preview")
  async previewEvidenceFile(
    @Param("id") id: string,
    @Param("evidenceFileId") evidenceFileId: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Res({ passthrough: true }) response: Response
  ) {
    const preview = await this.portalHandoverReviewService.previewEvidenceFile(id, evidenceFileId, currentCustomer);
    setEvidenceFileHeaders(response, preview, "inline");
    return new StreamableFile(preview.stream);
  }

  @Get(":id/evidence-files/:evidenceFileId/download")
  async downloadEvidenceFile(
    @Param("id") id: string,
    @Param("evidenceFileId") evidenceFileId: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Res({ passthrough: true }) response: Response
  ) {
    const file = await this.portalHandoverReviewService.downloadEvidenceFile(id, evidenceFileId, currentCustomer);
    setEvidenceFileHeaders(response, file, "attachment");
    return new StreamableFile(file.stream);
  }

  @Post(":id/confirm")
  confirmNoObjection(
    @Param("id") id: string,
    @Body() dto: ConfirmPortalHandoverReviewDto,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.portalHandoverReviewService.confirmNoObjection(id, dto, currentCustomer);
  }

  @Post(":id/object")
  objectReview(
    @Param("id") id: string,
    @Body() dto: ObjectPortalHandoverReviewDto,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.portalHandoverReviewService.objectReview(id, dto, currentCustomer);
  }
}

function setEvidenceFileHeaders(
  response: Response,
  file: { filename: string; mimeType: null | string; sizeBytes: null | number },
  disposition: "attachment" | "inline"
) {
  if (file.mimeType) {
    response.setHeader("Content-Type", file.mimeType);
  }
  if (file.sizeBytes !== null) {
    response.setHeader("Content-Length", String(file.sizeBytes));
  }
  response.setHeader("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
}
