import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import {
  ManualAttachFadadaProviderAccountDto,
  MarkFadadaRealNameStatusDto,
  StartFadadaRealNameVerificationDto
} from "./customer-esign-provider-account.dto";
import { CustomerESignProviderAccountService } from "./customer-esign-provider-account.service";

@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class CustomerESignProviderAccountController {
  constructor(private readonly accountService: CustomerESignProviderAccountService) {}

  @Get("customers/:id/esign-provider-accounts")
  @RequirePermissions(PermissionCode.CUSTOMER_VIEW)
  listCustomerProviderAccounts(@Param("id") id: string) {
    return this.accountService.listCustomerProviderAccounts(id);
  }

  @Get("customers/:id/esign-provider-accounts/fadada")
  @RequirePermissions(PermissionCode.CUSTOMER_VIEW)
  getFadadaPersonalBinding(@Param("id") id: string) {
    return this.accountService.getFadadaPersonalBinding(id);
  }

  @Post("customers/:id/esign-provider-accounts/fadada/init")
  @RequirePermissions(PermissionCode.CUSTOMER_MANAGE)
  initFadadaPersonalBinding(
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest
  ) {
    return this.accountService.ensureFadadaPersonalPendingBinding(id, request.user.id);
  }

  @Post("customers/:id/esign-provider-accounts/fadada/register")
  @RequirePermissions(PermissionCode.CUSTOMER_MANAGE)
  registerFadadaPersonalAccount(
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest
  ) {
    return this.accountService.registerFadadaPersonalAccount(id, request.user.id);
  }

  @Post("customers/:id/esign-provider-accounts/fadada/retry")
  @RequirePermissions(PermissionCode.CUSTOMER_MANAGE)
  retryFadadaPersonalAccount(
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest
  ) {
    return this.accountService.retryFadadaPersonalAccount(id, request.user.id);
  }

  @Post("customers/:id/esign-provider-accounts/fadada/manual-attach")
  @RequirePermissions(PermissionCode.CUSTOMER_MANAGE)
  manuallyAttachFadadaPersonalAccount(
    @Param("id") id: string,
    @Body() dto: ManualAttachFadadaProviderAccountDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.accountService.manuallyAttachFadadaPersonalAccount({
      customerId: id,
      providerCustomerId: dto.providerCustomerId,
      realNameStatus: dto.realNameStatus
    }, request.user.id);
  }

  @Patch("customers/:id/esign-provider-accounts/fadada/real-name-status")
  @RequirePermissions(PermissionCode.CUSTOMER_MANAGE)
  markFadadaRealNameStatus(
    @Param("id") id: string,
    @Body() dto: MarkFadadaRealNameStatusDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.accountService.markRealNameStatus({
      customerId: id,
      realNameStatus: dto.realNameStatus,
      verificationSerialNo: dto.verificationSerialNo,
      verificationTransactionNo: dto.verificationTransactionNo
    }, request.user.id);
  }

  @Post("customers/:id/esign-provider-accounts/fadada/real-name-verification")
  @RequirePermissions(PermissionCode.CUSTOMER_MANAGE)
  startFadadaRealNameVerification(
    @Param("id") id: string,
    @Body() dto: StartFadadaRealNameVerificationDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.accountService.startFadadaPersonalRealNameVerification(id, dto, request.user.id)
      .then((result) => ({
        account: result.account,
        verifyUrlMasked: result.verifyUrlMasked,
        verifyUrlPresent: result.verifyUrlPresent
      }));
  }

  @Post("customers/:id/esign-provider-accounts/fadada/real-name-status/refresh")
  @RequirePermissions(PermissionCode.CUSTOMER_MANAGE)
  refreshFadadaRealNameStatus(
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest
  ) {
    return this.accountService.refreshFadadaRealNameStatus(id, request.user.id);
  }

  @Post("customers/:id/esign-provider-accounts/fadada/apply-cert")
  @RequirePermissions(PermissionCode.CUSTOMER_MANAGE)
  applyFadadaPersonalCert(
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest
  ) {
    return this.accountService.applyFadadaPersonalCert(id, request.user.id);
  }
}
