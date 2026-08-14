import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards
} from "@nestjs/common";

import { CreateFieldVideoUploadSessionDto } from "./field-video-upload.dto";
import { FieldVideoUploadService } from "./field-video-upload.service";
import { FieldOperatorAuthGuard } from "./field-operator-auth.guard";
import { CurrentFieldOperator } from "./field-operator-auth.types";
import { CurrentFieldOperatorSession } from "./field-operator-current.decorator";

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
