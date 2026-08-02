export type MileageReviewStatus =
  | "SCHEDULED"
  | "PENDING_SUBMISSION"
  | "PENDING_REVIEW"
  | "RETURNED"
  | "CONFIRMED"
  | "VOIDED";

export interface MileageReviewEvidenceView {
  capturedAt?: string | null;
  createdAt?: string | null;
  downloadUrl: string;
  id: string;
  mimeType?: string | null;
  originalName: string;
  previewUrl?: string | null;
  sizeBytes?: string | null;
  submissionSource?: "ADMIN" | "PORTAL" | null;
}

export interface MileageReviewView {
  allowanceKm: number | null;
  baselineMileageKm: number;
  calculationSnapshot?: unknown;
  consumedAllowanceKm: number | null;
  cycleNo: number;
  dueAt: string;
  entitlementGrantId?: string | null;
  entitlementUsageId?: string | null;
  evidence: MileageReviewEvidenceView[];
  id: string;
  lockVersion: number;
  mileageReadingId?: string | null;
  order: {
    id: string;
    orderNo: string;
    orderStatus: string;
  };
  overMileageAmount: number | string | null;
  overMileageBill?: {
    billNo?: string | null;
    billStatus?: string | null;
    id: string;
  } | null;
  overMileageBillId: string | null;
  overMileageFeeAmount?: number | string | null;
  overMileageKm: number | null;
  periodEnd: string;
  periodStart: string;
  readingAt: string | null;
  reviewNote?: string | null;
  reviewedAt?: string | null;
  reviewedBy?: string | null;
  scheduledReviewAt: string;
  status: MileageReviewStatus;
  submissionSource?: "ADMIN" | "PORTAL" | null;
  submittedAt?: string | null;
  submittedByCustomerId?: string | null;
  submittedByUserId?: string | null;
  submittedMileageKm: number | null;
  vehicle: {
    brand?: string | null;
    id: string;
    model?: string | null;
    plateNo?: string | null;
    vehicleNo?: string | null;
    vin?: string | null;
  };
  version: number;
  voidReason?: string | null;
  voidedAt?: string | null;
}

export interface MileageReviewPage {
  items: MileageReviewView[];
  page: number;
  pageSize: number;
  total: number;
}

const STATUS_PRESENTATION: Record<
  MileageReviewStatus,
  { color: string; label: string }
> = {
  CONFIRMED: { color: "green", label: "已确认" },
  PENDING_REVIEW: { color: "blue", label: "待后台复核" },
  PENDING_SUBMISSION: { color: "orange", label: "待提交" },
  RETURNED: { color: "gold", label: "已退回补充" },
  SCHEDULED: { color: "default", label: "未到复核日" },
  VOIDED: { color: "default", label: "已作废" }
};

export function getMileageReviewPresentation(
  status: MileageReviewStatus,
  overdue: boolean
) {
  if (status === "PENDING_SUBMISSION" && overdue) {
    return { color: "red", label: "逾期待提交" };
  }
  return STATUS_PRESENTATION[status];
}

export function isMileageReviewOverdue(
  review: Pick<MileageReviewView, "dueAt" | "status">,
  asOf = new Date()
) {
  return (
    review.status === "PENDING_SUBMISSION" &&
    validTimestamp(review.dueAt) < asOf.getTime()
  );
}

export function sortMileageReviewQueue<T extends MileageReviewView>(
  reviews: readonly T[],
  asOf = new Date()
) {
  return [...reviews].sort((left, right) => {
    const overdueDelta =
      Number(isMileageReviewOverdue(right, asOf)) -
      Number(isMileageReviewOverdue(left, asOf));
    if (overdueDelta !== 0) {
      return overdueDelta;
    }
    return (
      validTimestamp(left.scheduledReviewAt) -
        validTimestamp(right.scheduledReviewAt) ||
      left.id.localeCompare(right.id)
    );
  });
}

export function getMileageReviewActions(
  review: Pick<MileageReviewView, "order" | "status">,
  role: "ADMIN" | "PORTAL"
) {
  const finalOrder = review.order.orderStatus !== "ACTIVE";
  const editable =
    !finalOrder &&
    (review.status === "PENDING_SUBMISSION" || review.status === "RETURNED");
  return {
    canConfirm: role === "ADMIN" && review.status === "PENDING_REVIEW",
    canEdit: editable,
    canReturn: role === "ADMIN" && review.status === "PENDING_REVIEW",
    canSubmit: editable,
    canVoid: role === "ADMIN" && review.status === "CONFIRMED"
  };
}

export function validateMileageReviewSubmission(input: {
  baselineMileageKm: number;
  evidenceCount: number;
  readingAt: string | null | undefined;
  submittedMileageKm: number | null | undefined;
}) {
  const errors: string[] = [];
  if (
    input.submittedMileageKm === null ||
    input.submittedMileageKm === undefined ||
    !Number.isSafeInteger(input.submittedMileageKm)
  ) {
    errors.push("请填写有效的累计里程");
  } else if (input.submittedMileageKm < input.baselineMileageKm) {
    errors.push("累计里程不能低于本周期基线");
  }
  if (!input.readingAt || !Number.isFinite(Date.parse(input.readingAt))) {
    errors.push("请填写里程读取时间");
  }
  if (input.evidenceCount < 1) {
    errors.push("请至少上传一张清晰的仪表盘照片");
  }
  return errors;
}

export function buildMileageReviewSettlementView(
  review: Pick<
    MileageReviewView,
    | "allowanceKm"
    | "baselineMileageKm"
    | "consumedAllowanceKm"
    | "overMileageAmount"
    | "overMileageBillId"
    | "overMileageKm"
    | "submittedMileageKm"
  >
) {
  return {
    actualUsageKm:
      review.submittedMileageKm === null
        ? null
        : Math.max(0, review.submittedMileageKm - review.baselineMileageKm),
    allowanceKm: review.allowanceKm,
    consumedAllowanceKm: review.consumedAllowanceKm,
    overMileageAmount: toSafeNumber(review.overMileageAmount),
    overMileageBillHref: review.overMileageBillId
      ? `/portal/bills/${encodeURIComponent(review.overMileageBillId)}`
      : null,
    overMileageKm: review.overMileageKm
  };
}

export function getPortalMileageReviewGuidance(review: MileageReviewView) {
  const actions = getMileageReviewActions(review, "PORTAL");
  if (actions.canEdit) {
    return {
      actionLabel:
        review.status === "RETURNED" ? "补充并重新提交" : "提交本月里程",
      href: `/portal/mileage-reviews/${encodeURIComponent(review.id)}`,
      kind: "ACTION" as const,
      readOnly: false
    };
  }
  if (review.status === "PENDING_REVIEW" || review.status === "SCHEDULED") {
    return {
      actionLabel: "查看进度",
      href: `/portal/mileage-reviews/${encodeURIComponent(review.id)}`,
      kind: "WAITING" as const,
      readOnly: true
    };
  }
  return {
    actionLabel: "查看复核记录",
    href: `/portal/mileage-reviews/${encodeURIComponent(review.id)}`,
    kind: "HISTORY" as const,
    readOnly: true
  };
}

function validTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
}

function toSafeNumber(value: number | string | null) {
  if (value === null) {
    return null;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}
