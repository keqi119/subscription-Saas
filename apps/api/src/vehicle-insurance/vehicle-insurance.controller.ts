import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
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
  CreateInsuranceClaimDto,
  CreateVehicleInsurancePolicyDto,
  DeleteVehicleInsurancePolicyDto,
  InsuranceClaimsQueryDto,
  PutVehicleInsuranceCoveragesDto,
  UpdateInsuranceClaimDto,
  UpdateInsuranceClaimStatusDto,
  UpdateVehicleDocumentDto,
  UpdateVehicleInsurancePolicyDto,
  UploadPolicyDocumentsDto,
  UploadVehicleDocumentBatchDto,
  UploadVehicleDocumentDto,
  VehicleInsurancePoliciesQueryDto
} from "./dto/vehicle-insurance.dto";
import { UploadedVehicleDocumentFile, VehicleInsuranceService } from "./vehicle-insurance.service";

@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class VehicleInsuranceController {
  constructor(private readonly vehicleInsuranceService: VehicleInsuranceService) {}

  @Get("vehicle-insurance-policies")
  @RequirePermissions(PermissionCode.VEHICLE_INSURANCE_VIEW)
  listPolicies(@Query() query: VehicleInsurancePoliciesQueryDto) {
    return this.vehicleInsuranceService.listPolicies(query);
  }

  @Get("vehicle-insurance-policies/:id")
  @RequirePermissions(PermissionCode.VEHICLE_INSURANCE_VIEW)
  getPolicy(@Param("id") id: string) {
    return this.vehicleInsuranceService.getPolicy(id);
  }

  @Post("vehicles/:id/insurance-policies")
  @RequirePermissions(PermissionCode.VEHICLE_INSURANCE_MANAGE)
  createPolicy(
    @Param("id") id: string,
    @Body() dto: CreateVehicleInsurancePolicyDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleInsuranceService.createPolicy(id, dto, request.user);
  }

  @Patch("vehicle-insurance-policies/:id")
  @RequirePermissions(PermissionCode.VEHICLE_INSURANCE_MANAGE)
  updatePolicy(
    @Param("id") id: string,
    @Body() dto: UpdateVehicleInsurancePolicyDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleInsuranceService.updatePolicy(id, dto, request.user);
  }

  @Delete("vehicle-insurance-policies/:id")
  @RequirePermissions(PermissionCode.VEHICLE_INSURANCE_MANAGE)
  deletePolicy(
    @Param("id") id: string,
    @Body() dto: DeleteVehicleInsurancePolicyDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleInsuranceService.deletePolicy(id, dto, request.user);
  }

  @Post("vehicle-insurance-policies/:id/archive")
  @RequirePermissions(PermissionCode.VEHICLE_INSURANCE_MANAGE)
  archivePolicy(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.vehicleInsuranceService.archivePolicy(id, request.user);
  }

  @Put("vehicle-insurance-policies/:id/coverages")
  @RequirePermissions(PermissionCode.VEHICLE_INSURANCE_MANAGE)
  putCoverages(@Param("id") id: string, @Body() dto: PutVehicleInsuranceCoveragesDto) {
    return this.vehicleInsuranceService.putCoverages(id, dto);
  }

  @Post("vehicle-insurance-policies/:id/documents")
  @RequirePermissions(PermissionCode.VEHICLE_INSURANCE_MANAGE)
  @UseInterceptors(AnyFilesInterceptor(createUtf8MultipartOptions({ limits: { files: 20 } })))
  uploadPolicyDocuments(
    @Param("id") id: string,
    @Body() dto: UploadPolicyDocumentsDto,
    @UploadedFiles() files: UploadedVehicleDocumentFile[] | undefined,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleInsuranceService.uploadPolicyDocuments(id, dto, files, request.user);
  }

  @Get("vehicles/:id/documents")
  @RequirePermissions(PermissionCode.VEHICLE_DOCUMENT_VIEW)
  listDocuments(@Param("id") id: string) {
    return this.vehicleInsuranceService.listDocuments(id);
  }

  @Get("vehicles/:id/document-batches")
  @RequirePermissions(PermissionCode.VEHICLE_DOCUMENT_VIEW)
  listDocumentBatches(@Param("id") id: string) {
    return this.vehicleInsuranceService.listDocumentBatches(id);
  }

  @Post("vehicles/:id/documents")
  @RequirePermissions(PermissionCode.VEHICLE_DOCUMENT_MANAGE)
  @UseInterceptors(AnyFilesInterceptor(createUtf8MultipartOptions()))
  uploadDocument(
    @Param("id") id: string,
    @Body() dto: UploadVehicleDocumentDto,
    @UploadedFiles() files: UploadedVehicleDocumentFile[] | undefined,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleInsuranceService.uploadDocument(id, dto, files, request.user);
  }

  @Post("vehicles/:id/document-batches")
  @RequirePermissions(PermissionCode.VEHICLE_DOCUMENT_MANAGE)
  @UseInterceptors(AnyFilesInterceptor(createUtf8MultipartOptions()))
  uploadDocumentBatch(
    @Param("id") id: string,
    @Body() dto: UploadVehicleDocumentBatchDto,
    @UploadedFiles() files: UploadedVehicleDocumentFile[] | undefined,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleInsuranceService.uploadDocumentBatch(id, dto, files, request.user);
  }

  @Post("vehicle-document-batches/:batchId/archive")
  @RequirePermissions(PermissionCode.VEHICLE_DOCUMENT_MANAGE)
  archiveDocumentBatch(@Param("batchId") batchId: string) {
    return this.vehicleInsuranceService.archiveDocumentBatch(batchId);
  }

  @Patch("vehicle-documents/:id")
  @RequirePermissions(PermissionCode.VEHICLE_DOCUMENT_MANAGE)
  updateDocument(@Param("id") id: string, @Body() dto: UpdateVehicleDocumentDto) {
    return this.vehicleInsuranceService.updateDocument(id, dto);
  }

  @Delete("vehicle-documents/:id")
  @RequirePermissions(PermissionCode.VEHICLE_DOCUMENT_MANAGE)
  deleteDocument(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.vehicleInsuranceService.deleteDocument(id, request.user);
  }

  @Get("vehicle-documents/:id/preview")
  @RequirePermissions(PermissionCode.VEHICLE_DOCUMENT_VIEW)
  async previewDocument(@Param("id") id: string, @Res({ passthrough: true }) response: Response) {
    const preview = await this.vehicleInsuranceService.previewDocument(id);
    response.setHeader("Content-Type", preview.mimeType ?? "application/octet-stream");
    response.setHeader("Content-Length", String(preview.sizeBytes));
    response.setHeader(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(preview.filename)}`
    );
    return new StreamableFile(preview.stream);
  }

  @Get("insurance-claims")
  @RequirePermissions(PermissionCode.INSURANCE_CLAIM_VIEW)
  listClaims(@Query() query: InsuranceClaimsQueryDto) {
    return this.vehicleInsuranceService.listClaims(query);
  }

  @Get("insurance-claims/:id")
  @RequirePermissions(PermissionCode.INSURANCE_CLAIM_VIEW)
  getClaim(@Param("id") id: string) {
    return this.vehicleInsuranceService.getClaim(id);
  }

  @Post("service-cases/:id/insurance-claims")
  @RequirePermissions(PermissionCode.INSURANCE_CLAIM_MANAGE)
  createClaim(
    @Param("id") id: string,
    @Body() dto: CreateInsuranceClaimDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleInsuranceService.createClaimFromServiceCase(id, dto, request.user);
  }

  @Patch("insurance-claims/:id")
  @RequirePermissions(PermissionCode.INSURANCE_CLAIM_MANAGE)
  updateClaim(
    @Param("id") id: string,
    @Body() dto: UpdateInsuranceClaimDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleInsuranceService.updateClaim(id, dto, request.user);
  }

  @Post("insurance-claims/:id/status")
  @RequirePermissions(PermissionCode.INSURANCE_CLAIM_MANAGE)
  updateClaimStatus(
    @Param("id") id: string,
    @Body() dto: UpdateInsuranceClaimStatusDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleInsuranceService.updateClaimStatus(id, dto, request.user);
  }
}
