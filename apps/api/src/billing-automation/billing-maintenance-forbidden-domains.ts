import definition from "./stage1-acceptance-forbidden-domains.json";
import { hashBillingMaintenanceValue } from "./billing-maintenance-evidence.types";

export interface BillingMaintenanceForbiddenDomain {
  delegate: string;
  table: string;
}

export const BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_VERSION = definition.version;
export const BILLING_MAINTENANCE_FORBIDDEN_DOMAINS = Object.freeze(
  definition.domains.map((domain) => Object.freeze({ ...domain }))
) as readonly BillingMaintenanceForbiddenDomain[];
export const BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_SHA256 = hashBillingMaintenanceValue({
  domains: BILLING_MAINTENANCE_FORBIDDEN_DOMAINS,
  version: BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_VERSION
});
