import { Injectable } from "@nestjs/common";

import { PrismaService } from "../../prisma/prisma.service";
import { VehicleTimelineBuilder } from "./vehicle-timeline.builder";
import { VehicleTimelineCalculator } from "./vehicle-timeline.calculator";
import type { TimelineDay, VehicleTimelineRawInput } from "./vehicle-timeline.types";

@Injectable()
export class VehicleTimelineService {
  private readonly builder = new VehicleTimelineBuilder();
  private readonly calculator = new VehicleTimelineCalculator();

  constructor(private readonly prisma: PrismaService) {}

  async getVehicleTimeline(vehicleId: string, from: Date, to: Date): Promise<TimelineDay[]> {
    const rawInput = await this.loadRawInput(vehicleId, from, to);
    const events = this.builder.buildEvents(rawInput);

    return this.calculator.calculateTimeline(events, rawInput);
  }

  private async loadRawInput(vehicleId: string, from: Date, to: Date): Promise<VehicleTimelineRawInput> {
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
        orderBy: [{ activatedAt: "asc" }, { createdAt: "asc" }],
        select: {
          activatedAt: true,
          createdAt: true,
          deletedAt: true,
          id: true,
          order: {
            select: {
              actualDeliveryAt: true,
              actualReturnAt: true,
              endDate: true,
              orderStatus: true,
              startDate: true,
              vehicleId: true
            }
          },
          orderId: true,
          status: true,
          updatedAt: true
        },
        where: {
          order: { vehicleId }
        }
      }),
      this.prisma.subscriptionOrder.findMany({
        orderBy: [{ createdAt: "asc" }, { updatedAt: "asc" }],
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
        where: {
          vehicleId
        }
      }),
      this.prisma.serviceCase.findMany({
        orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }],
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
        where: {
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
            }
          }
        },
        orderBy: [{ publishedAt: "asc" }, { inspectionDate: "asc" }, { createdAt: "asc" }],
        where: {
          vehicleId
        }
      })
    ]);

    return {
      conditionReports,
      from,
      leases,
      orders,
      serviceCases,
      to,
      vehicle,
      vehicleId
    };
  }
}
