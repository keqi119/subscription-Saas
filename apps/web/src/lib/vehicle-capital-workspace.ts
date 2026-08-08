export const VEHICLE_CAPITAL_SECTIONS = [
  { key: "overview", label: "资本总览" },
  { key: "events", label: "资本事件" },
  { key: "allocations", label: "融资分摊" },
  { key: "revenue-rules", label: "分润规则" },
  { key: "revenue-preview", label: "分润试算" }
] as const;

export type VehicleCapitalSectionKey = (typeof VEHICLE_CAPITAL_SECTIONS)[number]["key"];

export type VehicleCapitalEventType =
  | "INITIAL_EQUITY_PURCHASE"
  | "ADD_DEBT_FINANCING"
  | "REFINANCE"
  | "EARLY_SETTLEMENT"
  | "FINANCING_RELEASE"
  | "LEASE_IN"
  | "LEASE_TERMINATION"
  | "MANAGED_IN"
  | "MANAGED_TERMINATION"
  | "OTHER";

export interface VehicleCapitalEventFieldVisibility {
  showAcquisitionMode: boolean;
  showDebtAmount: boolean;
  showEquityAmount: boolean;
  showFinancingInstrument: boolean;
  showLessor: boolean;
  showManagedOwner: boolean;
}

export interface VehicleCapitalEventDraft {
  acquisitionMode?: string | null;
  debtPrincipalAmount?: number | null;
  effectiveFrom: string;
  effectiveTo?: string | null;
  equityCapitalAmount?: number | null;
  eventType: VehicleCapitalEventType;
  externalOwnerName?: string | null;
  financingInstrumentId?: string | null;
  lessorName?: string | null;
  managedOwnerName?: string | null;
  remark?: string | null;
}

export interface VehicleFinancingAllocationView {
  allocatedPrincipalAmount: number;
  allocationRatioBps?: number | null;
  id: string;
}

export interface VehicleFinancingAllocationSummary {
  allocatedPrincipalAmount: number | null;
  allocationCount: number;
  allocationRatioBps: number | null;
}

export interface VehicleCapitalWorkspaceActionState {
  canManageCapitalEvents: boolean;
  canManageRevenueShareRules: boolean;
  canPreviewRevenueShare: boolean;
  canViewCapitalStructure: boolean;
  canViewRevenueShareRules: boolean;
}

const debtFinancingEventTypes = new Set<VehicleCapitalEventType>([
  "ADD_DEBT_FINANCING",
  "REFINANCE"
]);
const financingReleaseEventTypes = new Set<VehicleCapitalEventType>([
  "EARLY_SETTLEMENT",
  "FINANCING_RELEASE"
]);
const leaseEventTypes = new Set<VehicleCapitalEventType>(["LEASE_IN", "LEASE_TERMINATION"]);
const managedEventTypes = new Set<VehicleCapitalEventType>([
  "MANAGED_IN",
  "MANAGED_TERMINATION"
]);

export function capitalEventFieldVisibility(
  eventType: VehicleCapitalEventType
): VehicleCapitalEventFieldVisibility {
  const isInitial = eventType === "INITIAL_EQUITY_PURCHASE";
  const isDebtFinancing = debtFinancingEventTypes.has(eventType);
  const isFinancingRelease = financingReleaseEventTypes.has(eventType);
  const isLease = leaseEventTypes.has(eventType);
  const isManaged = managedEventTypes.has(eventType);
  const isOther = eventType === "OTHER";

  return {
    showAcquisitionMode: isInitial || isLease || isManaged || isOther,
    showDebtAmount: isDebtFinancing || isOther,
    showEquityAmount: isInitial || isOther,
    showFinancingInstrument: isDebtFinancing || isFinancingRelease || isOther,
    showLessor: isLease,
    showManagedOwner: isManaged
  };
}

export function normalizeCapitalEventDraft(
  draft: VehicleCapitalEventDraft
): VehicleCapitalEventDraft {
  const fields = capitalEventFieldVisibility(draft.eventType);

  return {
    acquisitionMode: fields.showAcquisitionMode ? draft.acquisitionMode : null,
    debtPrincipalAmount: fields.showDebtAmount ? draft.debtPrincipalAmount : null,
    effectiveFrom: draft.effectiveFrom,
    effectiveTo: draft.effectiveTo ?? null,
    equityCapitalAmount: fields.showEquityAmount ? draft.equityCapitalAmount : null,
    eventType: draft.eventType,
    externalOwnerName: fields.showManagedOwner ? draft.externalOwnerName : null,
    financingInstrumentId: fields.showFinancingInstrument ? draft.financingInstrumentId : null,
    lessorName: fields.showLessor ? draft.lessorName : null,
    managedOwnerName: fields.showManagedOwner ? draft.managedOwnerName : null,
    remark: draft.remark
  };
}

export function summarizeFinancingAllocations(
  allocations: readonly VehicleFinancingAllocationView[]
): VehicleFinancingAllocationSummary {
  if (allocations.length === 0) {
    return {
      allocatedPrincipalAmount: null,
      allocationCount: 0,
      allocationRatioBps: null
    };
  }

  return {
    allocatedPrincipalAmount: allocations.reduce(
      (total, allocation) => total + allocation.allocatedPrincipalAmount,
      0
    ),
    allocationCount: allocations.length,
    allocationRatioBps: allocations.every(
      (allocation) => typeof allocation.allocationRatioBps === "number"
    )
      ? allocations.reduce((total, allocation) => total + (allocation.allocationRatioBps ?? 0), 0)
      : null
  };
}

export function getCapitalWorkspaceActions(
  permissions: ReadonlySet<string>
): VehicleCapitalWorkspaceActionState {
  return {
    canManageCapitalEvents: permissions.has("capital_structure:manage"),
    canManageRevenueShareRules: permissions.has("revenue_share:manage"),
    canPreviewRevenueShare:
      permissions.has("revenue_share:view") || permissions.has("report:asset"),
    canViewCapitalStructure:
      permissions.has("capital_structure:view") ||
      permissions.has("vehicle:view") ||
      permissions.has("report:asset"),
    canViewRevenueShareRules:
      permissions.has("revenue_share:view") || permissions.has("vehicle:view")
  };
}
