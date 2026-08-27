import { HttpStatus, Injectable, NotFoundException } from "@nestjs/common";
import { SubscriptionChangeType } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { SubscriptionChangeError } from "../subscription-change/subscription-change.errors";
import { SubscriptionVehicleSwapService } from "../subscription-change/subscription-vehicle-swap.service";
import { CurrentCustomer, PortalRequestContext } from "./portal-auth.types";
import {
  PortalConfirmExtensionQuoteDto,
  PortalRejectExtensionQuoteDto
} from "./portal-renewal.dto";
import { PortalRenewalService } from "./portal-renewal.service";

@Injectable()
export class PortalSubscriptionChangeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly renewalService: PortalRenewalService,
    private readonly vehicleSwapService: SubscriptionVehicleSwapService
  ) {}

  async getChange(id: string, customer: CurrentCustomer) {
    return (await this.changeType(id, customer)) === SubscriptionChangeType.VEHICLE_SWAP
      ? this.vehicleSwapService.getPortalChange(id, customer)
      : this.renewalService.getChange(id, customer);
  }

  async confirmQuote(
    id: string,
    input: PortalConfirmExtensionQuoteDto,
    customer: CurrentCustomer,
    context: PortalRequestContext
  ) {
    if ((await this.changeType(id, customer)) !== SubscriptionChangeType.VEHICLE_SWAP) {
      return this.renewalService.confirmQuote(id, input, customer, context);
    }
    return this.vehicleSwapService.confirmQuote(
      id,
      { ...input, commercialSnapshotHash: requireCommercialHash(input.commercialSnapshotHash) },
      customer,
      context
    );
  }

  async rejectQuote(
    id: string,
    input: PortalRejectExtensionQuoteDto,
    customer: CurrentCustomer,
    context: PortalRequestContext
  ) {
    if ((await this.changeType(id, customer)) !== SubscriptionChangeType.VEHICLE_SWAP) {
      return this.renewalService.rejectQuote(id, input, customer, context);
    }
    return this.vehicleSwapService.rejectQuote(
      id,
      { ...input, commercialSnapshotHash: requireCommercialHash(input.commercialSnapshotHash) },
      customer,
      context
    );
  }

  private async changeType(id: string, customer: CurrentCustomer) {
    const change = await this.prisma.subscriptionChangeOrder.findFirst({
      select: { changeType: true },
      where: { id, order: { customerId: customer.customerId } }
    });
    if (!change) throw new NotFoundException("Subscription change was not found.");
    if (
      change.changeType !== SubscriptionChangeType.EXTENSION &&
      change.changeType !== SubscriptionChangeType.VEHICLE_SWAP
    ) {
      throw new SubscriptionChangeError(
        "PORTAL_SUBSCRIPTION_CHANGE_UNSUPPORTED",
        "This subscription-change type does not expose a customer quote action.",
        HttpStatus.CONFLICT
      );
    }
    return change.changeType;
  }
}

function requireCommercialHash(value: string | undefined) {
  if (!value) {
    throw new SubscriptionChangeError(
      "VEHICLE_SWAP_COMMERCIAL_HASH_REQUIRED",
      "The exact vehicle-swap commercial snapshot hash is required.",
      HttpStatus.BAD_REQUEST
    );
  }
  return value;
}
