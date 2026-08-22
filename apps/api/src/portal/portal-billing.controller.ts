import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";

import { CustomerAuthGuard } from "./portal-auth.guard";
import { CurrentCustomer } from "./portal-auth.types";
import { CurrentPortalCustomer } from "./portal-current-customer.decorator";
import { PortalBillingService } from "./portal-billing.service";
import { SubscriptionClosureProjectionService } from "../subscription-closure/subscription-closure.projection";
import {
  PortalBillsQueryDto,
  PortalDepositTransactionsQueryDto,
  PortalEntitlementsQueryDto,
  PortalEntitlementUsagesQueryDto,
  PortalOrdersQueryDto
} from "./portal-billing.dto";

@Controller("portal")
@UseGuards(CustomerAuthGuard)
export class PortalBillingController {
  constructor(
    private readonly portalBillingService: PortalBillingService,
    private readonly subscriptionClosureProjection: SubscriptionClosureProjectionService
  ) {}

  @Get("orders")
  listOrders(
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Query() query: PortalOrdersQueryDto
  ) {
    return this.portalBillingService.listOrders(currentCustomer, query);
  }

  @Get("orders/:id")
  getOrder(
    @Param("id") id: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.portalBillingService.getOrder(id, currentCustomer);
  }

  @Get("orders/:id/subscription-closure")
  getSubscriptionClosure(
    @Param("id") id: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.subscriptionClosureProjection.getCustomerByOrder(id, currentCustomer.customerId);
  }

  @Get("bills")
  listBills(
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Query() query: PortalBillsQueryDto
  ) {
    return this.portalBillingService.listBills(currentCustomer, query);
  }

  @Get("bills/:id")
  getBill(
    @Param("id") id: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.portalBillingService.getBill(id, currentCustomer);
  }

  @Get("deposit")
  getDepositOverview(@CurrentPortalCustomer() currentCustomer: CurrentCustomer) {
    return this.portalBillingService.getDepositOverview(currentCustomer);
  }

  @Get("deposit/transactions")
  listDepositTransactions(
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Query() query: PortalDepositTransactionsQueryDto
  ) {
    return this.portalBillingService.listDepositTransactions(currentCustomer, query);
  }

  @Get("entitlements")
  listEntitlements(
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Query() query: PortalEntitlementsQueryDto
  ) {
    return this.portalBillingService.listEntitlements(currentCustomer, query);
  }

  @Get("entitlements/usages")
  listEntitlementUsages(
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Query() query: PortalEntitlementUsagesQueryDto
  ) {
    return this.portalBillingService.listEntitlementUsages(currentCustomer, query);
  }
}
