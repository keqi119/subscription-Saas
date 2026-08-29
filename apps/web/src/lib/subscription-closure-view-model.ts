export interface SubscriptionClosureActionView {
  key: string;
  label: string;
}

export interface SubscriptionClosureChecklistItemView {
  expectedQuantity: number | null;
  id: string;
  itemCode: string;
  remark: string | null;
  returnedQuantity: number | null;
  state: string;
}

export interface SubscriptionClosureChecklistView {
  attestationMode: string;
  capturedAt: string | null;
  id: string;
  items: SubscriptionClosureChecklistItemView[];
  manifestHash: string;
  revisionNumber: number;
}

export interface SubscriptionClosureEvidenceView {
  checklistItemId: string | null;
  damageId: string | null;
  evidenceId: string | null;
  evidencePurpose: string;
  id: string;
  legacyExternalReference: string | null;
  visibility: string;
}

export interface SubscriptionClosureDeltaItemView {
  decisionReason: string;
  id: string;
  itemCode: string;
  quantityDifference: number;
  responsibility: string;
  wearClassification: string;
}

export interface SubscriptionClosureChargeLineView {
  amountCents: string;
  billId: string | null;
  chargeType: string;
  clauseSnapshotId: string | null;
  deltaItemId: string | null;
  exceptionApprovalId: string | null;
  id: string;
  lineCode: string;
  quantity: string;
  responsibility: string;
  settlementRevisionId: string;
  status: string;
  unitPriceCents: string;
}

export function acceptedDisputeDeltaItemIds(input: {
  chargeLines: readonly Pick<SubscriptionClosureChargeLineView, "deltaItemId" | "id">[];
  currentDeltaItemIds: readonly string[];
  disputes: readonly Readonly<{ chargeLineId: string; status: string }>[];
}) {
  const acceptedLineIds = new Set(
    input.disputes
      .filter(({ status }) => status === "ACCEPTED_BY_PLATFORM")
      .map(({ chargeLineId }) => chargeLineId)
  );
  const currentDeltaItemIds = new Set(input.currentDeltaItemIds);
  return new Set(
    input.chargeLines
      .filter(
        ({ deltaItemId, id }) =>
          acceptedLineIds.has(id) &&
          typeof deltaItemId === "string" &&
          currentDeltaItemIds.has(deltaItemId)
      )
      .map(({ deltaItemId }) => deltaItemId as string)
  );
}

export interface SubscriptionClosureApprovalView {
  amountCents: string | null;
  approvalType: string | null;
  billId: string | null;
  checklistItemId: string | null;
  checklistItemState: string | null;
  checklistManifestHash: string | null;
  checklistRevisionId: string | null;
  clauseSnapshotId: string | null;
  decision: string | null;
  deltaItemId: string | null;
  evidenceIds: string[];
  id: string;
  manualBasis: string | null;
  manualUnitPriceCents: string | null;
  requestedBy: string;
  settlementRevisionId: string | null;
  status: string;
  subjectField: string;
  type: string;
  version: number;
}

export interface AdminSubscriptionClosureView {
  allowedActions: SubscriptionClosureActionView[];
  approvals: SubscriptionClosureApprovalView[];
  auditLinks: Array<{ action: string; createdAt: string | null; entityType: string; id: string }>;
  caseNo: string;
  capabilities: {
    inspect: boolean;
    prepare: boolean;
    receive: boolean;
    settle: boolean;
  };
  chargeLines: SubscriptionClosureChargeLineView[];
  checklist: SubscriptionClosureChecklistView | null;
  closureCaseId: string;
  closureType: string;
  contractChargeClauses: Array<{
    chargeType: string;
    clauseCode: string;
    id: string;
    status: string;
    unit: string;
  }>;
  customerResponse: { id: string; status: string } | null;
  delta: {
    id: string;
    items: SubscriptionClosureDeltaItemView[];
    resultHash: string;
    revisionNumber: number;
  } | null;
  disputes: Array<{
    chargeLineId: string;
    customerReason: string;
    id: string;
    status: string;
  }>;
  evidencePackages: Array<{ id: string; manifestHash: string; version: number }>;
  evidenceLinks: SubscriptionClosureEvidenceView[];
  finalDisposition: string | null;
  financialStatus: string;
  legalCases: Array<{
    billId: string;
    closedAt: string | null;
    events: Array<{
      amountCents: string | null;
      eventType: string;
      id: string;
      occurredAt: string;
    }>;
    id: string;
    ownerType: string;
    transferredAmountCents: string;
  }>;
  operationalCompletedAt: string | null;
  physicalControlMode: string | null;
  restrictions: Array<{ id: string; status: string; type: string }>;
  receivableBills: Array<{
    amount: string;
    billNo: string;
    billStatus: string;
    billType: string;
    id: string;
    paidAmount: string;
    remainingAmount: string;
  }>;
  receivableDispositions: Array<{
    billId: string;
    disposition: string;
    id: string;
    ownerType: string;
    proofFileId: string | null;
  }>;
  returnManifestSigning: {
    cancellable: boolean;
    expiresAt: string | null;
    provider: string;
    signUrl: string | null;
    taskId: string;
    taskStatus: string;
  } | null;
  returnThreeStageEnabled: boolean;
  settlementRevisions: Array<{
    amountDueCents: string;
    amountRefundableCents: string;
    finalizedAt: string | null;
    publishedAt: string | null;
    id: string;
    resultHash: string;
    revisionNumber: number;
    stage: string;
    supersedesRevisionId: string | null;
    waiverApprovalId: string | null;
    writeOffApprovalId: string | null;
  }>;
  status: string;
  timeline: Array<{ id: string; occurredAt: string | null; type: string }>;
  workOrders: Array<{ id: string; number: string | null; status: string; type: string }>;
}

export interface CustomerSubscriptionClosureView {
  allowedActions: string[];
  caseNo: string;
  chargeLines: SubscriptionClosureChargeLineView[];
  checklist: SubscriptionClosureChecklistView | null;
  closureCaseId: string;
  closureType: string;
  contractChargeClauses: Array<{
    chargeType: string;
    clauseCode: string;
    id: string;
    sourceTextLocator: string;
    status: string;
    unit: string;
  }>;
  customerResponse: { id: string; status: string } | null;
  delta: {
    id: string;
    items: SubscriptionClosureDeltaItemView[];
    resultHash: string;
    revisionNumber: number;
  } | null;
  disputes: Array<{
    chargeLineId: string;
    customerReason: string;
    id: string;
    status: string;
  }>;
  evidenceReferences: Array<{ evidenceType: string; fileId: string; id: string }>;
  evidenceLinks: SubscriptionClosureEvidenceView[];
  financialStatus: string;
  nextAction: string;
  payableBillIds: string[];
  returnAppointment: { location: string | null; scheduledAt: string | null } | null;
  returnManifestSigning: {
    expiresAt: string | null;
    mock: boolean;
    provider: string;
    signUrl: string | null;
    taskId: string;
    taskStatus: string;
  } | null;
  returnThreeStageEnabled: boolean;
  settlement: {
    amountDueCents: string;
    amountRefundableCents: string;
    id: string;
    pricingSettlementRevisionId: string | null;
    resultHash: string;
    stage: string;
  } | null;
  signedReferences: Array<{ documentType: string; fileId: string; stage: string }>;
  status: string;
}

export function buildAdminSubscriptionClosureView(
  value: unknown,
  permissions: ReadonlySet<string>
): AdminSubscriptionClosureView {
  const aggregate = record(value);
  const closureCase = requiredRecord(aggregate.closureCase);
  const status = requiredString(closureCase.status);
  const caseNo = requiredString(closureCase.caseNo);
  const closureType = requiredString(closureCase.closureType);
  const workOrders = records(aggregate.workOrders).map((item) => ({
    id: requiredString(item.id),
    number: optionalString(item.workOrderNo),
    status: requiredString(item.status),
    type: requiredString(item.workOrderType)
  }));
  const restrictions = records(aggregate.workOrders).flatMap((workOrder) =>
    records(workOrder.restrictions).map((item) => ({
      id: requiredString(item.id),
      status: requiredString(item.status),
      type: requiredString(item.restrictionType)
    }))
  );
  const checklist = optionalLatestRecord(aggregate.checklistRevisions);
  const delta = optionalLatestRecord(aggregate.deltaRevisions);
  const settlementRecords = records(aggregate.settlementRevisions);
  const latestSettlement = settlementRecords.at(-1) ?? null;
  const responseSettlementId =
    latestSettlement?.stage === "SETTLED"
      ? optionalString(latestSettlement.supersedesRevisionId)
      : optionalString(latestSettlement?.id);
  const customerResponse =
    [...records(aggregate.customerResponses)]
      .reverse()
      .find((item) => optionalString(item.settlementRevisionId) === responseSettlementId) ?? null;
  const returnManifestTaskValue = aggregate.returnManifestTask;
  const returnManifestTask =
    returnManifestTaskValue === null || returnManifestTaskValue === undefined
      ? null
      : requiredRecord(returnManifestTaskValue);
  const serverActions = stringArray(aggregate.allowedActions)
    .filter((key) => {
      const permission = actionPermission(key);
      return permission === null || permissions.has(permission);
    })
    .map((key) => ({
      key,
      label: actionLabel(key)
    }));

  return {
    allowedActions: uniqueActions([...recoveryActions(status, permissions), ...serverActions]),
    approvals: records(aggregate.approvals).map(buildApproval),
    auditLinks: records(aggregate.audits).map((item) => ({
      action: requiredString(item.action),
      createdAt: optionalString(item.createdAt),
      entityType: requiredString(item.entityType),
      id: requiredString(item.id)
    })),
    caseNo,
    capabilities: {
      inspect: permissions.has("subscription_closure:inspect"),
      prepare: permissions.has("subscription_closure:prepare"),
      receive: permissions.has("subscription_closure:receive"),
      settle: permissions.has("subscription_closure:settle")
    },
    chargeLines: records(aggregate.chargeLines).map(buildChargeLine),
    checklist: checklist ? buildChecklist(checklist) : null,
    closureCaseId: requiredString(closureCase.id),
    closureType,
    contractChargeClauses: records(aggregate.contractChargeClauses).map((item) => ({
      chargeType: requiredString(item.chargeType),
      clauseCode: requiredString(item.clauseCode),
      id: requiredString(item.id),
      status: requiredString(item.status),
      unit: requiredString(item.unit)
    })),
    customerResponse: customerResponse
      ? { id: requiredString(customerResponse.id), status: requiredString(customerResponse.status) }
      : null,
    delta: delta ? buildDelta(delta) : null,
    disputes: records(aggregate.disputes).map(buildDispute),
    evidencePackages: records(aggregate.evidencePackages).map((item) => ({
      id: requiredString(item.id),
      manifestHash: requiredString(item.manifestHash),
      version: requiredNumber(item.version)
    })),
    evidenceLinks: records(aggregate.evidenceLinks).map(buildEvidence),
    finalDisposition: optionalString(closureCase.finalDisposition),
    financialStatus: optionalString(closureCase.financialStatus) ?? "DRAFT",
    legalCases: records(aggregate.legalCases).map((item) => ({
      billId: requiredString(item.billId),
      closedAt: optionalString(item.closedAt),
      events: records(item.events).map((event) => ({
        amountCents:
          event.amountCents === null || event.amountCents === undefined
            ? null
            : integerString(event.amountCents),
        eventType: requiredString(event.eventType),
        id: requiredString(event.id),
        occurredAt: requiredString(event.occurredAt)
      })),
      id: requiredString(item.id),
      ownerType: requiredString(item.ownerType),
      transferredAmountCents: integerString(item.transferredAmountCents)
    })),
    operationalCompletedAt: optionalString(closureCase.operationalCompletedAt),
    physicalControlMode: optionalString(closureCase.physicalControlMode),
    restrictions,
    receivableBills: records(aggregate.receivableBills).map((item) => ({
      amount: integerString(item.amount),
      billNo: requiredString(item.billNo),
      billStatus: requiredString(item.billStatus),
      billType: requiredString(item.billType),
      id: requiredString(item.id),
      paidAmount: integerString(item.paidAmount),
      remainingAmount: integerString(item.remainingAmount)
    })),
    receivableDispositions: records(aggregate.receivableDispositions).map((item) => ({
      billId: requiredString(item.billId),
      disposition: requiredString(item.disposition),
      id: requiredString(item.id),
      ownerType: requiredString(item.ownerType),
      proofFileId: optionalString(item.proofFileId)
    })),
    returnManifestSigning: returnManifestTask
      ? {
          cancellable:
            ["MOCK", "FADADA"].includes(requiredString(returnManifestTask.provider)) ||
            optionalString(returnManifestTask.providerTaskId) === null,
          expiresAt: optionalString(returnManifestTask.signUrlExpiresAt),
          provider: requiredString(returnManifestTask.provider),
          signUrl: optionalString(returnManifestTask.signUrl),
          taskId: requiredString(returnManifestTask.id),
          taskStatus: requiredString(returnManifestTask.taskStatus)
        }
      : null,
    returnThreeStageEnabled: aggregate.returnThreeStageEnabled === true,
    settlementRevisions: settlementRecords.map((item) => ({
      amountDueCents: integerString(item.amountDueCents),
      amountRefundableCents: integerString(item.amountRefundableCents),
      finalizedAt: optionalString(item.finalizedAt),
      publishedAt: optionalString(item.publishedAt),
      id: requiredString(item.id),
      resultHash: requiredString(item.resultHash),
      revisionNumber: requiredNumber(item.revisionNumber),
      stage: requiredString(item.stage),
      supersedesRevisionId: optionalString(item.supersedesRevisionId),
      waiverApprovalId: optionalString(item.waiverApprovalId),
      writeOffApprovalId: optionalString(item.writeOffApprovalId)
    })),
    status,
    timeline: records(aggregate.events).map((item) => ({
      id: requiredString(item.id),
      occurredAt: optionalString(item.occurredAt),
      type: requiredString(item.eventType)
    })),
    workOrders
  };
}

export function buildCustomerSubscriptionClosureView(
  value: unknown
): CustomerSubscriptionClosureView {
  const aggregate = record(value);
  const appointmentValue = aggregate.returnAppointment;
  const settlementValue = aggregate.settlement;
  const appointment =
    appointmentValue === null || appointmentValue === undefined
      ? null
      : requiredRecord(appointmentValue);
  const settlement =
    settlementValue === null || settlementValue === undefined
      ? null
      : requiredRecord(settlementValue);
  const checklistValue = aggregate.checklist;
  const deltaValue = aggregate.delta;
  const responseValue = aggregate.customerResponse;
  const returnManifestSigningValue = aggregate.returnManifestSigning;
  const checklist =
    checklistValue === null || checklistValue === undefined
      ? null
      : requiredRecord(checklistValue);
  const delta =
    deltaValue === null || deltaValue === undefined ? null : requiredRecord(deltaValue);
  const customerResponse =
    responseValue === null || responseValue === undefined
      ? null
      : requiredRecord(responseValue);
  const returnManifestSigning =
    returnManifestSigningValue === null || returnManifestSigningValue === undefined
      ? null
      : requiredRecord(returnManifestSigningValue);
  return {
    allowedActions: stringArray(aggregate.allowedActions),
    caseNo: requiredString(aggregate.caseNo),
    chargeLines: records(aggregate.chargeLines).map(buildChargeLine),
    checklist: checklist ? buildChecklist(checklist) : null,
    closureCaseId: requiredString(aggregate.closureCaseId),
    closureType: requiredString(aggregate.closureType),
    contractChargeClauses: records(aggregate.contractChargeClauses).map((item) => ({
      chargeType: requiredString(item.chargeType),
      clauseCode: requiredString(item.clauseCode),
      id: requiredString(item.id),
      sourceTextLocator: requiredString(item.sourceTextLocator),
      status: requiredString(item.status),
      unit: requiredString(item.unit)
    })),
    customerResponse: customerResponse
      ? { id: requiredString(customerResponse.id), status: requiredString(customerResponse.status) }
      : null,
    delta: delta ? buildDelta(delta) : null,
    disputes: records(aggregate.disputes).map(buildDispute),
    evidenceReferences: records(aggregate.evidenceReferences).map((item) => ({
      evidenceType: requiredString(item.evidenceType),
      fileId: requiredString(item.fileId),
      id: requiredString(item.id)
    })),
    evidenceLinks: records(aggregate.evidenceLinks).map(buildEvidence),
    financialStatus: optionalString(aggregate.financialStatus) ?? "DRAFT",
    nextAction: requiredString(aggregate.nextAction),
    payableBillIds: stringArray(aggregate.payableBillIds),
    returnAppointment: appointment
      ? {
          location: optionalString(appointment.location),
          scheduledAt: optionalString(appointment.scheduledAt)
        }
      : null,
    returnManifestSigning: returnManifestSigning
      ? {
          expiresAt: optionalString(returnManifestSigning.expiresAt),
          mock: returnManifestSigning.mock === true,
          provider: requiredString(returnManifestSigning.provider),
          signUrl: optionalString(returnManifestSigning.signUrl),
          taskId: requiredString(returnManifestSigning.taskId),
          taskStatus: requiredString(returnManifestSigning.taskStatus)
        }
      : null,
    returnThreeStageEnabled: aggregate.returnThreeStageEnabled === true,
    settlement: settlement
      ? {
          amountDueCents: integerString(settlement.amountDueCents),
          amountRefundableCents: integerString(settlement.amountRefundableCents),
          id: requiredString(settlement.id),
          pricingSettlementRevisionId: optionalString(
            settlement.pricingSettlementRevisionId
          ),
          resultHash: requiredString(settlement.resultHash),
          stage: requiredString(settlement.stage)
        }
      : null,
    signedReferences: records(aggregate.signedReferences).map((item) => ({
      documentType: requiredString(item.documentType),
      fileId: requiredString(item.fileId),
      stage: requiredString(item.stage)
    })),
    status: requiredString(aggregate.status)
  };
}

function buildChecklist(item: Record<string, unknown>): SubscriptionClosureChecklistView {
  return {
    attestationMode: requiredString(item.attestationMode),
    capturedAt: optionalString(item.capturedAt),
    id: requiredString(item.id),
    items: records(item.items).map((entry) => ({
      expectedQuantity: optionalNumber(entry.expectedQuantity),
      id: requiredString(entry.id),
      itemCode: requiredString(entry.itemCode),
      remark: optionalString(entry.remark),
      returnedQuantity: optionalNumber(entry.returnedQuantity),
      state: requiredString(entry.state)
    })),
    manifestHash: requiredString(item.manifestHash),
    revisionNumber: requiredNumber(item.revisionNumber)
  };
}

function buildDelta(item: Record<string, unknown>) {
  return {
    id: requiredString(item.id),
    items: records(item.items).map((entry) => ({
      decisionReason: requiredString(entry.decisionReason),
      id: requiredString(entry.id),
      itemCode: requiredString(entry.itemCode),
      quantityDifference: numeric(entry.quantityDifference),
      responsibility: requiredString(entry.responsibility),
      wearClassification: requiredString(entry.wearClassification)
    })),
    resultHash: requiredString(item.resultHash),
    revisionNumber: requiredNumber(item.revisionNumber)
  };
}

function buildEvidence(item: Record<string, unknown>): SubscriptionClosureEvidenceView {
  return {
    checklistItemId: optionalString(item.checklistItemId),
    damageId: optionalString(item.damageId),
    evidenceId: optionalString(item.evidenceId),
    evidencePurpose: requiredString(item.evidencePurpose),
    id: requiredString(item.id),
    legacyExternalReference: optionalString(item.legacyExternalReference),
    visibility: requiredString(item.visibility)
  };
}

function buildDispute(item: Record<string, unknown>) {
  const decision = item.decision ? requiredRecord(item.decision) : null;
  return {
    chargeLineId: requiredString(item.chargeLineId),
    customerReason: requiredString(item.customerReason),
    id: requiredString(item.id),
    status: decision ? requiredString(decision.decision) : requiredString(item.status)
  };
}

function buildApproval(item: Record<string, unknown>): SubscriptionClosureApprovalView {
  const snapshot = record(item.subjectSnapshot);
  return {
    amountCents: optionalString(snapshot.amountCents),
    approvalType: optionalString(snapshot.approvalType),
    billId: optionalString(snapshot.billId),
    checklistItemId: optionalString(snapshot.checklistItemId),
    checklistItemState: optionalString(snapshot.checklistItemState),
    checklistManifestHash: optionalString(snapshot.checklistManifestHash),
    checklistRevisionId: optionalString(snapshot.checklistRevisionId),
    clauseSnapshotId: optionalString(snapshot.clauseSnapshotId),
    decision: optionalString(item.decision),
    deltaItemId: optionalString(snapshot.deltaItemId),
    evidenceIds: stringArray(snapshot.evidenceIds),
    id: requiredString(item.id),
    manualBasis: optionalString(snapshot.manualBasis),
    manualUnitPriceCents: optionalString(snapshot.manualUnitPriceCents),
    requestedBy: optionalString(item.requestedBy) ?? "",
    settlementRevisionId: optionalString(snapshot.settlementRevisionId),
    status: requiredString(item.status),
    subjectField: optionalString(item.subjectField) ?? "",
    type: requiredString(item.exceptionType),
    version: optionalNumber(item.version) ?? 0
  };
}

function buildChargeLine(item: Record<string, unknown>): SubscriptionClosureChargeLineView {
  return {
    amountCents: integerString(item.amountCents),
    billId: optionalString(item.billId),
    chargeType: requiredString(item.chargeType),
    clauseSnapshotId: optionalString(item.clauseSnapshotId),
    deltaItemId: optionalString(item.deltaItemId),
    exceptionApprovalId: optionalString(item.exceptionApprovalId),
    id: requiredString(item.id),
    lineCode: requiredString(item.lineCode),
    quantity: decimalString(item.quantity),
    responsibility: requiredString(item.responsibility),
    settlementRevisionId: requiredString(item.settlementRevisionId),
    status: requiredString(item.status),
    unitPriceCents: integerString(item.unitPriceCents)
  };
}

function optionalLatestRecord(value: unknown) {
  return records(value).at(-1) ?? null;
}

function uniqueActions(actions: SubscriptionClosureActionView[]) {
  return [...new Map(actions.map((action) => [action.key, action])).values()];
}

function actionLabel(key: string) {
  return (
    {
      DECIDE_DISPUTE: "处理客户争议",
      PROPOSE_SETTLEMENT: "生成结算草案",
      RECORD_LEGAL_EVENT: "记录法催事件",
      RECORD_NO_RESPONSE: "记录客户未响应",
      RELEASE_INVENTORY: "释放车辆库存",
      SETTLE_FINANCIAL: "完成财务结算",
      TRANSFER_LEGAL_COLLECTION: "移交法催",
      CAPTURE_RETURN_CHECKLIST: "记录退车现场清单",
      COMPLETE_OPERATIONS: "完成订单运营闭环",
      CONFIRM_PHYSICAL_RECEIPT: "确认车辆已取回",
      EXPORT_EVIDENCE_PACKAGE: "导出证据包",
      FINALIZE_CONTRACT_PRICING: "按合同生成正式账单",
      GENERATE_CONDITION_DELTA: "生成交付/退回差异",
      PREVIEW_CONTRACT_PRICING: "预览合同计费",
      RECORD_RECEIVABLE_DISPOSITION: "登记未清账款归口",
      RECORD_RETURN_INSPECTION: "记录退回检查",
      UPLOAD_RETURN_EVIDENCE: "上传现场证据"
    } as Record<string, string>
  )[key] ?? key;
}

function actionPermission(key: string) {
  if (["CAPTURE_RETURN_CHECKLIST", "UPLOAD_RETURN_EVIDENCE"].includes(key)) {
    return "subscription_closure:prepare";
  }
  if (key === "CONFIRM_PHYSICAL_RECEIPT") return "subscription_closure:receive";
  if (["RECORD_RETURN_INSPECTION", "GENERATE_CONDITION_DELTA"].includes(key)) {
    return "subscription_closure:inspect";
  }
  if (
    [
      "COMPLETE_OPERATIONS",
      "DECIDE_DISPUTE",
      "EXPORT_EVIDENCE_PACKAGE",
      "FINALIZE_CONTRACT_PRICING",
      "PREVIEW_CONTRACT_PRICING",
      "PROPOSE_SETTLEMENT",
      "RECORD_LEGAL_EVENT",
      "RECORD_NO_RESPONSE",
      "RELEASE_INVENTORY",
      "SETTLE_FINANCIAL",
      "TRANSFER_LEGAL_COLLECTION",
      "RECORD_RECEIVABLE_DISPOSITION"
    ].includes(key)
  ) {
    return "subscription_closure:settle";
  }
  return null;
}

function recoveryActions(status: string, permissions: ReadonlySet<string>) {
  const result: SubscriptionClosureActionView[] = [];
  if (permissions.has("subscription_recovery:assess") && status === "RECOVERY_ASSESSMENT_PENDING") {
    result.push({ key: "ASSESS_RECOVERY", label: "记录追回评估" });
  }
  if (
    permissions.has("subscription_recovery:approve") &&
    ["RECOVERY_ASSESSMENT_PENDING", "RECOVERY_APPROVAL_PENDING"].includes(status)
  ) {
    result.push({ key: "APPROVE_RECOVERY", label: "审批追回执行" });
  }
  if (permissions.has("subscription_recovery:execute") && status === "RECOVERY_APPROVED") {
    result.push({ key: "EXECUTE_RECOVERY", label: "执行已批准追回" });
  }
  return result;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredRecord(value: unknown) {
  const result = record(value);
  if (Object.keys(result).length === 0) invalid();
  return result;
}

function records(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map(requiredRecord);
}

function requiredString(value: unknown) {
  if (typeof value !== "string" || value.length === 0) invalid();
  return value;
}

function optionalString(value: unknown) {
  if (value === null || value === undefined) return null;
  return requiredString(value);
}

function requiredNumber(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid();
  return value;
}

function optionalNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  return requiredNumber(value);
}

function numeric(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  invalid();
}

function decimalString(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)) return value;
  invalid();
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function integerString(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return value;
  invalid();
}

function invalid(): never {
  throw new TypeError("Invalid subscription closure projection");
}
