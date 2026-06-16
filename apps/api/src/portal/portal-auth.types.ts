import { CustomerAccountStatus } from "@prisma/client";
import type { Request } from "express";

export interface CurrentCustomer {
  accountStatus: CustomerAccountStatus;
  customerAccountId: string;
  customerId: string;
  phone: string;
}

export interface PortalAuthenticatedRequest extends Request {
  currentCustomer: CurrentCustomer;
}

export interface PortalRequestContext {
  ipAddress?: string;
  userAgent?: string;
}
