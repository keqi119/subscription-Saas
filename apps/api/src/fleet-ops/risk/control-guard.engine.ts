import { CollectionPriorityLevel, ControlDecision, RiskSignalCode, type ControlGuardResult, type GuardLeaseRef, type GuardOrderRef, type RiskOutput, type RiskVehicleContext } from "./risk.types";
import { hasCriticalConditionReport } from "./risk-signals.builder";
import { hasActiveLease, hasSevereOpenServiceCase } from "./risk-score.model";

export class ControlGuardEngine {
  private readonly riskByVehicleId: Map<string, RiskOutput>;
  private readonly vehicleIdByLeaseId: Map<string, string | null>;
  private readonly vehicleIdByOrderId: Map<string, string | null>;

  constructor(riskSnapshots: RiskOutput[] = [], refs: { leases?: GuardLeaseRef[]; orders?: GuardOrderRef[] } = {}) {
    this.riskByVehicleId = new Map(riskSnapshots.map((snapshot) => [snapshot.vehicleId, snapshot]));
    this.vehicleIdByLeaseId = new Map((refs.leases ?? []).map((lease) => [lease.leaseId, lease.vehicleId]));
    this.vehicleIdByOrderId = new Map((refs.orders ?? []).map((order) => [order.orderId, order.vehicleId]));
  }

  decide(context: RiskVehicleContext, collectionLevel: CollectionPriorityLevel, riskScore: number): { controlDecision: ControlDecision; reasons: string[] } {
    const reasons: string[] = [];
    const hasOverdueSignal = context.signals.some((signal) => signal.code === RiskSignalCode.OVERDUE_SIGNAL);
    const hasPaymentInconsistencySignal = context.signals.some((signal) => signal.code === RiskSignalCode.PAYMENT_INCONSISTENCY_SIGNAL);
    const hasTimelineConflictSignal = context.signals.some((signal) => signal.code === RiskSignalCode.TIMELINE_CONFLICT_SIGNAL);
    const hasRoiCollapseSignal = context.signals.some((signal) => signal.code === RiskSignalCode.ROI_COLLAPSE_SIGNAL);
    const conditionRisk = hasCriticalConditionReport(context.vehicleId, context.input);
    const serviceRisk = hasSevereOpenServiceCase(context.vehicleId, context.input);

    if (context.exposure.score >= 85 && hasOverdueSignal) {
      reasons.push("High overdue exposure requires intervention.");
    }

    if (hasActiveLease(context.vehicleId, context.input) && (serviceRisk || conditionRisk)) {
      reasons.push("Active lease has severe service or condition risk.");
    }

    if (conditionRisk && serviceRisk) {
      reasons.push("Critical condition report is paired with unresolved service case.");
    }

    if (reasons.length > 0 || collectionLevel === CollectionPriorityLevel.D5) {
      return {
        controlDecision: ControlDecision.BLOCK,
        reasons: uniqueReasons(reasons)
      };
    }

    if (context.exposure.score >= 50 && hasTimelineConflictSignal) {
      reasons.push("Moderate overdue exposure is paired with unstable timeline evidence.");
    }

    if (hasRoiCollapseSignal) {
      reasons.push("ROI trend is below the warning threshold.");
    }

    if (hasPaymentInconsistencySignal) {
      reasons.push("Payment consistency requires operator review.");
    }

    if (riskScore >= 40 || reasons.length > 0) {
      return {
        controlDecision: ControlDecision.WARN,
        reasons: uniqueReasons(reasons.length > 0 ? reasons : ["Risk score is elevated and should be reviewed."])
      };
    }

    return {
      controlDecision: ControlDecision.ALLOW,
      reasons: ["Risk signals within normal control tolerance."]
    };
  }

  canAllocateVehicle(vehicleId: string): ControlGuardResult {
    return this.evaluateVehicle(vehicleId);
  }

  canActivateLease(leaseId: string): ControlGuardResult {
    return this.evaluateVehicle(this.vehicleIdByLeaseId.get(leaseId) ?? null);
  }

  canProceedWithOrder(orderId: string): ControlGuardResult {
    return this.evaluateVehicle(this.vehicleIdByOrderId.get(orderId) ?? null);
  }

  private evaluateVehicle(vehicleId: string | null): ControlGuardResult {
    const riskSnapshot = vehicleId ? this.riskByVehicleId.get(vehicleId) : undefined;

    if (!riskSnapshot) {
      return {
        allowed: false,
        reason: ["Risk snapshot is unavailable for this decision."],
        riskSnapshot: missingRiskSnapshot(vehicleId)
      };
    }

    return {
      allowed: riskSnapshot.controlDecision !== ControlDecision.BLOCK,
      reason: riskSnapshot.reasons,
      riskSnapshot
    };
  }
}

function missingRiskSnapshot(vehicleId: string | null): RiskOutput {
  return {
    collectionLevel: CollectionPriorityLevel.D5,
    confidence: 0,
    controlDecision: ControlDecision.BLOCK,
    exposureScore: 100,
    reasons: ["Risk snapshot is unavailable for this decision."],
    riskScore: 100,
    signals: [],
    vehicleId: vehicleId ?? "UNKNOWN"
  };
}

function uniqueReasons(reasons: string[]) {
  return [...new Set(reasons)];
}
