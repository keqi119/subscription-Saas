import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
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
import { PermissionCode } from "@subscription-saas/shared";
import type { Response } from "express";

import { RequirePermissions } from "../auth/auth.decorators";
import { createUtf8MultipartOptions } from "../upload/multipart-upload-options";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import {
  CreateVehicleBaasContractDto,
  CreateVehicleBaasCostRecordDto,
  GenerateVehicleBaasCostRecordsDto,
  UpdateVehicleBaasContractDto,
  UpdateVehicleBaasCostRecordDto,
  UploadVehicleBaasContractAttachmentDto,
  VehicleBaasContractsQueryDto,
  VehicleBaasCostRecordActionDto,
  VehicleBaasCostRecordsQueryDto
} from "./dto/vehicle-baas.dto";
import { UploadedVehicleBaasAttachmentFile, VehicleBaasService } from "./vehicle-baas.service";

@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class VehicleBaasController {
  constructor(private readonly vehicleBaasService: VehicleBaasService) {}

  @Get("vehicle-baas-contracts")
  @RequirePermissions(PermissionCode.VEHICLE_BAAS_VIEW)
  listContracts(@Query() query: VehicleBaasContractsQueryDto) {
    return this.vehicleBaasService.listContracts(query);
  }

  @Get("vehicle-baas-contracts/:id")
  @RequirePermissions(PermissionCode.VEHICLE_BAAS_VIEW)
  getContract(@Param("id") id: string) {
    return this.vehicleBaasService.getContract(id);
  }

  @Post("vehicles/:id/baas-contracts")
  @RequirePermissions(PermissionCode.VEHICLE_BAAS_MANAGE)
  createContract(
    @Param("id") id: string,
    @Body() dto: CreateVehicleBaasContractDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleBaasService.createContract(id, dto, request.user);
  }

  @Patch("vehicle-baas-contracts/:id")
  @RequirePermissions(PermissionCode.VEHICLE_BAAS_MANAGE)
  updateContract(
    @Param("id") id: string,
    @Body() dto: UpdateVehicleBaasContractDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleBaasService.updateContract(id, dto, request.user);
  }

  @Post("vehicle-baas-contracts/:id/activate")
  @RequirePermissions(PermissionCode.VEHICLE_BAAS_MANAGE)
  activateContract(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.vehicleBaasService.activateContract(id, request.user);
  }

  @Post("vehicle-baas-contracts/:id/suspend")
  @RequirePermissions(PermissionCode.VEHICLE_BAAS_MANAGE)
  suspendContract(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.vehicleBaasService.suspendContract(id, request.user);
  }

  @Post("vehicle-baas-contracts/:id/terminate")
  @RequirePermissions(PermissionCode.VEHICLE_BAAS_MANAGE)
  terminateContract(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.vehicleBaasService.terminateContract(id, request.user);
  }

  @Post("vehicle-baas-contracts/:id/archive")
  @RequirePermissions(PermissionCode.VEHICLE_BAAS_MANAGE)
  archiveContract(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.vehicleBaasService.archiveContract(id, request.user);
  }

  @Get("vehicles/:id/baas-summary")
  @RequirePermissions(PermissionCode.VEHICLE_BAAS_VIEW)
  getVehicleBaasSummary(@Param("id") id: string) {
    return this.vehicleBaasService.getVehicleBaasSummary(id);
  }

  @Get("vehicle-baas-contracts/:id/attachments")
  @RequirePermissions(PermissionCode.VEHICLE_BAAS_VIEW)
  listAttachments(@Param("id") id: string) {
    return this.vehicleBaasService.listAttachments(id);
  }

  @Post("vehicle-baas-contracts/:id/attachments")
  @RequirePermissions(PermissionCode.VEHICLE_BAAS_MANAGE)
  @UseInterceptors(AnyFilesInterceptor(createUtf8MultipartOptions()))
  uploadAttachment(
    @Param("id") id: string,
    @Body() dto: UploadVehicleBaasContractAttachmentDto,
    @UploadedFiles() files: UploadedVehicleBaasAttachmentFile[] | undefined,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleBaasService.uploadAttachment(id, dto, files, request.user);
  }

  @Delete("vehicle-baas-contract-attachments/:id")
  @RequirePermissions(PermissionCode.VEHICLE_BAAS_MANAGE)
  deleteAttachment(@Param("id") id: string) {
    return this.vehicleBaasService.deleteAttachment(id);
  }

  @Get("vehicle-baas-contract-attachments/:id/preview")
  @RequirePermissions(PermissionCode.VEHICLE_BAAS_VIEW)
  async previewAttachment(@Param("id") id: string, @Res({ passthrough: true }) response: Response) {
    const preview = await this.vehicleBaasService.previewAttachment(id);
    response.setHeader("Content-Type", preview.mimeType ?? "application/octet-stream");
    response.setHeader("Content-Length", String(preview.sizeBytes));
    response.setHeader(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(preview.filename)}`
    );
    return new StreamableFile(preview.stream);
  }

  @Get("vehicle-baas-cost-records")
  @RequirePermissions(PermissionCode.VEHICLE_BAAS_VIEW)
  listCostRecords(@Query() query: VehicleBaasCostRecordsQueryDto) {
    return this.vehicleBaasService.listCostRecords(query);
  }

  @Get("vehicle-baas-contracts/:id/cost-records")
  @RequirePermissions(PermissionCode.VEHICLE_BAAS_VIEW)
  listContractCostRecords(@Param("id") id: string, @Query() query: VehicleBaasCostRecordsQueryDto) {
    return this.vehicleBaasService.listContractCostRecords(id, query);
  }

  @Post("vehicle-baas-contracts/:id/cost-records/generate")
  @RequirePermissions(PermissionCode.VEHICLE_BAAS_MANAGE)
  generateCostRecords(
    @Param("id") id: string,
    @Body() dto: GenerateVehicleBaasCostRecordsDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleBaasService.generateCostRecords(id, dto, request.user);
  }

  @Post("vehicle-baas-contracts/:id/cost-records")
  @RequirePermissions(PermissionCode.VEHICLE_BAAS_MANAGE)
  createCostRecord(
    @Param("id") id: string,
    @Body() dto: CreateVehicleBaasCostRecordDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleBaasService.createCostRecord(id, dto, request.user);
  }

  @Patch("vehicle-baas-cost-records/:id")
  @RequirePermissions(PermissionCode.VEHICLE_BAAS_MANAGE)
  updateCostRecord(
    @Param("id") id: string,
    @Body() dto: UpdateVehicleBaasCostRecordDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleBaasService.updateCostRecord(id, dto, request.user);
  }

  @Post("vehicle-baas-cost-records/:id/confirm")
  @RequirePermissions(PermissionCode.VEHICLE_BAAS_MANAGE)
  confirmCostRecord(
    @Param("id") id: string,
    @Body() dto: VehicleBaasCostRecordActionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleBaasService.confirmCostRecord(id, dto, request.user);
  }

  @Post("vehicle-baas-cost-records/:id/mark-paid")
  @RequirePermissions(PermissionCode.VEHICLE_BAAS_MANAGE)
  markCostRecordPaid(
    @Param("id") id: string,
    @Body() dto: VehicleBaasCostRecordActionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleBaasService.markCostRecordPaid(id, dto, request.user);
  }

  @Post("vehicle-baas-cost-records/:id/void")
  @RequirePermissions(PermissionCode.VEHICLE_BAAS_MANAGE)
  voidCostRecord(
    @Param("id") id: string,
    @Body() dto: VehicleBaasCostRecordActionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleBaasService.voidCostRecord(id, dto, request.user);
  }
}
