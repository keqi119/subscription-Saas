import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
  UseGuards
} from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import {
  ApproveSubscriptionExtensionPriceDto,
  CreateSubscriptionExtensionDto,
  CreateSubscriptionExtensionQuoteDto,
  optionalMoney,
  ReasonedSubscriptionChangeDto,
  SubscriptionExtensionQuoteDto,
  VersionedSubscriptionChangeDto
} from "./subscription-change.dto";
import { SubscriptionExtensionService } from "./subscription-extension.service";

@Controller("subscription-changes")
@UseGuards(AuthGuard, PermissionsGuard)
export class SubscriptionChangeController {
  constructor(private readonly service: SubscriptionExtensionService) {}

  @Post("extensions")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CHANGE_CREATE)
  async createExtension(
    @Body() dto: CreateSubscriptionExtensionDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest
  ) {
    return apiSafe(await this.service.createExtension(
      {
        ...dto,
        discountedMonthlyFeeAmount: optionalMoney(dto.discountedMonthlyFeeAmount),
        idempotencyKey,
        requestedVehicleBaseFeeAmount: optionalMoney(dto.requestedVehicleBaseFeeAmount)
      },
      request.user,
      requestContext(request)
    ));
  }

  @Post(":id/quotes/preview")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CHANGE_QUOTE)
  async previewQuote(
    @Param("id") id: string,
    @Body() dto: SubscriptionExtensionQuoteDto,
    @Req() request: AuthenticatedRequest
  ) {
    return apiSafe(await this.service.previewQuote(
      id,
      {
        ...dto,
        discountedMonthlyFeeAmount: optionalMoney(dto.discountedMonthlyFeeAmount),
        requestedVehicleBaseFeeAmount: optionalMoney(dto.requestedVehicleBaseFeeAmount)
      },
      request.user
    ));
  }

  @Post(":id/quotes")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CHANGE_QUOTE)
  async createFormalQuote(
    @Param("id") id: string,
    @Body() dto: CreateSubscriptionExtensionQuoteDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest
  ) {
    return apiSafe(await this.service.createFormalQuote(
      id,
      {
        ...dto,
        discountedMonthlyFeeAmount: optionalMoney(dto.discountedMonthlyFeeAmount),
        idempotencyKey,
        requestedVehicleBaseFeeAmount: optionalMoney(dto.requestedVehicleBaseFeeAmount)
      },
      request.user,
      requestContext(request)
    ));
  }

  @Post(":id/price-override/approve")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CHANGE_PRICE_OVERRIDE_APPROVE)
  async approvePriceOverride(
    @Param("id") id: string,
    @Body() dto: ApproveSubscriptionExtensionPriceDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest
  ) {
    return apiSafe(await this.service.approvePriceOverride(
      id,
      { ...dto, idempotencyKey },
      request.user,
      requestContext(request)
    ));
  }

  @Post(":id/submit-customer-confirmation")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CHANGE_SUBMIT)
  async submitCustomerConfirmation(
    @Param("id") id: string,
    @Body() dto: VersionedSubscriptionChangeDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest
  ) {
    return apiSafe(await this.service.submitCustomerConfirmation(
      id,
      { ...dto, idempotencyKey },
      request.user,
      requestContext(request)
    ));
  }

  @Post(":id/cancel")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CHANGE_CANCEL)
  async cancel(
    @Param("id") id: string,
    @Body() dto: ReasonedSubscriptionChangeDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest
  ) {
    return apiSafe(await this.service.cancel(
      id,
      { ...dto, idempotencyKey },
      request.user,
      requestContext(request)
    ));
  }

  @Post(":id/manual-takeover")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CHANGE_MANUAL_TAKEOVER)
  async manualTakeover(
    @Param("id") id: string,
    @Body() dto: ReasonedSubscriptionChangeDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest
  ) {
    return apiSafe(await this.service.manualTakeover(
      id,
      { ...dto, idempotencyKey },
      request.user,
      requestContext(request)
    ));
  }

  @Get("orders/:orderId")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CHANGE_VIEW)
  async listForOrder(@Param("orderId") orderId: string, @Req() request: AuthenticatedRequest) {
    return apiSafe(await this.service.listForOrder(orderId, request.user));
  }

  @Get(":id/timeline")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CHANGE_VIEW)
  async timeline(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return apiSafe(await this.service.timeline(id, request.user));
  }

  @Get(":id")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CHANGE_VIEW)
  async get(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return apiSafe(await this.service.get(id, request.user));
  }
}

function apiSafe(value: unknown) {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item))
  ) as unknown;
}

function requestContext(request: AuthenticatedRequest) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}
