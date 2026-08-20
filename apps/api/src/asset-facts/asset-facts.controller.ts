import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards
} from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import { AssetFactsService } from "./asset-facts.service";
import {
  CloseOwnershipPeriodDto,
  CloseSubscriptionPeriodDto,
  OpenOwnershipPeriodDto,
  OpenSubscriptionPeriodDto
} from "./dto/asset-facts.dto";

export const ASSET_FACT_API_CODE = {
  IDEMPOTENCY_KEY_MULTIPLE: "IDEMPOTENCY_KEY_MULTIPLE",
  IDEMPOTENCY_KEY_MISMATCH: "IDEMPOTENCY_KEY_MISMATCH",
  IDEMPOTENCY_KEY_REQUIRED: "IDEMPOTENCY_KEY_REQUIRED"
} as const;

@Controller("asset-facts")
@UseGuards(AuthGuard, PermissionsGuard)
export class AssetFactsController {
  constructor(private readonly service: AssetFactsService) {}

  @Get("vehicles/:vehicleId")
  @RequirePermissions(PermissionCode.ASSET_FACTS_VIEW)
  getByVehicle(@Param("vehicleId") vehicleId: string) {
    return this.service.getByVehicle(vehicleId);
  }

  @Get("orders/:orderId")
  @RequirePermissions(PermissionCode.ASSET_FACTS_VIEW)
  getByOrder(@Param("orderId") orderId: string) {
    return this.service.getByOrder(orderId);
  }

  @Post("admin/ownership-periods/open")
  @RequirePermissions(PermissionCode.ASSET_OWNER_MANAGE)
  openOwnershipPeriod(@Body() dto: OpenOwnershipPeriodDto, @Req() request: AuthenticatedRequest) {
    return this.service.openOwnershipPeriod(
      authoritativeSource(dto, request),
      commandContext(request)
    );
  }

  @Post("admin/ownership-periods/close")
  @RequirePermissions(PermissionCode.ASSET_OWNER_MANAGE)
  closeOwnershipPeriod(@Body() dto: CloseOwnershipPeriodDto, @Req() request: AuthenticatedRequest) {
    return this.service.closeOwnershipPeriod(
      authoritativeSource(dto, request),
      commandContext(request)
    );
  }

  @Post("admin/subscription-periods/open")
  @RequirePermissions(PermissionCode.VEHICLE_PERIOD_MANAGE)
  openSubscriptionPeriod(
    @Body() dto: OpenSubscriptionPeriodDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.openSubscriptionPeriod(
      authoritativeSource(dto, request),
      commandContext(request)
    );
  }

  @Post("admin/subscription-periods/close")
  @RequirePermissions(PermissionCode.VEHICLE_PERIOD_MANAGE)
  closeSubscriptionPeriod(
    @Body() dto: CloseSubscriptionPeriodDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.closeSubscriptionPeriod(
      authoritativeSource(dto, request),
      commandContext(request)
    );
  }
}

function authoritativeSource<T extends { source: { key: string } }>(
  dto: T,
  request: AuthenticatedRequest
): T {
  const idempotencyKeys = rawHeaderValues(request.rawHeaders, "idempotency-key");
  if (idempotencyKeys.length > 1) {
    throw apiBadRequest(
      ASSET_FACT_API_CODE.IDEMPOTENCY_KEY_MULTIPLE,
      "Exactly one Idempotency-Key header is required."
    );
  }
  const sourceKey = idempotencyKeys[0]?.trim();
  if (!sourceKey) {
    throw apiBadRequest(
      ASSET_FACT_API_CODE.IDEMPOTENCY_KEY_REQUIRED,
      "A nonblank Idempotency-Key header is required."
    );
  }
  if (dto.source.key !== sourceKey) {
    throw apiBadRequest(
      ASSET_FACT_API_CODE.IDEMPOTENCY_KEY_MISMATCH,
      "The DTO source key must match the Idempotency-Key header."
    );
  }
  return {
    ...dto,
    source: {
      ...dto.source,
      key: sourceKey
    }
  };
}

function rawHeaderValues(rawHeaders: string[], headerName: string) {
  const values: string[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === headerName) {
      values.push(rawHeaders[index + 1]!);
    }
  }
  return values;
}

function commandContext(request: AuthenticatedRequest) {
  return {
    actorId: request.user.id,
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}

function apiBadRequest(code: string, message: string) {
  return new BadRequestException({ code, message });
}
