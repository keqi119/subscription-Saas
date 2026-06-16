import { Controller, Get, Param, Query } from "@nestjs/common";

import { PortalCatalogService } from "./portal-catalog.service";
import { PortalVehicleCatalogQueryDto } from "./portal-catalog.dto";

@Controller("portal/catalog")
export class PortalCatalogController {
  constructor(private readonly portalCatalogService: PortalCatalogService) {}

  @Get("vehicles")
  listVehicles(@Query() query: PortalVehicleCatalogQueryDto) {
    return this.portalCatalogService.listVehicles(query);
  }

  @Get("vehicles/:id")
  getVehicle(@Param("id") id: string) {
    return this.portalCatalogService.getVehicle(id);
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

