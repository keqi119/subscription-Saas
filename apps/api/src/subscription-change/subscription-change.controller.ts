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
import { SubscriptionChangeType } from "@prisma/client";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import { ESignService } from "../esign/esign.service";
import {
  ApproveSubscriptionExtensionPriceDto,
  ApproveManagedOtherDto,
  CreateSubscriptionChangeDto,
  CreateSubscriptionExtensionDto,
  CreateSubscriptionExtensionQuoteDto,
  ExecuteManagedOtherDto,
  optionalMoney,
  ReasonedSubscriptionChangeDto,
  SubscriptionExtensionQuoteDto,
  VersionedSubscriptionChangeDto
} from "./subscription-change.dto";
import { SubscriptionChangeService } from "./subscription-change.service";
import { SubscriptionEarlyTerminationChangeService } from "./subscription-early-termination-change.service";
import { SubscriptionManagedOtherService } from "./subscription-managed-other.service";
import { SubscriptionExtensionService } from "./subscription-extension.service";
import { SubscriptionExtensionContractService } from "./subscription-extension-contract.service";
import { SubscriptionVehicleSwapContractService } from "./subscription-vehicle-swap-contract.service";

@Controller("subscription-changes")
@UseGuards(AuthGuard, PermissionsGuard)
export class SubscriptionChangeController {
  constructor(
    private readonly service: SubscriptionExtensionService,
    @Optional() private readonly contractService?: SubscriptionExtensionContractService,
    @Optional() private readonly esignService?: ESignService,
    @Optional() private readonly changeService?: SubscriptionChangeService,
    @Optional() private readonly vehicleSwapContractService?: SubscriptionVehicleSwapContractService,
    @Optional()
    private readonly earlyTerminationService?: SubscriptionEarlyTerminationChangeService,
    @Optional()
    private readonly managedOtherService?: SubscriptionManagedOtherService
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
    const contractService = await this.contractServiceFor(id);
    return apiSafe(
      await contractService.generate(
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
    const quoteService = this.changeService ?? this.service;
    return apiSafe(
      await quoteService.previewQuote(
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
    const quoteService = this.changeService ?? this.service;
    return apiSafe(
      await quoteService.createFormalQuote(
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
    const quoteService = this.changeService ?? this.service;
    return apiSafe(
      await quoteService.submitCustomerConfirmation(
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

  @Post(":id/managed-other/approve")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CHANGE_APPROVE)
  async approveManagedOther(
    @Param("id") id: string,
    @Body() dto: ApproveManagedOtherDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest
  ) {
    if (!this.managedOtherService) {
      throw new Error("SUBSCRIPTION_MANAGED_OTHER_SERVICE_MISSING");
    }
    return apiSafe(
      await this.managedOtherService.approve(
        id,
        { ...dto, idempotencyKey },
        request.user,
        requestContext(request)
      )
    );
  }

  @Post(":id/managed-other/execute")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CHANGE_EXECUTE)
  async executeManagedOther(
    @Param("id") id: string,
    @Body() dto: ExecuteManagedOtherDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest
  ) {
    if (!this.managedOtherService) {
      throw new Error("SUBSCRIPTION_MANAGED_OTHER_SERVICE_MISSING");
    }
    return apiSafe(
      await this.managedOtherService.execute(
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
    const changeContractService = await this.esignCommandServiceFor(id);
    return apiSafe(
      await changeContractService.startOrRetryESign(
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

  private async contractServiceFor(id: string) {
    if (this.changeService) {
      const changeType = await this.changeService.getChangeType(id);
      if (changeType === SubscriptionChangeType.VEHICLE_SWAP) {
        if (!this.vehicleSwapContractService) {
          throw new Error("SUBSCRIPTION_VEHICLE_SWAP_CONTRACT_SERVICE_MISSING");
        }
        return this.vehicleSwapContractService;
      }
      if (changeType === SubscriptionChangeType.EARLY_TERMINATION) {
        if (!this.earlyTerminationService) {
          throw new Error("SUBSCRIPTION_EARLY_TERMINATION_SERVICE_MISSING");
        }
        return this.earlyTerminationService;
      }
    }
    if (!this.contractService) {
      throw new Error("SUBSCRIPTION_EXTENSION_CONTRACT_SERVICE_MISSING");
    }
    return this.contractService;
  }

  private async esignCommandServiceFor(id: string) {
    if (this.changeService) {
      const changeType = await this.changeService.getChangeType(id);
      if (changeType === SubscriptionChangeType.VEHICLE_SWAP) {
        if (!this.vehicleSwapContractService) {
          throw new Error("SUBSCRIPTION_VEHICLE_SWAP_CONTRACT_SERVICE_MISSING");
        }
        return this.vehicleSwapContractService;
      }
      if (changeType === SubscriptionChangeType.EARLY_TERMINATION) {
        if (!this.earlyTerminationService) {
          throw new Error("SUBSCRIPTION_EARLY_TERMINATION_SERVICE_MISSING");
        }
        return this.earlyTerminationService;
      }
    }
    return this.service;
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
