import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Res,
  StreamableFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors
} from "@nestjs/common";
import { AnyFilesInterceptor } from "@nestjs/platform-express";
import { PermissionCode } from "@subscription-saas/shared";
import type { Response } from "express";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import {
  PutVehicleListingPlansDto,
  UpdateVehicleListingMediaDto,
  UploadVehicleListingMediaDto,
  UpsertVehicleListingProfileDto
} from "./dto/vehicle-listing.dto";
import { UploadedVehicleListingFile, VehicleListingService } from "./vehicle-listing.service";

@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class VehicleListingController {
  constructor(private readonly vehicleListingService: VehicleListingService) {}

  @Get("vehicles/:id/listing-profile")
  @RequirePermissions(PermissionCode.VEHICLE_VIEW)
  getListingProfile(@Param("id") id: string) {
    return this.vehicleListingService.getListingProfile(id);
  }

  @Put("vehicles/:id/listing-profile")
  @RequirePermissions(PermissionCode.VEHICLE_MANAGE)
  upsertListingProfile(
    @Param("id") id: string,
    @Body() dto: UpsertVehicleListingProfileDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleListingService.upsertListingProfile(id, dto, request.user);
  }

  @Post("vehicles/:id/listing-profile/publish")
  @RequirePermissions(PermissionCode.VEHICLE_MANAGE)
  publishListingProfile(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.vehicleListingService.publishListingProfile(id, request.user);
  }

  @Post("vehicles/:id/listing-profile/unpublish")
  @RequirePermissions(PermissionCode.VEHICLE_MANAGE)
  unpublishListingProfile(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.vehicleListingService.unpublishListingProfile(id, request.user);
  }

  @Post("vehicles/:id/listing-media")
  @RequirePermissions(PermissionCode.VEHICLE_MANAGE)
  @UseInterceptors(AnyFilesInterceptor())
  uploadMedia(
    @Param("id") id: string,
    @Body() dto: UploadVehicleListingMediaDto,
    @UploadedFiles() files: UploadedVehicleListingFile[],
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleListingService.uploadMedia(id, dto, files, request.user);
  }

  @Get("vehicles/:id/listing-media")
  @RequirePermissions(PermissionCode.VEHICLE_VIEW)
  listMedia(@Param("id") id: string) {
    return this.vehicleListingService.listMedia(id);
  }

  @Patch("vehicles/:id/listing-media/:mediaId")
  @RequirePermissions(PermissionCode.VEHICLE_MANAGE)
  updateMedia(
    @Param("id") id: string,
    @Param("mediaId") mediaId: string,
    @Body() dto: UpdateVehicleListingMediaDto
  ) {
    return this.vehicleListingService.updateMedia(id, mediaId, dto);
  }

  @Delete("vehicles/:id/listing-media/:mediaId")
  @RequirePermissions(PermissionCode.VEHICLE_MANAGE)
  deleteMedia(@Param("id") id: string, @Param("mediaId") mediaId: string) {
    return this.vehicleListingService.deleteMedia(id, mediaId);
  }

  @Get("vehicles/:id/listing-media/:mediaId/preview")
  @RequirePermissions(PermissionCode.VEHICLE_VIEW)
  async previewMedia(
    @Param("id") id: string,
    @Param("mediaId") mediaId: string,
    @Res({ passthrough: true }) response: Response
  ) {
    const preview = await this.vehicleListingService.previewMedia(id, mediaId);
    response.setHeader("Content-Type", preview.mimeType ?? "application/octet-stream");
    response.setHeader("Content-Length", String(preview.sizeBytes));
    response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(preview.filename)}`);
    return new StreamableFile(preview.stream);
  }

  @Get("vehicles/:id/listing-plans")
  @RequirePermissions(PermissionCode.VEHICLE_VIEW)
  listListingPlans(@Param("id") id: string) {
    return this.vehicleListingService.listListingPlans(id);
  }

  @Put("vehicles/:id/listing-plans")
  @RequirePermissions(PermissionCode.VEHICLE_MANAGE)
  putListingPlans(
    @Param("id") id: string,
    @Body() dto: PutVehicleListingPlansDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleListingService.putListingPlans(id, dto, request.user);
  }
}
