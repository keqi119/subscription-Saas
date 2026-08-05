import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards
} from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";
import {
  RenewalConsiderationStatus,
  RenewalReminderSlot
} from "@prisma/client";
import { Transform, Type } from "class-transformer";
import { IsBoolean, IsEnum, IsInt, IsOptional, Max, Min } from "class-validator";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import {
  RenewalConsiderationQuery,
  RenewalConsiderationService
} from "./renewal-consideration.service";

class RenewalConsiderationQueryDto implements RenewalConsiderationQuery {
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  @Min(1)
  page?: number;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  @Max(100)
  @Min(1)
  pageSize?: number;

  @Transform(({ value }) =>
    value === true || value === "true"
      ? true
      : value === false || value === "false"
        ? false
        : value
  )
  @IsBoolean()
  @IsOptional()
  smsFailed?: boolean;

  @IsEnum(RenewalConsiderationStatus)
  @IsOptional()
  status?: RenewalConsiderationStatus;
}

@Controller("renewal-considerations")
@UseGuards(AuthGuard, PermissionsGuard)
export class RenewalConsiderationController {
  constructor(private readonly service: RenewalConsiderationService) {}

  @Get()
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CHANGE_VIEW)
  async list(
    @Query() query: RenewalConsiderationQueryDto,
    @Req() request: AuthenticatedRequest
  ) {
    return apiSafe(await this.service.list(query, request.user));
  }

  @Get(":id")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CHANGE_VIEW)
  async get(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return apiSafe(await this.service.get(id, request.user));
  }

  @Post(":id/reminders/:slot/retry")
  @RequirePermissions(PermissionCode.NOTIFICATION_MANAGE)
  async retryReminder(
    @Param("id") id: string,
    @Param("slot") slot: RenewalReminderSlot,
    @Req() request: AuthenticatedRequest
  ) {
    return apiSafe(
      await this.service.retryReminder(id, slot, request.user, {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      })
    );
  }

  @Post(":id/reconcile")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CHANGE_EXECUTE)
  async reconcile(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return apiSafe(
      await this.service.reconcile(id, request.user, {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      })
    );
  }
}

function apiSafe(value: unknown) {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item))
  ) as unknown;
}
