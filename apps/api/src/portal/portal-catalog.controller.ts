import { Controller, Get, Param, Query, Res, StreamableFile } from "@nestjs/common";
import type { Response } from "express";

import { PortalCatalogService } from "./portal-catalog.service";
import { PortalVehicleCatalogQueryDto } from "./portal-catalog.dto";

@Controller("portal/catalog")
export class PortalCatalogController {
  constructor(private readonly portalCatalogService: PortalCatalogService) {}

  @Get("vehicles")
  listVehicles(@Query() query: PortalVehicleCatalogQueryDto) {
    return this.portalCatalogService.listVehicles(query);
  }

  @Get("model-definitions")
  listModelDefinitions() {
    return this.portalCatalogService.listModelDefinitions();
  }

  @Get("vehicles/:id")
  getVehicle(@Param("id") id: string) {
    return this.portalCatalogService.getVehicle(id);
  }

  @Get("vehicles/:id/condition-report")
  getVehicleConditionReport(@Param("id") id: string) {
    return this.portalCatalogService.getVehicleConditionReport(id);
  }

  @Get("vehicles/:id/media/:mediaId/preview")
  async previewVehicleMedia(
    @Param("id") id: string,
    @Param("mediaId") mediaId: string,
    @Res({ passthrough: true }) response: Response
  ) {
    const preview = await this.portalCatalogService.previewVehicleMedia(id, mediaId);
    response.setHeader("Content-Type", preview.mimeType ?? "application/octet-stream");
    response.setHeader("Content-Length", String(preview.sizeBytes));
    response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(preview.filename)}`);
    return new StreamableFile(preview.stream);
  }

  @Get("subscription-plans")
  listSubscriptionPlans() {
    return this.portalCatalogService.listSubscriptionPlans();
  }

  @Get("vehicles/:id/subscription-plans")
  listVehicleSubscriptionPlans(@Param("id") id: string) {
    return this.portalCatalogService.listVehicleSubscriptionPlans(id);
  }
}

