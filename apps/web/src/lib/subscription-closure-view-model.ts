export interface SubscriptionClosureActionView {
  key: "ASSESS_RECOVERY" | "APPROVE_RECOVERY" | "EXECUTE_RECOVERY";
  label: string;
}

export interface AdminSubscriptionClosureView {
  allowedActions: SubscriptionClosureActionView[];
  approvals: Array<{ id: string; status: string; type: string }>;
  auditLinks: Array<{ action: string; createdAt: string | null; entityType: string; id: string }>;
  caseNo: string;
  closureType: string;
  finalDisposition: string | null;
  physicalControlMode: string | null;
  restrictions: Array<{ id: string; status: string; type: string }>;
  settlementRevisions: Array<{
    amountDueCents: string;
    amountRefundableCents: string;
    id: string;
    revisionNumber: number;
    stage: string;
  }>;
  status: string;
  timeline: Array<{ id: string; occurredAt: string | null; type: string }>;
  workOrders: Array<{ id: string; number: string | null; status: string; type: string }>;
}

export interface CustomerSubscriptionClosureView {
  caseNo: string;
  closureType: string;
  evidenceReferences: Array<{ evidenceType: string; fileId: string; id: string }>;
  nextAction: string;
  returnAppointment: { location: string | null; scheduledAt: string | null } | null;
  settlement: {
    amountDueCents: string;
    amountRefundableCents: string;
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

  return {
    allowedActions: recoveryActions(status, permissions),
    approvals: records(aggregate.approvals).map((item) => ({
      id: requiredString(item.id),
      status: requiredString(item.status),
      type: requiredString(item.exceptionType)
    })),
    auditLinks: records(aggregate.audits).map((item) => ({
      action: requiredString(item.action),
      createdAt: optionalString(item.createdAt),
      entityType: requiredString(item.entityType),
      id: requiredString(item.id)
    })),
    caseNo,
    closureType,
    finalDisposition: optionalString(closureCase.finalDisposition),
    physicalControlMode: optionalString(closureCase.physicalControlMode),
    restrictions,
    settlementRevisions: records(aggregate.settlementRevisions).map((item) => ({
      amountDueCents: integerString(item.amountDueCents),
      amountRefundableCents: integerString(item.amountRefundableCents),
      id: requiredString(item.id),
      revisionNumber: requiredNumber(item.revisionNumber),
      stage: requiredString(item.stage)
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
  return {
    caseNo: requiredString(aggregate.caseNo),
    closureType: requiredString(aggregate.closureType),
    evidenceReferences: records(aggregate.evidenceReferences).map((item) => ({
      evidenceType: requiredString(item.evidenceType),
      fileId: requiredString(item.fileId),
      id: requiredString(item.id)
    })),
    nextAction: requiredString(aggregate.nextAction),
    returnAppointment: appointment
      ? {
          location: optionalString(appointment.location),
          scheduledAt: optionalString(appointment.scheduledAt)
        }
      : null,
    settlement: settlement
      ? {
          amountDueCents: integerString(settlement.amountDueCents),
          amountRefundableCents: integerString(settlement.amountRefundableCents),
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

function integerString(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return value;
  invalid();
}

function invalid(): never {
  throw new TypeError("Invalid subscription closure projection");
}
