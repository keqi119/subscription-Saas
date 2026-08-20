import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards
} from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequireAnyPermissions, RequirePermissions } from "../auth/auth.decorators";
import { type AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import { AssetOperationsService } from "./asset-operations.service";
import {
  AppendAssetWorkOrderEvidenceDto,
  AppendAssetWorkOrderNoteDto,
  AssignAssetWorkOrderDto,
  CreateAssetWorkOrderDto,
  CreateVehicleOperationalRestrictionDto,
  ReleaseVehicleOperationalRestrictionDto,
  TransitionAssetWorkOrderDto,
  VehicleAvailabilityQueryDto
} from "./dto/asset-operations.dto";

export const ASSET_OPERATION_API_CODE = {
  IDEMPOTENCY_KEY_ARRAY: "IDEMPOTENCY_KEY_ARRAY",
  IDEMPOTENCY_KEY_MISMATCH: "IDEMPOTENCY_KEY_MISMATCH",
  IDEMPOTENCY_KEY_MULTIPLE: "IDEMPOTENCY_KEY_MULTIPLE",
  IDEMPOTENCY_KEY_REQUIRED: "IDEMPOTENCY_KEY_REQUIRED"
} as const;

@Controller("asset-operations")
@UseGuards(AuthGuard, PermissionsGuard)
export class AssetOperationsController {
  constructor(private readonly service: AssetOperationsService) {}

  @Get("work-orders/:id")
  @RequirePermissions(PermissionCode.ASSET_OPERATIONS_VIEW)
  getWorkOrderDetail(@Param("id", uuidPipe()) id: string) {
    return this.service.getWorkOrderDetail(id);
  }

  @Get("vehicles/:vehicleId/work-orders")
  @RequirePermissions(PermissionCode.ASSET_OPERATIONS_VIEW)
  listVehicleWorkOrders(@Param("vehicleId", uuidPipe()) vehicleId: string) {
    return this.service.listVehicleWorkOrders(vehicleId);
  }

  @Get("vehicles/:vehicleId/restrictions")
  @RequirePermissions(PermissionCode.ASSET_OPERATIONS_VIEW)
  listVehicleRestrictions(@Param("vehicleId", uuidPipe()) vehicleId: string) {
    return this.service.listVehicleRestrictions(vehicleId);
  }

  @Get("vehicles/:vehicleId/availability")
  @RequirePermissions(PermissionCode.ASSET_OPERATIONS_VIEW)
  getVehicleAvailability(
    @Param("vehicleId", uuidPipe()) vehicleId: string,
    @Query() query: VehicleAvailabilityQueryDto
  ) {
    return query.asOf
      ? this.service.getVehicleAvailability(vehicleId, query.purpose, new Date(query.asOf))
      : this.service.getVehicleAvailability(vehicleId, query.purpose);
  }

  @Post("work-orders")
  @RequirePermissions(PermissionCode.ASSET_WORK_ORDER_MANAGE)
  createWorkOrder(@Body() dto: CreateAssetWorkOrderDto, @Req() request: AuthenticatedRequest) {
    const command = authoritativeCommand(dto, request);
    return this.service.createWorkOrder(
      {
        ...command,
        assetOwnerId: command.assetOwnerId ?? null,
        contractId: command.contractId ?? null,
        customerId: command.customerId ?? null,
        description: command.description ?? null,
        metadata: command.metadata ?? null,
        occurredAt: new Date(command.occurredAt),
        orderId: command.orderId ?? null,
        relatedWorkOrderId: command.relatedWorkOrderId ?? null
      },
      commandContext(request)
    );
  }

  @Post("work-orders/:id/assignment")
  @RequirePermissions(PermissionCode.ASSET_WORK_ORDER_MANAGE)
  assignWorkOrder(
    @Param("id", uuidPipe()) workOrderId: string,
    @Body() dto: AssignAssetWorkOrderDto,
    @Req() request: AuthenticatedRequest
  ) {
    const command = authoritativeCommand(dto, request);
    return this.service.assignWorkOrder(
      {
        ...command,
        occurredAt: new Date(command.occurredAt),
        scheduledAt: optionalDate(command.scheduledAt),
        slaDueAt: optionalDate(command.slaDueAt),
        workOrderId
      },
      commandContext(request)
    );
  }

  @Post("work-orders/:id/transition")
  @RequirePermissions(PermissionCode.ASSET_WORK_ORDER_MANAGE)
  transitionWorkOrder(
    @Param("id", uuidPipe()) workOrderId: string,
    @Body() dto: TransitionAssetWorkOrderDto,
    @Req() request: AuthenticatedRequest
  ) {
    const command = authoritativeCommand(dto, request);
    return this.service.transitionWorkOrder(
      {
        ...command,
        closeReason: command.closeReason ?? null,
        occurredAt: new Date(command.occurredAt),
        solution: command.solution ?? null,
        workOrderId
      },
      commandContext(request)
    );
  }

  @Post("work-orders/:id/notes")
  @RequirePermissions(PermissionCode.ASSET_WORK_ORDER_MANAGE)
  appendNote(
    @Param("id", uuidPipe()) workOrderId: string,
    @Body() dto: AppendAssetWorkOrderNoteDto,
    @Req() request: AuthenticatedRequest
  ) {
    const command = authoritativeCommand(dto, request);
    return this.service.appendNote(
      { ...command, occurredAt: new Date(command.occurredAt), workOrderId },
      commandContext(request)
    );
  }

  @Post("work-orders/:id/evidence")
  @RequirePermissions(PermissionCode.ASSET_WORK_ORDER_MANAGE)
  appendEvidence(
    @Param("id", uuidPipe()) workOrderId: string,
    @Body() dto: AppendAssetWorkOrderEvidenceDto,
    @Req() request: AuthenticatedRequest
  ) {
    const command = authoritativeCommand(dto, request);
    return this.service.appendEvidence(
      {
        ...command,
        captureMetadata: command.captureMetadata ?? null,
        capturedAt: optionalDate(command.capturedAt),
        contentSha256: command.contentSha256 ?? null,
        eventId: command.eventId ?? null,
        fileId: command.fileId ?? null,
        occurredAt: new Date(command.occurredAt),
        supersedesEvidenceId: command.supersedesEvidenceId ?? null,
        workOrderId
      },
      commandContext(request)
    );
  }

  @Post("vehicles/:vehicleId/restrictions")
  @RequirePermissions(PermissionCode.VEHICLE_RESTRICTION_MANAGE)
  createRestriction(
    @Param("vehicleId", uuidPipe()) vehicleId: string,
    @Body() dto: CreateVehicleOperationalRestrictionDto,
    @Req() request: AuthenticatedRequest
  ) {
    const command = authoritativeCommand(dto, request);
    return this.service.createRestriction(
      {
        ...command,
        evidenceSnapshot: command.evidenceSnapshot ?? null,
        occurredAt: new Date(command.occurredAt),
        startedAt: new Date(command.startedAt),
        vehicleId,
        workOrderId: command.workOrderId ?? null
      },
      commandContext(request)
    );
  }

  @Post("restrictions/:id/release")
  @RequireAnyPermissions(
    PermissionCode.VEHICLE_RESTRICTION_RELEASE,
    PermissionCode.VEHICLE_RESTRICTION_APPROVE_RELEASE
  )
  releaseRestriction(
    @Param("id", uuidPipe()) restrictionId: string,
    @Body() dto: ReleaseVehicleOperationalRestrictionDto,
    @Req() request: AuthenticatedRequest
  ) {
    const command = authoritativeCommand(dto, request);
    return this.service.releaseRestriction(
      { ...command, occurredAt: new Date(command.occurredAt), restrictionId },
      commandContext(request)
    );
  }
}

function authoritativeCommand<T extends { source: { key: string } }>(
  dto: T,
  request: AuthenticatedRequest
): T {
  if (Array.isArray(request.headers["idempotency-key"])) {
    throw apiBadRequest(
      ASSET_OPERATION_API_CODE.IDEMPOTENCY_KEY_ARRAY,
      "Idempotency-Key must be one scalar header value."
    );
  }
  const keys = rawHeaderValues(request.rawHeaders, "idempotency-key");
  if (keys.length > 1) {
    throw apiBadRequest(
      ASSET_OPERATION_API_CODE.IDEMPOTENCY_KEY_MULTIPLE,
      "Exactly one Idempotency-Key header is required."
    );
  }
  const sourceKey = keys[0]?.trim();
  if (!sourceKey) {
    throw apiBadRequest(
      ASSET_OPERATION_API_CODE.IDEMPOTENCY_KEY_REQUIRED,
      "A nonblank Idempotency-Key header is required."
    );
  }
  if (dto.source.key !== sourceKey) {
    throw apiBadRequest(
      ASSET_OPERATION_API_CODE.IDEMPOTENCY_KEY_MISMATCH,
      "The DTO source key must match the Idempotency-Key header."
    );
  }
  return { ...dto, source: { ...dto.source, key: sourceKey } };
}

function rawHeaderValues(rawHeaders: string[], headerName: string) {
  const values: string[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === headerName) values.push(rawHeaders[index + 1]!);
  }
  return values;
}

function commandContext(request: AuthenticatedRequest) {
  const userAgent = request.headers["user-agent"];
  return {
    actorId: request.user.id,
    ipAddress: request.ip,
    permissions: [...request.user.permissions],
    userAgent: typeof userAgent === "string" ? userAgent : undefined
  };
}

function optionalDate(value?: string | null) {
  return value ? new Date(value) : null;
}

function uuidPipe() {
  return new ParseUUIDPipe({ version: "4" });
}

function apiBadRequest(code: string, message: string) {
  return new BadRequestException({ code, message });
}
