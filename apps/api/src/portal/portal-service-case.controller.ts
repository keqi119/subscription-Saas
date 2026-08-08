import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors
} from "@nestjs/common";
import { AnyFilesInterceptor } from "@nestjs/platform-express";
import type { Request, Response } from "express";

import {
  CancelPortalServiceCaseDto,
  CreatePortalServiceCaseDto,
  PortalServiceCasesQueryDto
} from "../service-case/dto/service-case.dto";
import { ServiceCaseService, UploadedServiceCaseFile } from "../service-case/service-case.service";
import { createUtf8MultipartOptions } from "../upload/multipart-upload-options";
import { CustomerAuthGuard } from "./portal-auth.guard";
import { CurrentCustomer } from "./portal-auth.types";
import { CurrentPortalCustomer } from "./portal-current-customer.decorator";

@Controller("portal/service-cases")
@UseGuards(CustomerAuthGuard)
export class PortalServiceCaseController {
  constructor(private readonly serviceCaseService: ServiceCaseService) {}

  @Post()
  createServiceCase(
    @Body() dto: CreatePortalServiceCaseDto,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Req() request: Request
  ) {
    return this.serviceCaseService.createPortalServiceCase(
      dto,
      currentCustomer,
      requestContext(request)
    );
  }

  @Get()
  listServiceCases(
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Query() query: PortalServiceCasesQueryDto
  ) {
    return this.serviceCaseService.listPortalServiceCases(currentCustomer, query);
  }

  @Get(":id")
  getServiceCase(
    @Param("id") id: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.serviceCaseService.getPortalServiceCase(id, currentCustomer);
  }

  @Post(":id/attachments")
  @UseInterceptors(AnyFilesInterceptor(createUtf8MultipartOptions()))
  uploadAttachments(
    @Param("id") id: string,
    @UploadedFiles() files: UploadedServiceCaseFile[],
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Req() request: Request
  ) {
    return this.serviceCaseService.uploadPortalAttachments(
      id,
      files,
      currentCustomer,
      requestContext(request)
    );
  }

  @Get(":id/attachments/:attachmentId/preview")
  async previewAttachment(
    @Param("id") id: string,
    @Param("attachmentId") attachmentId: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Res({ passthrough: true }) response: Response
  ) {
    const preview = await this.serviceCaseService.previewPortalAttachment(
      id,
      attachmentId,
      currentCustomer
    );
    response.setHeader("Content-Type", preview.mimeType ?? "application/octet-stream");
    response.setHeader("Content-Length", String(preview.sizeBytes));
    response.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(preview.filename)}"`
    );
    return new StreamableFile(preview.stream);
  }

  @Post(":id/cancel")
  cancelServiceCase(
    @Param("id") id: string,
    @Body() dto: CancelPortalServiceCaseDto,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Req() request: Request
  ) {
    return this.serviceCaseService.cancelPortalServiceCase(
      id,
      dto,
      currentCustomer,
      requestContext(request)
    );
  }
}

function requestContext(request: Request) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}
