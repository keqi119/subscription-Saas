import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  UploadedFile,
  UseInterceptors,
  UseGuards
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";

import { CreateFieldVideoUploadSessionDto } from "./field-video-upload.dto";
import { FieldEvidenceTempFileCleanupInterceptor } from "./field-evidence-temp-file-cleanup.interceptor";
import { createFieldVideoPartUploadOptions } from "./field-video-upload-options";
import { FieldVideoUploadService } from "./field-video-upload.service";
import { DiskUploadedFile } from "./field-video-upload.types";
import { FieldOperatorAuthGuard } from "./field-operator-auth.guard";
import { CurrentFieldOperator } from "./field-operator-auth.types";
import { CurrentFieldOperatorSession } from "./field-operator-current.decorator";

const FIELD_VIDEO_PART_UPLOAD_OPTIONS = createFieldVideoPartUploadOptions();

@Controller("field/handover")
@UseGuards(FieldOperatorAuthGuard)
export class FieldVideoUploadController {
  constructor(private readonly service: FieldVideoUploadService) {}

  @Post("work-orders/:id/evidence/:itemId/video-upload-sessions")
  createOrResume(
    @Param("id") workOrderId: string,
    @Param("itemId") evidenceItemId: string,
    @Body() dto: CreateFieldVideoUploadSessionDto,
    @CurrentFieldOperatorSession() current: CurrentFieldOperator
  ) {
    return this.service.createOrResume(
      workOrderId,
      evidenceItemId,
      current.phone,
      current.sessionId,
      dto
    );
  }

  @Get("work-orders/:id/evidence/:itemId/video-upload-sessions/:sessionId")
  getStatus(
    @Param("id") workOrderId: string,
    @Param("itemId") evidenceItemId: string,
    @Param("sessionId") sessionId: string,
    @CurrentFieldOperatorSession() current: CurrentFieldOperator
  ) {
    return this.service.getStatus(workOrderId, evidenceItemId, sessionId, current.phone);
  }

  @Post("work-orders/:id/evidence/:itemId/video-upload-sessions/:sessionId/parts/:partNumber")
  @UseInterceptors(
    FileInterceptor("file", FIELD_VIDEO_PART_UPLOAD_OPTIONS),
    new FieldEvidenceTempFileCleanupInterceptor()
  )
  uploadPart(
    @Param("id") workOrderId: string,
    @Param("itemId") evidenceItemId: string,
    @Param("sessionId") sessionId: string,
    @Param("partNumber", ParseIntPipe) partNumber: number,
    @Headers("x-part-sha256") sha256: string,
    @UploadedFile() file: DiskUploadedFile | undefined,
    @CurrentFieldOperatorSession() current: CurrentFieldOperator
  ) {
    if (!file) {
      throw new BadRequestException({
        code: "CHUNK_FILE_REQUIRED",
        message: "请选择要上传的分片文件。"
      });
    }
    return this.service.uploadPart(
      workOrderId,
      evidenceItemId,
      sessionId,
      partNumber,
      sha256,
      file,
      current.phone
    );
  }

  @Get("video-upload-sessions/active")
  listActive(@CurrentFieldOperatorSession() current: CurrentFieldOperator) {
    return this.service.listActive(current.phone);
  }

  @Post("work-orders/:id/evidence/:itemId/video-upload-sessions/:sessionId/complete")
  @HttpCode(HttpStatus.ACCEPTED)
  complete(
    @Param("id") workOrderId: string,
    @Param("itemId") evidenceItemId: string,
    @Param("sessionId") sessionId: string,
    @CurrentFieldOperatorSession() current: CurrentFieldOperator
  ) {
    return this.service.complete(workOrderId, evidenceItemId, sessionId, current.phone);
  }

  @Post("work-orders/:id/evidence/:itemId/video-upload-sessions/:sessionId/retry")
  retry(
    @Param("id") workOrderId: string,
    @Param("itemId") evidenceItemId: string,
    @Param("sessionId") sessionId: string,
    @CurrentFieldOperatorSession() current: CurrentFieldOperator
  ) {
    return this.service.retry(workOrderId, evidenceItemId, sessionId, current.phone);
  }

  @Delete("work-orders/:id/evidence/:itemId/video-upload-sessions/:sessionId")
  cancel(
    @Param("id") workOrderId: string,
    @Param("itemId") evidenceItemId: string,
    @Param("sessionId") sessionId: string,
    @CurrentFieldOperatorSession() current: CurrentFieldOperator
  ) {
    return this.service.cancel(
      workOrderId,
      evidenceItemId,
      sessionId,
      current.phone,
      current.sessionId
    );
  }
}
