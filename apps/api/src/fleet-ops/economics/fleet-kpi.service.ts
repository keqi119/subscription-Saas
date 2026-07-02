import { Injectable } from "@nestjs/common";
import { DepositTransactionStatus, DepositTransactionType } from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";
import { VehicleTimelineService } from "../timeline/vehicle-timeline.service";
import { VehicleOperationalStateService } from "../vehicle-operational-state.service";
import {
  EconomicTimelineState,
  type EconomicDepositLedger,
  type EconomicDepreciationRecord,
  type EconomicOperationalStateSnapshot,
  type EconomicPaymentRecord,
  type EconomicReceivableBill,
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
        receivableBills: [],
        serviceCases: [],
        timelines: {},
        to,
        vehicles: [],
        writeOffAllocations: [],
        writeOffAdjustments: []
      });
    }

    const [vehicles, operationalStates, timelines, paymentRecords, receivableBills, depositLedgers, depreciationRecords, serviceCases] = await Promise.all([
      this.loadVehicles(normalizedVehicleIds),
      this.loadOperationalStates(normalizedVehicleIds, to),
      this.loadTimelines(normalizedVehicleIds, from, to),
      this.loadPaymentRecords(normalizedVehicleIds, from, to),
      this.loadReceivableBills(normalizedVehicleIds, from, to),
      this.loadDepositLedgers(normalizedVehicleIds, from, to),
      this.loadDepreciationRecords(normalizedVehicleIds, from, to),
      this.loadServiceCases(normalizedVehicleIds)
    ]);

    return this.calculator.calculate({
      depositLedgers,
      depreciationRecords,
      from,
      operationalStates,
      paymentRecords,
      receivableBills,
      serviceCases,
      timelines,
      to,
      vehicles,
      writeOffAllocations: [],
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

  private async loadReceivableBills(vehicleIds: string[], from: Date, to: Date): Promise<EconomicReceivableBill[]> {
    const bills = await this.prisma.receivableBill.findMany({
      orderBy: [{ dueDate: "asc" }, { id: "asc" }],
      select: {
        amount: true,
        billType: true,
        dueDate: true,
        id: true,
        order: {
          select: {
            vehicleId: true
          }
        }
      },
      where: {
        deletedAt: null,
        dueDate: {
          gte: from,
          lte: to
        },
        order: {
          vehicleId: { in: vehicleIds }
        }
      }
    });

    return bills.map((bill) => ({
      amount: amountToNumber(bill.amount),
      billType: bill.billType,
      dueDate: bill.dueDate,
      id: bill.id,
      vehicleId: bill.order.vehicleId
    }));
  }

  private async loadDepositLedgers(vehicleIds: string[], from: Date, to: Date): Promise<EconomicDepositLedger[]> {
    const ledgers = await this.prisma.depositLedger.findMany({
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      select: {
        amount: true,
        id: true,
        occurredAt: true,
        order: {
          select: {
            vehicleId: true
          }
        },
        transactionStatus: true,
        transactionType: true
      },
      where: {
        deletedAt: null,
        occurredAt: {
          gte: from,
          lte: to
        },
        order: {
          vehicleId: { in: vehicleIds }
        },
        transactionStatus: DepositTransactionStatus.CONFIRMED,
        transactionType: DepositTransactionType.COLLECT
      }
    });

    return ledgers.map((ledger) => ({
      amount: amountToNumber(ledger.amount),
      id: ledger.id,
      occurredAt: ledger.occurredAt,
      transactionStatus: ledger.transactionStatus,
      transactionType: ledger.transactionType,
      vehicleId: ledger.order.vehicleId
    }));
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

function toEconomicTimelineDay(day: { confidence: number; conflicts?: unknown[]; date: string; sourceEvents: string[]; state: string; warnings?: string[] }): EconomicTimelineDay {
  return {
    confidence: day.confidence,
    conflicts: day.conflicts ? [...day.conflicts] : [],
    date: day.date,
    sourceEvents: [...day.sourceEvents],
    state: toEconomicTimelineState(day.state),
    warnings: day.warnings ? [...day.warnings] : []
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
