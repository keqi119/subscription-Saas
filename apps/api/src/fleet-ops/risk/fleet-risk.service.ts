import { Injectable } from "@nestjs/common";

import { FleetKpiService } from "../economics/fleet-kpi.service";
import { PrismaService } from "../../prisma/prisma.service";
import { VehicleTimelineService } from "../timeline/vehicle-timeline.service";
import { VehicleOperationalStateService } from "../vehicle-operational-state.service";
import { FleetRiskCalculator } from "./fleet-risk.calculator";
import {
  type FleetRiskInput,
  type FleetRiskReport,
  type RiskConditionReportInput,
  type RiskLeaseInput,
  type RiskOperationalStateInput,
  type RiskOrderInput,
  type RiskPaymentRecord,
  type RiskReceivableBill,
  type RiskServiceCaseInput,
  type RiskTimelineDay
} from "./risk.types";

@Injectable()
export class FleetRiskService {
  private readonly calculator = new FleetRiskCalculator();

  constructor(
    private readonly prisma: PrismaService,
    private readonly operationalStateService: VehicleOperationalStateService,
    private readonly timelineService: VehicleTimelineService,
    private readonly kpiService: FleetKpiService
  ) {}

  async getFleetRisk(vehicleIds: string[], from: Date, to: Date): Promise<FleetRiskReport> {
    const normalizedVehicleIds = [...new Set(vehicleIds)];

    if (normalizedVehicleIds.length === 0) {
      return this.calculator.calculate(emptyRiskInput(from, to));
    }

    const [operationalStates, timelines, fleetKpis, receivableBills, paymentRecords, leases, orders, serviceCases, conditionReports] = await Promise.all([
      this.loadOperationalStates(normalizedVehicleIds, to),
      this.loadTimelines(normalizedVehicleIds, from, to),
      this.kpiService.getFleetKpis(normalizedVehicleIds, from, to),
      this.loadReceivableBills(normalizedVehicleIds),
      this.loadPaymentRecords(normalizedVehicleIds, from, to),
      this.loadLeases(normalizedVehicleIds),
      this.loadOrders(normalizedVehicleIds),
      this.loadServiceCases(normalizedVehicleIds),
      this.loadConditionReports(normalizedVehicleIds)
    ]);

    return this.calculator.calculate({
      asOf: to,
      conditionReports,
      fleetKpis,
      leases,
      operationalStates,
      orders,
      paymentRecords,
      receivableBills,
      serviceCases,
      timelines,
      vehicleIds: normalizedVehicleIds
    });
  }

  private async loadOperationalStates(vehicleIds: string[], asOf: Date): Promise<RiskOperationalStateInput[]> {
    return Promise.all(
      vehicleIds.map(async (vehicleId) => {
        const state = await this.operationalStateService.resolveVehicleOperationalState(vehicleId, asOf);

        return {
          computedState: state.computedState,
          confidenceScore: state.confidenceScore,
          vehicleId
        };
      })
    );
  }

  private async loadTimelines(vehicleIds: string[], from: Date, to: Date): Promise<Record<string, RiskTimelineDay[]>> {
    const entries = await Promise.all(
      vehicleIds.map(async (vehicleId) => {
        const timeline = await this.timelineService.getVehicleTimeline(vehicleId, from, to);

        return [vehicleId, timeline.map(toRiskTimelineDay)] as const;
      })
    );

    return Object.fromEntries(entries);
  }

  private async loadReceivableBills(vehicleIds: string[]): Promise<RiskReceivableBill[]> {
    const bills = await this.prisma.receivableBill.findMany({
      orderBy: [{ dueDate: "asc" }, { id: "asc" }],
      select: {
        amount: true,
        billStatus: true,
        billType: true,
        dueDate: true,
        id: true,
        order: {
          select: {
            vehicleId: true
          }
        },
        paidAmount: true,
        remainingAmount: true
      },
      where: {
        deletedAt: null,
        order: {
          vehicleId: { in: vehicleIds }
        }
      }
    });

    return bills.map((bill) => ({
      amount: amountToNumber(bill.amount),
      billStatus: bill.billStatus,
      billType: bill.billType,
      dueDate: bill.dueDate,
      id: bill.id,
      paidAmount: amountToNumber(bill.paidAmount),
      remainingAmount: amountToNumber(bill.remainingAmount),
      vehicleId: bill.order.vehicleId
    }));
  }

  private async loadPaymentRecords(vehicleIds: string[], from: Date, to: Date): Promise<RiskPaymentRecord[]> {
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
        receivedAt: true
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

    return paymentRecords.map((payment) => ({
      amount: amountToNumber(payment.paymentAmount),
      id: payment.id,
      paymentStatus: payment.paymentStatus,
      receivedAt: payment.receivedAt,
      vehicleId: payment.order.vehicleId
    }));
  }

  private async loadLeases(vehicleIds: string[]): Promise<RiskLeaseInput[]> {
    const leases = await this.prisma.lease.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        order: {
          select: {
            vehicleId: true
          }
        },
        status: true
      },
      where: {
        deletedAt: null,
        order: {
          vehicleId: { in: vehicleIds }
        }
      }
    });

    return leases.map((lease) => ({
      id: lease.id,
      status: lease.status,
      vehicleId: lease.order.vehicleId
    }));
  }

  private async loadOrders(vehicleIds: string[]): Promise<RiskOrderInput[]> {
    const orders = await this.prisma.subscriptionOrder.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        orderStatus: true,
        vehicleId: true
      },
      where: {
        deletedAt: null,
        vehicleId: { in: vehicleIds }
      }
    });

    return orders.map((order) => ({
      id: order.id,
      orderStatus: order.orderStatus,
      vehicleId: order.vehicleId
    }));
  }

  private async loadServiceCases(vehicleIds: string[]): Promise<RiskServiceCaseInput[]> {
    const serviceCases = await this.prisma.serviceCase.findMany({
      orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        caseStatus: true,
        caseType: true,
        closedAt: true,
        id: true,
        priority: true,
        resolvedAt: true,
        vehicleId: true
      },
      where: {
        deletedAt: null,
        vehicleId: { in: vehicleIds }
      }
    });

    return serviceCases.map((serviceCase) => ({
      caseStatus: serviceCase.caseStatus,
      caseType: serviceCase.caseType,
      closedAt: serviceCase.closedAt,
      id: serviceCase.id,
      priority: serviceCase.priority,
      resolvedAt: serviceCase.resolvedAt,
      vehicleId: serviceCase.vehicleId
    }));
  }

  private async loadConditionReports(vehicleIds: string[]): Promise<RiskConditionReportInput[]> {
    const conditionReports = await this.prisma.vehicleConditionReport.findMany({
      include: {
        items: {
          select: {
            affectsSafety: true,
            id: true,
            repairRequired: true,
            result: true,
            severity: true
          },
          where: {
            deletedAt: null
          }
        }
      },
      orderBy: [{ publishedAt: "asc" }, { id: "asc" }],
      where: {
        deletedAt: null,
        vehicleId: { in: vehicleIds }
      }
    });

    return conditionReports.map((report) => ({
      id: report.id,
      items: report.items.map((item) => ({
        affectsSafety: item.affectsSafety,
        id: item.id,
        repairRequired: item.repairRequired,
        result: item.result,
        severity: item.severity
      })),
      publishedAt: report.publishedAt,
      reportStatus: report.reportStatus,
      vehicleId: report.vehicleId
    }));
  }
}

function emptyRiskInput(from: Date, to: Date): FleetRiskInput {
  return {
    asOf: to,
    conditionReports: [],
    fleetKpis: {
      fleet: {
        cost: 0,
        downtimeCost: 0,
        downtimeDays: 0,
        leasedDays: 0,
        netIncome: 0,
        operatingDays: 0,
        revenue: 0,
        roe: 0,
        roi: 0,
        utilizationRate: 0,
        vehicleCount: 0
      },
      vehicles: []
    },
    leases: [],
    operationalStates: [],
    orders: [],
    paymentRecords: [],
    receivableBills: [],
    serviceCases: [],
    timelines: {},
    vehicleIds: []
  };
}

function toRiskTimelineDay(day: {
  confidence: number;
  conflicts?: unknown[];
  date: string;
  sourceEvents: string[];
  state: string;
}): RiskTimelineDay {
  return {
    confidence: day.confidence,
    conflicts: [...(day.conflicts ?? [])],
    date: day.date,
    sourceEvents: [...day.sourceEvents],
    state: day.state
  };
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
