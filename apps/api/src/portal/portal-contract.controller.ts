import { Controller, Get, Param, Post, Req, Res, StreamableFile, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";

import { ESignService } from "../esign/esign.service";
import { FadadaSignedArtifactService } from "../esign/fadada/fadada-signed-artifact.service";
import { CustomerAuthGuard } from "./portal-auth.guard";
import { CurrentCustomer } from "./portal-auth.types";
import { CurrentPortalCustomer } from "./portal-current-customer.decorator";

@Controller("portal")
@UseGuards(CustomerAuthGuard)
export class PortalContractController {
  constructor(
    private readonly esignService: ESignService,
    private readonly fadadaSignedArtifactService: FadadaSignedArtifactService
  ) {}

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

  @Get("contracts/:id/signed-document/preview")
  async previewSignedContract(
    @Param("id") id: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Res({ passthrough: true }) response: Response
  ) {
    const preview = await this.fadadaSignedArtifactService.getPortalSignedContractPreview(id, currentCustomer);
    response.setHeader("Content-Type", preview.contentType);
    response.setHeader("Content-Length", String(preview.sizeBytes));
    response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(preview.filename)}`);
    return new StreamableFile(preview.stream);
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
