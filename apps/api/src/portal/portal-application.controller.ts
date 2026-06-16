import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors
} from "@nestjs/common";
import { AnyFilesInterceptor } from "@nestjs/platform-express";
import type { Request, Response } from "express";

import { UploadedMaterialFile } from "../customer/customer.service";
import { CustomerAuthGuard } from "./portal-auth.guard";
import { CurrentCustomer } from "./portal-auth.types";
import { CurrentPortalCustomer } from "./portal-current-customer.decorator";
import { PortalApplicationService } from "./portal-application.service";
import {
  CreatePortalSelfServiceApplicationDto,
  UploadPortalApplicationMaterialDto
} from "./portal-application.dto";

@Controller("portal")
@UseGuards(CustomerAuthGuard)
export class PortalApplicationController {
  constructor(private readonly portalApplicationService: PortalApplicationService) {}

  @Post("self-service-applications")
  createApplication(
    @Body() dto: CreatePortalSelfServiceApplicationDto,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Req() request: Request
  ) {
    return this.portalApplicationService.createApplication(
      dto,
      currentCustomer,
      requestContext(request)
    );
  }

  @Get("applications")
  listApplications(@CurrentPortalCustomer() currentCustomer: CurrentCustomer) {
    return this.portalApplicationService.listApplications(currentCustomer);
  }

  @Get("applications/:id")
  getApplication(
    @Param("id") id: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.portalApplicationService.getApplication(id, currentCustomer);
  }

  @Post("applications/:id/cancel")
  cancelApplication(
    @Param("id") id: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Req() request: Request
  ) {
    return this.portalApplicationService.cancelApplication(
      id,
      currentCustomer,
      requestContext(request)
    );
  }

  @Get("applications/:id/materials")
  listMaterials(
    @Param("id") id: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.portalApplicationService.listMaterials(id, currentCustomer);
  }

  @Post("applications/:id/materials")
  @UseInterceptors(AnyFilesInterceptor())
  uploadMaterial(
    @Param("id") id: string,
    @Body() dto: UploadPortalApplicationMaterialDto,
    @UploadedFiles() files: UploadedMaterialFile[],
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Req() request: Request
  ) {
    return this.portalApplicationService.uploadMaterial(
      id,
      dto,
      files,
      currentCustomer,
      requestContext(request)
    );
  }

  @Get("applications/:id/materials/:materialId/preview")
  async previewMaterial(
    @Param("id") id: string,
    @Param("materialId") materialId: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Res({ passthrough: true }) response: Response
  ) {
    const preview = await this.portalApplicationService.previewMaterialFile(
      id,
      materialId,
      currentCustomer
    );
    response.setHeader("Content-Type", preview.mimeType ?? "application/octet-stream");
    response.setHeader("Content-Length", String(preview.sizeBytes));
    response.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(preview.filename)}"`);
    return new StreamableFile(preview.stream);
  }
}

function requestContext(request: Request) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}

