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

import { RequirePermissions } from "../auth/auth.decorators";
import { type AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import { AssetAccountingService } from "./asset-accounting.service";
import {
  AppendVehicleCostEntryDto,
  ExceptionApprovalQueryDto,
  ReverseVehicleCostEntryDto
} from "./dto/asset-accounting.dto";

export const ASSET_ACCOUNTING_API_CODE = {
  IDEMPOTENCY_KEY_ARRAY: "IDEMPOTENCY_KEY_ARRAY",
  IDEMPOTENCY_KEY_MISMATCH: "IDEMPOTENCY_KEY_MISMATCH",
  IDEMPOTENCY_KEY_MULTIPLE: "IDEMPOTENCY_KEY_MULTIPLE",
  IDEMPOTENCY_KEY_REQUIRED: "IDEMPOTENCY_KEY_REQUIRED"
} as const;

@Controller("asset-accounting")
@UseGuards(AuthGuard, PermissionsGuard)
export class AssetAccountingController {
  constructor(private readonly service: AssetAccountingService) {}

  @Post("cost-entries")
  @RequirePermissions(PermissionCode.VEHICLE_COST_LEDGER_CONFIRM)
  appendCostEntry(@Body() dto: AppendVehicleCostEntryDto, @Req() request: AuthenticatedRequest) {
    const command = authoritativeCommand(dto, request);
    return this.service.appendCost(
      {
        ...command,
        amountCents: BigInt(command.amountCents),
        assetOwnerId: command.assetOwnerId ?? null,
        assetOwnerSnapshot: command.assetOwnerSnapshot ?? null,
        confirmedAt: new Date(command.confirmedAt),
        contractId: command.contractId ?? null,
        customerId: command.customerId ?? null,
        evidenceId: command.evidenceId ?? null,
        evidenceSnapshot: command.evidenceSnapshot ?? null,
        occurredOn: new Date(command.occurredOn),
        orderId: command.orderId ?? null,
        responsiblePartyId: command.responsiblePartyId ?? null,
        workOrderId: command.workOrderId ?? null
      },
      commandContext(request, command.source.key)
    );
  }

  @Post("cost-entries/:id/reverse")
  @RequirePermissions(PermissionCode.VEHICLE_COST_LEDGER_REVERSE)
  reverseCostEntry(
    @Param("id", uuidPipe()) originalEntryId: string,
    @Body() dto: ReverseVehicleCostEntryDto,
    @Req() request: AuthenticatedRequest
  ) {
    const command = authoritativeCommand(dto, request);
    return this.service.reverseCost(
      {
        ...command,
        confirmedAt: new Date(command.confirmedAt),
        originalEntryId
      },
      commandContext(request, command.source.key)
    );
  }

  @Get("cost-entries/:id")
  @RequirePermissions(PermissionCode.VEHICLE_COST_LEDGER_VIEW)
  getCostEntry(@Param("id", uuidPipe()) entryId: string, @Req() request: AuthenticatedRequest) {
    return this.service.getEntry(entryId, readContext(request));
  }

  @Get("vehicles/:vehicleId/cost-entries")
  @RequirePermissions(PermissionCode.VEHICLE_COST_LEDGER_VIEW)
  listVehicleCostEntries(
    @Param("vehicleId", uuidPipe()) vehicleId: string,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.listVehicleEntries(vehicleId, readContext(request));
  }

  @Get("orders/:orderId/cost-entries")
  @RequirePermissions(PermissionCode.VEHICLE_COST_LEDGER_VIEW)
  listOrderCostEntries(
    @Param("orderId", uuidPipe()) orderId: string,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.listOrderEntries(orderId, readContext(request));
  }

  @Get("work-orders/:workOrderId/cost-entries")
  @RequirePermissions(PermissionCode.VEHICLE_COST_LEDGER_VIEW)
  listWorkOrderCostEntries(
    @Param("workOrderId", uuidPipe()) workOrderId: string,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.listWorkOrderEntries(workOrderId, readContext(request));
  }

  @Get("exception-approvals/:id")
  @RequirePermissions(PermissionCode.BUSINESS_EXCEPTION_VIEW)
  getExceptionApproval(
    @Param("id", uuidPipe()) approvalId: string,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.getExceptionApproval(approvalId, readContext(request));
  }

  @Get("exception-approvals")
  @RequirePermissions(PermissionCode.BUSINESS_EXCEPTION_VIEW)
  listExceptionApprovals(
    @Query() query: ExceptionApprovalQueryDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.listExceptionApprovals(
      {
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.subjectId === undefined ? {} : { subjectId: query.subjectId }),
        ...(query.subjectType === undefined ? {} : { subjectType: query.subjectType })
      },
      readContext(request)
    );
  }
}

function authoritativeCommand<T extends { source: { key: string } }>(
  dto: T,
  request: AuthenticatedRequest
): T {
  if (Array.isArray(request.headers["idempotency-key"])) {
    throw apiBadRequest(
      ASSET_ACCOUNTING_API_CODE.IDEMPOTENCY_KEY_ARRAY,
      "Idempotency-Key must be one scalar header value."
    );
  }
  const keys = rawHeaderValues(request.rawHeaders, "idempotency-key");
  if (keys.length > 1) {
    throw apiBadRequest(
      ASSET_ACCOUNTING_API_CODE.IDEMPOTENCY_KEY_MULTIPLE,
      "Exactly one Idempotency-Key header is required."
    );
  }
  const sourceKey = keys[0];
  if (!sourceKey || sourceKey.trim().length === 0) {
    throw apiBadRequest(
      ASSET_ACCOUNTING_API_CODE.IDEMPOTENCY_KEY_REQUIRED,
      "A nonblank Idempotency-Key header is required."
    );
  }
  if (dto.source.key !== sourceKey) {
    throw apiBadRequest(
      ASSET_ACCOUNTING_API_CODE.IDEMPOTENCY_KEY_MISMATCH,
      "The DTO source key must exactly match Idempotency-Key."
    );
  }
  return { ...dto, source: { ...dto.source, key: sourceKey } };
}

function rawHeaderValues(rawHeaders: readonly string[], headerName: string) {
  const values: string[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === headerName) values.push(rawHeaders[index + 1]!);
  }
  return values;
}

function commandContext(request: AuthenticatedRequest, idempotencyKey: string) {
  return {
    ...readContext(request),
    idempotencyKey
  };
}

function readContext(request: AuthenticatedRequest) {
  const userAgent = request.headers["user-agent"];
  return {
    actorId: request.user.id,
    ipAddress: request.ip,
    permissions: [...request.user.permissions],
    userAgent: typeof userAgent === "string" ? userAgent : undefined
  };
}

function uuidPipe() {
  return new ParseUUIDPipe({ version: "4" });
}

function apiBadRequest(code: string, message: string) {
  return new BadRequestException({ code, message });
}
