import { Controller, Get, Param, Res, StreamableFile, UseGuards } from "@nestjs/common";
import type { Response } from "express";

import { VehicleInsuranceService } from "../vehicle-insurance/vehicle-insurance.service";
import { CustomerAuthGuard } from "./portal-auth.guard";
import { CurrentCustomer } from "./portal-auth.types";
import { CurrentPortalCustomer } from "./portal-current-customer.decorator";

@Controller("portal/orders/:orderId/documents")
@UseGuards(CustomerAuthGuard)
export class PortalOrderDocumentController {
  constructor(private readonly vehicleInsuranceService: VehicleInsuranceService) {}

  @Get()
  listDocuments(
    @Param("orderId") orderId: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.vehicleInsuranceService.buildPortalOrderDocuments(orderId, currentCustomer.customerId);
  }

  @Get(":documentId/preview")
  async previewDocument(
    @Param("orderId") orderId: string,
    @Param("documentId") documentId: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Res({ passthrough: true }) response: Response
  ) {
    const preview = await this.vehicleInsuranceService.previewPortalOrderDocument(
      orderId,
      documentId,
      currentCustomer.customerId
    );
    response.setHeader("Content-Type", preview.mimeType ?? "application/octet-stream");
    response.setHeader("Content-Length", String(preview.sizeBytes));
    response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(preview.filename)}`);
    return new StreamableFile(preview.stream);
  }
}
