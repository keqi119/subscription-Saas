import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards
} from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import { CreateDepositRuleDto, UpdateDepositRuleDto } from "./dto/deposit-rule.dto";
import { RiskService } from "./risk.service";

@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class RiskController {
  constructor(private readonly riskService: RiskService) {}

  @Get("deposit-rules")
  @RequirePermissions(PermissionCode.RISK_VIEW)
  listDepositRules() {
    return this.riskService.listDepositRules();
  }

  @Get("deposit-rules/match")
  @RequirePermissions(PermissionCode.RISK_VIEW)
  getMatchedDepositRule(
    @Query("grade") grade?: string,
    @Query("effectiveAt") effectiveAt?: string
  ) {
    return this.riskService.getMatchedDepositRule(grade, effectiveAt);
  }

  @Post("deposit-rules")
  @RequirePermissions(PermissionCode.RISK_MANAGE)
  createDepositRule(@Body() dto: CreateDepositRuleDto, @Req() request: AuthenticatedRequest) {
    return this.riskService.createDepositRule(dto, request.user, requestContext(request));
  }

  @Get("deposit-rules/:id")
  @RequirePermissions(PermissionCode.RISK_VIEW)
  getDepositRule(@Param("id") id: string) {
    return this.riskService.getDepositRule(id);
  }

  @Patch("deposit-rules/:id")
  @RequirePermissions(PermissionCode.RISK_MANAGE)
  updateDepositRule(
    @Param("id") id: string,
    @Body() dto: UpdateDepositRuleDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.riskService.updateDepositRule(id, dto, request.user, requestContext(request));
  }

  @Delete("deposit-rules/:id")
  @RequirePermissions(PermissionCode.RISK_MANAGE)
  deleteDepositRule(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.riskService.deleteDepositRule(id, request.user, requestContext(request));
  }

  @Get("applications/:id/risk-results")
  @RequirePermissions(PermissionCode.APPLICATION_VIEW)
  listApplicationRiskResults(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.riskService.listApplicationRiskResults(id, request.user);
  }
}

function requestContext(request: AuthenticatedRequest) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}
