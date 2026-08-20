import {
  Prisma,
  VehicleOperationalRestrictionScope,
  VehicleOperationalRestrictionSeverity,
  VehicleOperationalRestrictionStatus
} from "@prisma/client";

export function buildAllocationAvailabilityWhere(asOf: Date): Prisma.VehicleWhereInput {
  return {
    operationalRestrictions: {
      none: {
        scopes: { has: VehicleOperationalRestrictionScope.ALLOCATION },
        severity: VehicleOperationalRestrictionSeverity.BLOCKING,
        startedAt: { lte: asOf },
        status: VehicleOperationalRestrictionStatus.ACTIVE
      }
    },
    subscriptionPeriods: {
      none: {
        OR: [{ endedAt: null }, { endedAt: { gt: asOf } }],
        startedAt: { lte: asOf }
      }
    }
  };
}
