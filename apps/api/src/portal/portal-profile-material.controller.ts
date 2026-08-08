import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Res,
  StreamableFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors
} from "@nestjs/common";
import { AnyFilesInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";

import { UploadedMaterialFile } from "../customer/customer.service";
import { createUtf8MultipartOptions } from "../upload/multipart-upload-options";
import { CustomerAuthGuard } from "./portal-auth.guard";
import { CurrentCustomer } from "./portal-auth.types";
import { CurrentPortalCustomer } from "./portal-current-customer.decorator";
import {
  UpdatePortalProfileMaterialDto,
  UploadPortalProfileMaterialDto
} from "./portal-profile-material.dto";
import { PortalProfileMaterialService } from "./portal-profile-material.service";

@Controller("portal/profile")
@UseGuards(CustomerAuthGuard)
export class PortalProfileMaterialController {
  constructor(private readonly profileMaterialService: PortalProfileMaterialService) {}

  @Get("material-requirements")
  getMaterialRequirements() {
    return this.profileMaterialService.getRequirements();
  }

  @Get("materials")
  listMaterials(@CurrentPortalCustomer() currentCustomer: CurrentCustomer) {
    return this.profileMaterialService.listMaterials(currentCustomer);
  }

  @Post("materials")
  @UseInterceptors(AnyFilesInterceptor(createUtf8MultipartOptions()))
  uploadMaterial(
    @Body() dto: UploadPortalProfileMaterialDto,
    @UploadedFiles() files: UploadedMaterialFile[] | undefined,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.profileMaterialService.uploadMaterial(dto, files, currentCustomer);
  }

  @Patch("materials/:id")
  updateMaterial(
    @Param("id") id: string,
    @Body() dto: UpdatePortalProfileMaterialDto,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.profileMaterialService.updateMaterial(id, dto, currentCustomer);
  }

  @Delete("materials/:id")
  deleteMaterial(
    @Param("id") id: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.profileMaterialService.deleteMaterial(id, currentCustomer);
  }

  @Get("materials/:id/preview")
  async previewMaterial(
    @Param("id") id: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Res({ passthrough: true }) response: Response
  ) {
    const preview = await this.profileMaterialService.previewMaterial(id, currentCustomer);
    response.setHeader("Content-Type", preview.mimeType ?? "application/octet-stream");
    response.setHeader("Content-Length", String(preview.sizeBytes));
    response.setHeader(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(preview.filename)}`
    );
    return new StreamableFile(preview.stream);
  }

  @Get("material-completeness")
  getMaterialCompleteness(@CurrentPortalCustomer() currentCustomer: CurrentCustomer) {
    return this.profileMaterialService.getCompleteness(currentCustomer);
  }
}
