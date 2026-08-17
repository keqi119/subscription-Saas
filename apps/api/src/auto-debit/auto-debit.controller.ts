import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import { AdminDebitAttemptQueryDto, AdminMandateQueryDto } from "./auto-debit.dto";
import { AutoDebitAdminService } from "./auto-debit.admin.service";
import { PaymentMandateService } from "./payment-mandate.service";

@Controller("billing/automation")
@UseGuards(AuthGuard, PermissionsGuard)
export class AutoDebitController {
  constructor(
    private readonly service: PaymentMandateService,
    private readonly admin: AutoDebitAdminService
  ) {}

  @Get("mandates")
  @RequirePermissions(PermissionCode.AUTO_DEBIT_VIEW)
  listMandates(@Query() query: AdminMandateQueryDto) {
    return this.service.listAdminMandates(query);
  }

  @Get("attempts")
  @RequirePermissions(PermissionCode.AUTO_DEBIT_VIEW)
  listAttempts(@Query() query: AdminDebitAttemptQueryDto) {
    return this.admin.listAttempts(query);
  }
}
