import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
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

import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { RequireAnyPermissions, RequirePermissions } from "../auth/auth.decorators";
import { PermissionsGuard } from "../auth/permissions.guard";
import {
  ApproveApplicationDto,
  NeedMoreInfoDto,
  RejectApplicationDto,
  SubmitApplicationDto
} from "./dto/application-review.dto";
import { CreateApplicationDto } from "./dto/create-application.dto";
import { CreateCustomerDto } from "./dto/create-customer.dto";
import { CreateFollowupDto } from "./dto/create-followup.dto";
import {
  CreateMaterialDto,
  DeleteMaterialFileDto,
  ReviewMaterialDto
} from "./dto/create-material.dto";
import { CreateSelfServiceApplicationDto } from "./dto/create-self-service-application.dto";
import { UpdateApplicationDto } from "./dto/update-application.dto";
import { UpdateCustomerDto } from "./dto/update-customer.dto";
import { CustomerService, UploadedMaterialFile } from "./customer.service";

@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class CustomerController {
  constructor(private readonly customerService: CustomerService) {}

  @Get("customers")
  @RequirePermissions(PermissionCode.CUSTOMER_VIEW)
  listCustomers(@Req() request: AuthenticatedRequest) {
    return this.customerService.listCustomers(request.user);
  }

  @Post("customers")
  @RequirePermissions(PermissionCode.CUSTOMER_MANAGE)
  createCustomer(@Body() dto: CreateCustomerDto, @Req() request: AuthenticatedRequest) {
    return this.customerService.createCustomer(dto, request.user, requestContext(request));
  }

  @Get("customers/:id")
  @RequirePermissions(PermissionCode.CUSTOMER_VIEW)
  getCustomer(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.customerService.getCustomer(id, request.user);
  }

  @Patch("customers/:id")
  @RequirePermissions(PermissionCode.CUSTOMER_MANAGE)
  updateCustomer(
    @Param("id") id: string,
    @Body() dto: UpdateCustomerDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.customerService.updateCustomer(id, dto, request.user, requestContext(request));
  }

  @Get("customers/:id/followups")
  @RequirePermissions(PermissionCode.CUSTOMER_VIEW)
  listFollowups(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.customerService.listFollowups(id, request.user);
  }

  @Post("customers/:id/followups")
  @RequirePermissions(PermissionCode.CUSTOMER_MANAGE)
  createFollowup(
    @Param("id") id: string,
    @Body() dto: CreateFollowupDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.customerService.createFollowup(id, dto, request.user, requestContext(request));
  }

  @Get("applications")
  @RequirePermissions(PermissionCode.APPLICATION_VIEW)
  listApplications(@Req() request: AuthenticatedRequest) {
    return this.customerService.listApplications(request.user);
  }

  @Post("applications")
  @RequirePermissions(PermissionCode.APPLICATION_MANAGE)
  createApplication(@Body() dto: CreateApplicationDto, @Req() request: AuthenticatedRequest) {
    return this.customerService.createApplication(dto, request.user, requestContext(request));
  }

  @Post("self-service-applications")
  @RequireAnyPermissions(PermissionCode.APPLICATION_MANAGE, PermissionCode.APPLICATION_SUBMIT)
  createSelfServiceApplication(
    @Body() dto: CreateSelfServiceApplicationDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.customerService.createSelfServiceApplication(dto, request.user, requestContext(request));
  }

  @Get("applications/:id")
  @RequirePermissions(PermissionCode.APPLICATION_VIEW)
  getApplication(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.customerService.getApplication(id, request.user);
  }

  @Patch("applications/:id")
  @RequirePermissions(PermissionCode.APPLICATION_MANAGE)
  updateApplication(
    @Param("id") id: string,
    @Body() dto: UpdateApplicationDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.customerService.updateApplication(id, dto, request.user, requestContext(request));
  }

  @Post("applications/:id/submit")
  @RequirePermissions(PermissionCode.APPLICATION_SUBMIT)
  submitApplication(
    @Param("id") id: string,
    @Body() dto: SubmitApplicationDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.customerService.submitApplication(id, dto, request.user, requestContext(request));
  }

  @Post("applications/:id/materials")
  @RequirePermissions(PermissionCode.APPLICATION_MATERIAL_UPLOAD)
  @UseInterceptors(AnyFilesInterceptor())
  uploadMaterial(
    @Param("id") id: string,
    @Body() dto: CreateMaterialDto,
    @UploadedFiles() files: UploadedMaterialFile[],
    @Req() request: AuthenticatedRequest
  ) {
    return this.customerService.uploadMaterial(
      id,
      dto,
      files,
      request.user,
      requestContext(request)
    );
  }

  @Get("applications/:id/material-files/:fileRecordId/preview")
  @RequirePermissions(PermissionCode.APPLICATION_VIEW)
  async previewMaterialFile(
    @Param("id") id: string,
    @Param("fileRecordId") fileRecordId: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response
  ) {
    const preview = await this.customerService.previewMaterialFile(id, fileRecordId, request.user);
    response.setHeader("Content-Type", preview.mimeType ?? "application/octet-stream");
    response.setHeader("Content-Length", String(preview.sizeBytes));
    response.setHeader(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(preview.filename)}`
    );
    return new StreamableFile(preview.stream);
  }

  @Get("applications/:id/materials/:materialId/preview")
  @RequirePermissions(PermissionCode.APPLICATION_VIEW)
  async previewMaterial(
    @Param("id") id: string,
    @Param("materialId") materialId: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response
  ) {
    const preview = await this.customerService.previewMaterial(id, materialId, request.user);
    response.setHeader("Content-Type", preview.mimeType ?? "application/octet-stream");
    response.setHeader("Content-Length", String(preview.sizeBytes));
    response.setHeader(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(preview.filename)}`
    );
    return new StreamableFile(preview.stream);
  }

  @Delete("applications/:id/material-files/:fileRecordId")
  @RequirePermissions(PermissionCode.APPLICATION_MATERIAL_DELETE)
  deleteMaterialFile(
    @Param("id") id: string,
    @Param("fileRecordId") fileRecordId: string,
    @Body() dto: DeleteMaterialFileDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.customerService.deleteMaterialFile(
      id,
      fileRecordId,
      dto,
      request.user,
      requestContext(request)
    );
  }

  @Post("applications/:id/material-groups/:materialGroupId/review")
  @RequirePermissions(PermissionCode.APPLICATION_REVIEW)
  reviewMaterialGroup(
    @Param("id") id: string,
    @Param("materialGroupId") materialGroupId: string,
    @Body() dto: ReviewMaterialDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.customerService.reviewMaterialGroup(
      id,
      materialGroupId,
      dto,
      request.user,
      requestContext(request)
    );
  }

  @Post("applications/:id/materials/:materialId/review")
  @RequirePermissions(PermissionCode.APPLICATION_REVIEW)
  reviewMaterial(
    @Param("id") id: string,
    @Param("materialId") materialId: string,
    @Body() dto: ReviewMaterialDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.customerService.reviewMaterial(
      id,
      materialId,
      dto,
      request.user,
      requestContext(request)
    );
  }

  @Post("applications/:id/need-more-info")
  @RequirePermissions(PermissionCode.APPLICATION_REVIEW)
  needMoreInfo(
    @Param("id") id: string,
    @Body() dto: NeedMoreInfoDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.customerService.needMoreInfo(id, dto, request.user, requestContext(request));
  }

  @Post("applications/:id/approve")
  @RequirePermissions(PermissionCode.APPLICATION_REVIEW)
  approveApplication(
    @Param("id") id: string,
    @Body() dto: ApproveApplicationDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.customerService.approveApplication(id, dto, request.user, requestContext(request));
  }

  @Post("applications/:id/reject")
  @RequirePermissions(PermissionCode.APPLICATION_REVIEW)
  rejectApplication(
    @Param("id") id: string,
    @Body() dto: RejectApplicationDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.customerService.rejectApplication(id, dto, request.user, requestContext(request));
  }
}

function requestContext(request: AuthenticatedRequest) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}
