import { Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";

import { ESignService } from "../esign/esign.service";
import { CustomerAuthGuard } from "./portal-auth.guard";
import { CurrentCustomer } from "./portal-auth.types";
import { CurrentPortalCustomer } from "./portal-current-customer.decorator";

@Controller("portal")
@UseGuards(CustomerAuthGuard)
export class PortalContractController {
  constructor(private readonly esignService: ESignService) {}

  @Get("contracts")
  listContracts(@CurrentPortalCustomer() currentCustomer: CurrentCustomer) {
    return this.esignService.listPortalContracts(currentCustomer);
  }

  @Get("contracts/:id")
  getContract(
    @Param("id") id: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.esignService.getPortalContract(id, currentCustomer);
  }

  @Post("contracts/:id/signing/start")
  startSigning(
    @Param("id") id: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.esignService.startPortalSigning(id, currentCustomer);
  }

  @Post("esign-tasks/:taskId/mock-sign")
  mockSign(
    @Param("taskId") taskId: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Req() request: Request
  ) {
    return this.esignService.mockSignTask(taskId, currentCustomer, requestContext(request));
  }
}

function requestContext(request: Request) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}
