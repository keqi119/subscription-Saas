import { Injectable } from "@nestjs/common";
import { PaymentStatus } from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";
import { VehicleTimelineService } from "../timeline/vehicle-timeline.service";
import { VehicleOperationalStateService } from "../vehicle-operational-state.service";
import {
  EconomicTimelineState,
  type EconomicDepreciationRecord,
  type EconomicOperationalStateSnapshot,
  type EconomicPaymentRecord,
  type EconomicServiceCase,
  type EconomicTimelineDay,
  type FleetKpiReport,
  type FleetKpiVehicleInput
} from "./economics.types";
import { FleetKpiCalculator } from "./fleet-kpi.calculator";

@Injectable()
export class FleetKpiService {
  private readonly calculator = new FleetKpiCalculator();

  constructor(
    private readonly prisma: PrismaService,
    private readonly operationalStateService: VehicleOperationalStateService,
    private readonly timelineService: VehicleTimelineService
  ) {}

  async getFleetKpis(vehicleIds: string[], from: Date, to: Date): Promise<FleetKpiReport> {
    const normalizedVehicleIds = [...new Set(vehicleIds)];

    if (normalizedVehicleIds.length === 0) {
      return this.calculator.calculate({
        depreciationRecords: [],
        from,
        operationalStates: [],
        paymentRecords: [],
        serviceCases: [],
        timelines: {},
        to,
        vehicles: [],
        writeOffAdjustments: []
      });
    }

    const [vehicles, operationalStates, timelines, paymentRecords, depreciationRecords, serviceCases] = await Promise.all([
      this.loadVehicles(normalizedVehicleIds),
      this.loadOperationalStates(normalizedVehicleIds, to),
      this.loadTimelines(normalizedVehicleIds, from, to),
      this.loadPaymentRecords(normalizedVehicleIds, from, to),
      this.loadDepreciationRecords(normalizedVehicleIds, from, to),
      this.loadServiceCases(normalizedVehicleIds)
    ]);

    return this.calculator.calculate({
      depreciationRecords,
      from,
      operationalStates,
      paymentRecords,
      serviceCases,
      timelines,
      to,
      vehicles,
      writeOffAdjustments: []
    });
  }

  private async loadVehicles(vehicleIds: string[]): Promise<FleetKpiVehicleInput[]> {
    const vehicles = await this.prisma.vehicle.findMany({
      orderBy: { id: "asc" },
      select: {
        id: true,
        purchasePriceAmount: true
      },
      where: {
        id: { in: vehicleIds }
      }
    });
    const vehicleById = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));

    return vehicleIds.map((vehicleId) => {
      const vehicle = vehicleById.get(vehicleId);
      const investedCapital = amountToNumber(vehicle?.purchasePriceAmount);

      return {
        equityBase: investedCapital,
        investedCapital,
        vehicleId
      };
    });
  }

  private async loadOperationalStates(vehicleIds: string[], asOf: Date): Promise<EconomicOperationalStateSnapshot[]> {
    return Promise.all(
      vehicleIds.map(async (vehicleId) => {
        const state = await this.operationalStateService.resolveVehicleOperationalState(vehicleId, asOf);

        return {
          confidenceScore: state.confidenceScore,
          vehicleId
        };
      })
    );
  }

  private async loadTimelines(vehicleIds: string[], from: Date, to: Date): Promise<Record<string, EconomicTimelineDay[]>> {
    const entries = await Promise.all(
      vehicleIds.map(async (vehicleId) => {
        const timeline = await this.timelineService.getVehicleTimeline(vehicleId, from, to);

        return [vehicleId, timeline.map(toEconomicTimelineDay)] as const;
      })
    );

    return Object.fromEntries(entries);
  }

  private async loadPaymentRecords(vehicleIds: string[], from: Date, to: Date): Promise<EconomicPaymentRecord[]> {
    const paymentRecords = await this.prisma.paymentRecord.findMany({
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        order: {
          select: {
            vehicleId: true
          }
        },
        paymentAmount: true,
        paymentStatus: true,
        receivedAt: true,
        writeOffs: {
          select: {
            bill: {
              select: {
                billType: true
              }
            },
            order: {
              select: {
                vehicleId: true
              }
            },
            writeOffAmount: true
          },
          where: {
            deletedAt: null
          }
        }
      },
      where: {
        deletedAt: null,
        order: {
          vehicleId: { in: vehicleIds }
        },
        paymentStatus: PaymentStatus.CONFIRMED,
        receivedAt: {
          gte: from,
          lte: to
        }
      }
    });

    return paymentRecords.flatMap((paymentRecord): EconomicPaymentRecord[] => {
      if (paymentRecord.writeOffs.length === 0) {
        return [
          {
            amount: amountToNumber(paymentRecord.paymentAmount),
            billType: null,
            id: paymentRecord.id,
            paymentStatus: paymentRecord.paymentStatus,
            receivedAt: paymentRecord.receivedAt,
            vehicleId: paymentRecord.order.vehicleId
          }
        ];
      }

      return paymentRecord.writeOffs.map((writeOff, index) => ({
        amount: amountToNumber(writeOff.writeOffAmount),
        billType: writeOff.bill.billType,
        id: `${paymentRecord.id}:${index}`,
        paymentStatus: paymentRecord.paymentStatus,
        receivedAt: paymentRecord.receivedAt,
        vehicleId: writeOff.order?.vehicleId ?? paymentRecord.order.vehicleId
      }));
    });
  }

  private async loadDepreciationRecords(vehicleIds: string[], from: Date, to: Date): Promise<EconomicDepreciationRecord[]> {
    const records = await this.prisma.vehicleDepreciationRecord.findMany({
      orderBy: [{ periodStart: "asc" }, { id: "asc" }],
      select: {
        depreciationAmount: true,
        recordStatus: true,
        vehicleId: true
      },
      where: {
        deletedAt: null,
        periodEnd: { gte: from },
        periodStart: { lte: to },
        vehicleId: { in: vehicleIds }
      }
    });

    return records.map((record) => ({
      amount: amountToNumber(record.depreciationAmount),
      recordStatus: record.recordStatus,
      vehicleId: record.vehicleId
    }));
  }

  private async loadServiceCases(vehicleIds: string[]): Promise<EconomicServiceCase[]> {
    const serviceCases = await this.prisma.serviceCase.findMany({
      orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        caseType: true,
        id: true,
        priority: true,
        vehicleId: true
      },
      where: {
        deletedAt: null,
        vehicleId: { in: vehicleIds }
      }
    });

    return serviceCases.map((serviceCase) => ({
      caseType: serviceCase.caseType,
      id: serviceCase.id,
      priority: serviceCase.priority,
      vehicleId: serviceCase.vehicleId
    }));
  }
}

function toEconomicTimelineDay(day: { confidence: number; date: string; sourceEvents: string[]; state: string }): EconomicTimelineDay {
  return {
    confidence: day.confidence,
    date: day.date,
    sourceEvents: [...day.sourceEvents],
    state: toEconomicTimelineState(day.state)
  };
}

function toEconomicTimelineState(state: string): EconomicTimelineState {
  if (state in EconomicTimelineState) {
    return EconomicTimelineState[state as keyof typeof EconomicTimelineState];
  }

  return EconomicTimelineState.UNKNOWN;
}

function amountToNumber(amount: bigint | number | null | undefined) {
  if (typeof amount === "bigint") {
    return Number(amount);
  }

  if (typeof amount === "number") {
    return amount;
  }

  return 0;
}
