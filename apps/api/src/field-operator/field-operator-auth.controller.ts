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
import type { Request, Response } from "express";

import { DeclareNoVisibleDamageDto } from "../delivery-evidence/delivery-evidence.dto";
import { UpdateHandoverFieldFactsDto, UploadFieldEvidenceDto } from "../handover-work-order/handover-work-order.dto";
import { HandoverWorkOrderService } from "../handover-work-order/handover-work-order.service";
import { createFieldEvidenceUploadOptions } from "./field-evidence-upload-options";
import { FieldEvidenceTempFileCleanupInterceptor } from "./field-evidence-temp-file-cleanup.interceptor";
import { FieldOperatorAuthGuard } from "./field-operator-auth.guard";
import { FieldOperatorAuthService } from "./field-operator-auth.service";
import { FieldOperatorLoginDto, RequestFieldOperatorCodeDto } from "./field-operator-auth.dto";
import { CurrentFieldOperator } from "./field-operator-auth.types";
import { CurrentFieldOperatorSession } from "./field-operator-current.decorator";

const FIELD_EVIDENCE_UPLOAD_OPTIONS = createFieldEvidenceUploadOptions();

@Controller("field/handover")
export class FieldOperatorAuthController {
  constructor(
    private readonly fieldOperatorAuthService: FieldOperatorAuthService,
    private readonly handoverWorkOrderService: HandoverWorkOrderService
  ) {}

  @Post("send-code")
  sendCode(@Body() dto: RequestFieldOperatorCodeDto, @Req() request: Request) {
    return this.fieldOperatorAuthService.requestCode(dto, requestContext(request));
  }

  @Post("login")
  async login(
    @Body() dto: FieldOperatorLoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    const result = await this.fieldOperatorAuthService.login(dto, requestContext(request));
    response.cookie(this.fieldOperatorAuthService.getCookieName(), result.token, {
      httpOnly: true,
      maxAge: this.fieldOperatorAuthService.getCookieMaxAgeMs(),
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production"
    });

    return result.session;
  }

  @Get("session")
  @UseGuards(FieldOperatorAuthGuard)
  getSession(@CurrentFieldOperatorSession() current: CurrentFieldOperator) {
    return this.fieldOperatorAuthService.getSession(current);
  }

  @Post("logout")
  @UseGuards(FieldOperatorAuthGuard)
  async logout(
    @CurrentFieldOperatorSession() current: CurrentFieldOperator,
    @Res({ passthrough: true }) response: Response
  ) {
    const result = await this.fieldOperatorAuthService.logout(current.sessionId);
    response.clearCookie(this.fieldOperatorAuthService.getCookieName());
    return result;
  }

  @Get("work-orders")
  @UseGuards(FieldOperatorAuthGuard)
  async listWorkOrders(@CurrentFieldOperatorSession() current: CurrentFieldOperator, @Req() request: Request) {
    await this.fieldOperatorAuthService.recordTaskListViewed(current, requestContext(request));
    return this.handoverWorkOrderService.listFieldAccessibleWorkOrders(current.phone);
  }

  @Get("work-orders/:id")
  @UseGuards(FieldOperatorAuthGuard)
  async getWorkOrder(
    @Param("id") id: string,
    @CurrentFieldOperatorSession() current: CurrentFieldOperator,
    @Req() request: Request
  ) {
    const task = await this.handoverWorkOrderService.getFieldAccessibleWorkOrder(id, current.phone);
    await this.fieldOperatorAuthService.recordTaskViewed(current, id, requestContext(request));
    return task;
  }

  @Post("work-orders/:id/start")
  @UseGuards(FieldOperatorAuthGuard)
  startWorkOrder(@Param("id") id: string, @CurrentFieldOperatorSession() current: CurrentFieldOperator) {
    return this.handoverWorkOrderService.startFieldAccessibleWorkOrder(id, current.phone, current.sessionId);
  }

  @Patch("work-orders/:id/facts")
  @UseGuards(FieldOperatorAuthGuard)
  updateWorkOrderFacts(
    @Param("id") id: string,
    @Body() dto: UpdateHandoverFieldFactsDto,
    @CurrentFieldOperatorSession() current: CurrentFieldOperator
  ) {
    return this.handoverWorkOrderService.updateFieldAccessibleFacts(id, current.phone, dto, current.sessionId);
  }

  @Get("work-orders/:id/evidence-files/:evidenceFileId/preview")
  @UseGuards(FieldOperatorAuthGuard)
  async previewEvidenceFile(
    @Param("id") id: string,
    @Param("evidenceFileId") evidenceFileId: string,
    @CurrentFieldOperatorSession() current: CurrentFieldOperator,
    @Res({ passthrough: true }) response: Response
  ) {
    const preview = await this.handoverWorkOrderService.previewFieldAccessibleEvidenceFile(
      id,
      current.phone,
      evidenceFileId
    );
    setEvidenceFileHeaders(response, preview, "inline");
    return new StreamableFile(preview.stream);
  }

  @Get("work-orders/:id/evidence-files/:evidenceFileId/download")
  @UseGuards(FieldOperatorAuthGuard)
  async downloadEvidenceFile(
    @Param("id") id: string,
    @Param("evidenceFileId") evidenceFileId: string,
    @CurrentFieldOperatorSession() current: CurrentFieldOperator,
    @Res({ passthrough: true }) response: Response
  ) {
    const file = await this.handoverWorkOrderService.downloadFieldAccessibleEvidenceFile(
      id,
      current.phone,
      evidenceFileId
    );
    setEvidenceFileHeaders(response, file, "attachment");
    return new StreamableFile(file.stream);
  }

  @Post("work-orders/:id/evidence/:itemId/upload")
  @UseGuards(FieldOperatorAuthGuard)
  @UseInterceptors(
    AnyFilesInterceptor(FIELD_EVIDENCE_UPLOAD_OPTIONS),
    new FieldEvidenceTempFileCleanupInterceptor()
  )
  uploadAndAttachEvidenceFile(
    @Param("id") id: string,
    @Param("itemId") itemId: string,
    @Body() dto: UploadFieldEvidenceDto,
    @UploadedFiles() files: Array<{
      buffer?: Buffer;
      mimetype?: string;
      originalname: string;
      path?: string;
      size: number;
    }> | undefined,
    @CurrentFieldOperatorSession() current: CurrentFieldOperator
  ) {
    return this.handoverWorkOrderService.uploadAndAttachFieldAccessibleEvidenceFile(
      id,
      current.phone,
      itemId,
      files,
      dto,
      current.sessionId
    );
  }

  @Delete("work-orders/:id/evidence/:itemId/files/:evidenceFileId")
  @UseGuards(FieldOperatorAuthGuard)
  removeEvidenceFile(
    @Param("id") id: string,
    @Param("itemId") itemId: string,
    @Param("evidenceFileId") evidenceFileId: string,
    @CurrentFieldOperatorSession() current: CurrentFieldOperator
  ) {
    return this.handoverWorkOrderService.removeFieldAccessibleEvidenceFile(
      id,
      current.phone,
      itemId,
      evidenceFileId,
      current.sessionId
    );
  }

  @Post("work-orders/:id/no-visible-damage")
  @UseGuards(FieldOperatorAuthGuard)
  declareNoVisibleDamage(
    @Param("id") id: string,
    @Body() dto: DeclareNoVisibleDamageDto,
    @CurrentFieldOperatorSession() current: CurrentFieldOperator
  ) {
    return this.handoverWorkOrderService.declareFieldAccessibleNoVisibleDamage(
      id,
      current.phone,
      dto.remark,
      current.sessionId
    );
  }

  @Get("work-orders/:id/readiness")
  @UseGuards(FieldOperatorAuthGuard)
  getWorkOrderReadiness(@Param("id") id: string, @CurrentFieldOperatorSession() current: CurrentFieldOperator) {
    return this.handoverWorkOrderService.getFieldAccessibleReadiness(id, current.phone);
  }

  @Post("work-orders/:id/submit")
  @UseGuards(FieldOperatorAuthGuard)
  submitEvidence(@Param("id") id: string, @CurrentFieldOperatorSession() current: CurrentFieldOperator) {
    return this.handoverWorkOrderService.submitFieldAccessibleEvidence(id, current.phone, current.sessionId);
  }
}

function requestContext(request: Request) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
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
