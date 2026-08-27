import { HttpStatus, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { SubscriptionChangeType } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { SubscriptionChangeError } from "../subscription-change/subscription-change.errors";
import { SubscriptionEarlyTerminationChangeService } from "../subscription-change/subscription-early-termination-change.service";
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
    private readonly vehicleSwapService: SubscriptionVehicleSwapService,
    @Optional()
    private readonly earlyTerminationService?: SubscriptionEarlyTerminationChangeService
  ) {}

  async getChange(id: string, customer: CurrentCustomer) {
    const changeType = await this.changeType(id, customer);
    if (changeType === SubscriptionChangeType.VEHICLE_SWAP) {
      return this.vehicleSwapService.getPortalChange(id, customer);
    }
    if (changeType === SubscriptionChangeType.EARLY_TERMINATION) {
      return this.requireEarlyTermination().getPortalChange(id, customer);
    }
    return this.renewalService.getChange(id, customer);
  }

  async confirmQuote(
    id: string,
    input: PortalConfirmExtensionQuoteDto,
    customer: CurrentCustomer,
    context: PortalRequestContext
  ) {
    const changeType = await this.changeType(id, customer);
    if (changeType === SubscriptionChangeType.EARLY_TERMINATION) {
      const earlyTermination = this.requireEarlyTermination();
      await earlyTermination.decide(
        id,
        {
          decision: "ACCEPT",
          idempotencyKey: portalDecisionKey(customer.customerId, "ACCEPT", input),
          revision: input.revision,
          version: input.version
        },
        customer,
        context
      );
      return earlyTermination.getPortalChange(id, customer);
    }
    if (changeType !== SubscriptionChangeType.VEHICLE_SWAP) {
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
    const changeType = await this.changeType(id, customer);
    if (changeType === SubscriptionChangeType.EARLY_TERMINATION) {
      const earlyTermination = this.requireEarlyTermination();
      await earlyTermination.decide(
        id,
        {
          decision: "REJECT",
          idempotencyKey: portalDecisionKey(customer.customerId, "REJECT", input),
          reason: input.reason,
          revision: input.revision,
          version: input.version
        },
        customer,
        context
      );
      return earlyTermination.getPortalChange(id, customer);
    }
    if (changeType !== SubscriptionChangeType.VEHICLE_SWAP) {
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
      change.changeType !== SubscriptionChangeType.VEHICLE_SWAP &&
      change.changeType !== SubscriptionChangeType.EARLY_TERMINATION
    ) {
      throw new SubscriptionChangeError(
        "PORTAL_SUBSCRIPTION_CHANGE_UNSUPPORTED",
        "This subscription-change type does not expose a customer quote action.",
        HttpStatus.CONFLICT
      );
    }
    return change.changeType;
  }

  private requireEarlyTermination() {
    if (!this.earlyTerminationService) {
      throw new Error("SUBSCRIPTION_EARLY_TERMINATION_SERVICE_MISSING");
    }
    return this.earlyTerminationService;
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

function portalDecisionKey(
  customerId: string,
  decision: "ACCEPT" | "REJECT",
  input: Pick<PortalConfirmExtensionQuoteDto, "revision" | "version">
) {
  return `portal-early-termination:${customerId}:${decision}:${input.revision}:${input.version}`;
}
