import {
  Body,
  Controller,
  Get,
  Headers,
  Optional,
  Param,
  Post,
  Req,
  UseGuards
} from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import { ESignService } from "../esign/esign.service";
import {
  ApproveSubscriptionExtensionPriceDto,
  CreateSubscriptionChangeDto,
  CreateSubscriptionExtensionDto,
  CreateSubscriptionExtensionQuoteDto,
  optionalMoney,
  ReasonedSubscriptionChangeDto,
  SubscriptionExtensionQuoteDto,
  VersionedSubscriptionChangeDto
} from "./subscription-change.dto";
import { SubscriptionChangeService } from "./subscription-change.service";
import { SubscriptionExtensionService } from "./subscription-extension.service";
import { SubscriptionExtensionContractService } from "./subscription-extension-contract.service";

@Controller("subscription-changes")
@UseGuards(AuthGuard, PermissionsGuard)
export class SubscriptionChangeController {
  constructor(
    private readonly service: SubscriptionExtensionService,
    @Optional() private readonly contractService?: SubscriptionExtensionContractService,
    @Optional() private readonly esignService?: ESignService,
    @Optional() private readonly changeService?: SubscriptionChangeService
  ) {}

  @Post()
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CHANGE_CREATE)
  async create(
    @Body() dto: CreateSubscriptionChangeDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest
  ) {
    const genericService =
      this.changeService ?? (this.service as unknown as Pick<SubscriptionChangeService, "create">);
    return apiSafe(
      await genericService.create(
        {
          ...dto,
          detail:
            dto.changeType === "EXTENSION"
              ? {
                  ...dto.detail,
                  discountedMonthlyFeeAmount: optionalMoney(
                    "discountedMonthlyFeeAmount" in dto.detail
                      ? dto.detail.discountedMonthlyFeeAmount
                      : undefined
                  ),
                  requestedVehicleBaseFeeAmount: optionalMoney(
                    "requestedVehicleBaseFeeAmount" in dto.detail
                      ? dto.detail.requestedVehicleBaseFeeAmount
                      : undefined
                  )
                }
              : dto.detail,
          idempotencyKey
        } as never,
        request.user,
        requestContext(request)
      )
    );
  }

  @Post(":id/contracts")
  @RequirePermissions(PermissionCode.CONTRACT_GENERATE)
  async generateExtensionContract(
    @Param("id") id: string,
    @Body() dto: VersionedSubscriptionChangeDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest
  ) {
    if (!this.contractService) {
      throw new Error("SUBSCRIPTION_EXTENSION_CONTRACT_SERVICE_MISSING");
    }
    return apiSafe(
      await this.contractService.generate(
        id,
        { idempotencyKey, version: dto.version },
        request.user,
        requestContext(request)
      )
    );
  }

  @Post("extensions")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CHANGE_CREATE)
  async createExtension(
    @Body() dto: CreateSubscriptionExtensionDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest
  ) {
    return apiSafe(
      await this.service.createExtension(
        {
          ...dto,
          discountedMonthlyFeeAmount: optionalMoney(dto.discountedMonthlyFeeAmount),
          idempotencyKey,
          requestedVehicleBaseFeeAmount: optionalMoney(dto.requestedVehicleBaseFeeAmount)
        },
        request.user,
        requestContext(request)
      )
    );
  }

  @Post(":id/quotes/preview")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CHANGE_QUOTE)
  async previewQuote(
    @Param("id") id: string,
    @Body() dto: SubscriptionExtensionQuoteDto,
    @Req() request: AuthenticatedRequest
  ) {
    return apiSafe(
      await this.service.previewQuote(
        id,
        {
          ...dto,
          discountedMonthlyFeeAmount: optionalMoney(dto.discountedMonthlyFeeAmount),
          requestedVehicleBaseFeeAmount: optionalMoney(dto.requestedVehicleBaseFeeAmount)
        },
        request.user
      )
    );
  }

  @Post(":id/quotes")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CHANGE_QUOTE)
  async createFormalQuote(
    @Param("id") id: string,
    @Body() dto: CreateSubscriptionExtensionQuoteDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest
  ) {
    return apiSafe(
      await this.service.createFormalQuote(
        id,
        {
          ...dto,
          discountedMonthlyFeeAmount: optionalMoney(dto.discountedMonthlyFeeAmount),
          idempotencyKey,
          requestedVehicleBaseFeeAmount: optionalMoney(dto.requestedVehicleBaseFeeAmount)
        },
        request.user,
        requestContext(request)
      )
    );
  }

  @Post(":id/price-override/approve")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CHANGE_PRICE_OVERRIDE_APPROVE)
  async approvePriceOverride(
    @Param("id") id: string,
    @Body() dto: ApproveSubscriptionExtensionPriceDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest
  ) {
    return apiSafe(
      await this.service.approvePriceOverride(
        id,
        { ...dto, idempotencyKey },
        request.user,
        requestContext(request)
      )
    );
  }

  @Post(":id/submit-customer-confirmation")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CHANGE_SUBMIT)
  async submitCustomerConfirmation(
    @Param("id") id: string,
    @Body() dto: VersionedSubscriptionChangeDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest
  ) {
    return apiSafe(
      await this.service.submitCustomerConfirmation(
        id,
        { ...dto, idempotencyKey },
        request.user,
        requestContext(request)
      )
    );
  }

  @Post(":id/cancel")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CHANGE_CANCEL)
  async cancel(
    @Param("id") id: string,
    @Body() dto: ReasonedSubscriptionChangeDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest
  ) {
    return apiSafe(
      await (this.changeService ?? this.service).cancel(
        id,
        { ...dto, idempotencyKey },
        request.user,
        requestContext(request)
      )
    );
  }

  @Post(":id/manual-takeover")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CHANGE_MANUAL_TAKEOVER)
  async manualTakeover(
    @Param("id") id: string,
    @Body() dto: ReasonedSubscriptionChangeDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest
  ) {
    return apiSafe(
      await this.service.manualTakeover(
        id,
        { ...dto, idempotencyKey },
        request.user,
        requestContext(request)
      )
    );
  }

  @Post(":id/jobs/:jobId/retry")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CHANGE_EXECUTE)
  async retryAutomationJob(
    @Param("id") id: string,
    @Param("jobId") jobId: string,
    @Body() dto: VersionedSubscriptionChangeDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest
  ) {
    return apiSafe(
      await this.service.retryAutomationJob(
        id,
        jobId,
        { ...dto, idempotencyKey },
        request.user,
        requestContext(request)
      )
    );
  }

  @Post(":id/esign/start")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CHANGE_ESIGN_RETRY)
  async startESign(
    @Param("id") id: string,
    @Body() dto: VersionedSubscriptionChangeDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest
  ) {
    return this.startOrRetryESign(id, dto, idempotencyKey, request);
  }

  @Post(":id/esign/retry")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CHANGE_ESIGN_RETRY)
  async retryESign(
    @Param("id") id: string,
    @Body() dto: VersionedSubscriptionChangeDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest
  ) {
    return this.startOrRetryESign(id, dto, idempotencyKey, request);
  }

  @Get("orders/:orderId")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CHANGE_VIEW)
  async listForOrder(@Param("orderId") orderId: string, @Req() request: AuthenticatedRequest) {
    return apiSafe(await (this.changeService ?? this.service).listForOrder(orderId, request.user));
  }

  @Get(":id/timeline")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CHANGE_VIEW)
  async timeline(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return apiSafe(await this.service.timeline(id, request.user));
  }

  @Get(":id")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CHANGE_VIEW)
  async get(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return apiSafe(await (this.changeService ?? this.service).get(id, request.user));
  }

  private async startOrRetryESign(
    id: string,
    dto: VersionedSubscriptionChangeDto,
    idempotencyKey: string | undefined,
    request: AuthenticatedRequest
  ) {
    if (!this.esignService) {
      throw new Error("SUBSCRIPTION_EXTENSION_ESIGN_SERVICE_MISSING");
    }
    return apiSafe(
      await this.service.startOrRetryESign(
        id,
        { ...dto, idempotencyKey },
        request.user,
        (contractId) =>
          this.esignService!.createTaskForContract(
            contractId,
            request.user,
            requestContext(request)
          ),
        (taskId) => this.esignService!.getTask(taskId, request.user),
        (contractId) => this.esignService!.findActiveTaskForContract(contractId, request.user)
      )
    );
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
