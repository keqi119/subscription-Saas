import { CollectionActionResult, CollectionActionType, CollectionCaseStatus } from "@prisma/client";

import type {
  RiskArrearsPipeline,
  RiskCollectionCaseInput,
  RiskEvidence,
  RiskOverdueBillRef,
  RiskPaymentRecord,
  RiskPaymentWriteOffEvidence,
  RiskWarning
} from "./risk.types";

export interface ArrearsPipelineInput {
  asOf: Date;
  collectionCases: RiskCollectionCaseInput[];
  overdueFacts: RiskOverdueBillRef[];
  payments: RiskPaymentRecord[];
  vehicleId: string;
  writeOffs?: RiskPaymentWriteOffEvidence[];
}

export class ArrearsPipelineModel {
  build(input: ArrearsPipelineInput): RiskArrearsPipeline {
    const cases = input.collectionCases.filter((collectionCase) => collectionCase.vehicleId === input.vehicleId);
    const actions = cases.flatMap((collectionCase) => collectionCase.actions);
    const evidence: RiskEvidence[] = [];
    const warnings: RiskWarning[] = [];

    for (const fact of input.overdueFacts) {
      evidence.push({
        amount: fact.remainingAmount,
        observedAt: input.asOf,
        reason: "receivable bill remains the source of overdue truth",
        source: "receivable_bill",
        sourceId: fact.billId
      });
    }

    for (const collectionCase of cases) {
      evidence.push({
        amount: collectionCase.totalOverdueAmount,
        observedAt: input.asOf,
        reason: "collection case is supporting evidence only and does not suppress bill facts",
        source: "collection_case",
        sourceId: collectionCase.id
      });

      if (collectionCase.caseStatus === CollectionCaseStatus.CLOSED && input.overdueFacts.length > 0) {
        warnings.push({
          code: "CLOSED_COLLECTION_CASE_WITH_OPEN_OVERDUE_BILL",
          message: "A collection case is closed while bill-level overdue facts remain open.",
          sourceId: collectionCase.id
        });
      }

      const caseBillAmount = collectionCase.bills.reduce((total, bill) => total + bill.overdueAmount, 0);
      const factAmount = input.overdueFacts.reduce((total, fact) => total + fact.remainingAmount, 0);

      if (caseBillAmount > 0 && factAmount > 0 && caseBillAmount !== factAmount) {
        warnings.push({
          code: "COLLECTION_CASE_AMOUNT_STALE",
          message: "Collection case bill amount differs from current bill-level remaining exposure.",
          sourceId: collectionCase.id
        });
      }
    }

    for (const action of actions) {
      evidence.push({
        observedAt: input.asOf,
        reason: "collection action is supporting arrears pipeline evidence",
        source: "collection_action",
        sourceId: action.id
      });

      if (isPromiseToPay(action.actionType, action.actionResult) && action.promisedPayAt && startOfUtcDay(action.promisedPayAt) < startOfUtcDay(input.asOf)) {
        warnings.push({
          code: "PROMISE_TO_PAY_BREACHED",
          message: "Promise-to-pay date has passed while overdue facts remain open.",
          sourceId: action.id
        });
      }
    }

    return {
      actionRefs: actions.map((action) => ({
        actionId: action.id,
        actionType: action.actionType,
        result: action.actionResult
      })),
      billRefs: input.overdueFacts,
      caseRefs: cases.map((collectionCase) => ({
        caseId: collectionCase.id,
        caseStatus: collectionCase.caseStatus,
        collectionLevel: collectionCase.collectionLevel
      })),
      evidence,
      paymentRefs: input.payments.filter((payment) => payment.vehicleId === input.vehicleId).map((payment) => ({ paymentId: payment.id })),
      promiseToPayRefs: actions.filter((action) => isPromiseToPay(action.actionType, action.actionResult)).map((action) => ({
        actionId: action.id,
        promisedAmount: action.promisedAmount ?? null,
        promisedPayAt: action.promisedPayAt ?? null
      })),
      stage: resolveStage(input.overdueFacts, cases, actions),
      vehicleId: input.vehicleId,
      warnings,
      writeOffRefs: input.writeOffs ?? []
    };
  }
}

function resolveStage(overdueFacts: RiskOverdueBillRef[], cases: RiskCollectionCaseInput[], actions: RiskCollectionCaseInput["actions"]) {
  if (overdueFacts.length === 0) {
    return "NO_OVERDUE";
  }

  if (actions.some((action) => action.actionType === CollectionActionType.ESCALATION)) {
    return "ESCALATED";
  }

  if (cases.some((collectionCase) => collectionCase.caseStatus === CollectionCaseStatus.ACTIVE || collectionCase.caseStatus === CollectionCaseStatus.PAUSED)) {
    return "OVERDUE_WITH_ACTIVE_CASE";
  }

  if (cases.length > 0) {
    return "OVERDUE_WITH_STALE_CASE";
  }

  return "OVERDUE_WITHOUT_CASE";
}

function isPromiseToPay(actionType: CollectionActionType, actionResult: CollectionActionResult) {
  return actionType === CollectionActionType.PROMISE_TO_PAY || actionResult === CollectionActionResult.CUSTOMER_PROMISED;
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
