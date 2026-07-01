import { Injectable } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service";
import type { VehicleOperationalStateInput } from "./vehicle-operational-state.types";

@Injectable()
export class VehicleOperationalStateRepository {
  constructor(private readonly prisma: PrismaService) {}

  async loadVehicleOperationalStateSnapshot(vehicleId: string, asOf: Date = new Date()): Promise<VehicleOperationalStateInput> {
    const [vehicle, leases, orders, serviceCases, conditionReports] = await Promise.all([
      this.prisma.vehicle.findUnique({
        select: {
          createdAt: true,
          deletedAt: true,
          id: true,
          status: true,
          updatedAt: true,
          vehicleNo: true
        },
        where: { id: vehicleId }
      }),
      this.prisma.lease.findMany({
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
        select: {
          activatedAt: true,
          createdAt: true,
          deletedAt: true,
          id: true,
          orderId: true,
          status: true,
          updatedAt: true
        },
        take: 10,
        where: {
          createdAt: { lte: asOf },
          order: { vehicleId }
        }
      }),
      this.prisma.subscriptionOrder.findMany({
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
        select: {
          actualDeliveryAt: true,
          actualReturnAt: true,
          createdAt: true,
          deletedAt: true,
          endDate: true,
          id: true,
          orderNo: true,
          orderStatus: true,
          startDate: true,
          updatedAt: true,
          vehicleId: true
        },
        take: 20,
        where: {
          createdAt: { lte: asOf },
          vehicleId
        }
      }),
      this.prisma.serviceCase.findMany({
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
        select: {
          cancelledAt: true,
          caseNo: true,
          caseStatus: true,
          caseType: true,
          closedAt: true,
          createdAt: true,
          deletedAt: true,
          id: true,
          occurredAt: true,
          priority: true,
          resolvedAt: true,
          updatedAt: true,
          vehicleId: true
        },
        take: 20,
        where: {
          createdAt: { lte: asOf },
          vehicleId
        }
      }),
      this.prisma.vehicleConditionReport.findMany({
        include: {
          items: {
            select: {
              affectsSafety: true,
              deletedAt: true,
              id: true,
              repairRequired: true,
              result: true,
              severity: true
            },
            where: { deletedAt: null }
          }
        },
        orderBy: [{ publishedAt: "desc" }, { inspectionDate: "desc" }, { updatedAt: "desc" }],
        take: 10,
        where: {
          createdAt: { lte: asOf },
          vehicleId
        }
      })
    ]);

    return {
      asOf,
      conditionReports,
      leases,
      orders,
      serviceCases,
      vehicle
    };
  }
}
