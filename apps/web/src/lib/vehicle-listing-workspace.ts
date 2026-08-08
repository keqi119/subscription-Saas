export const VEHICLE_LISTING_SECTIONS = [
  { key: "overview", label: "发布总览" },
  { key: "copy", label: "展示内容" },
  { key: "source-media", label: "原件引用" },
  { key: "plans", label: "订阅方案" },
  { key: "condition-report", label: "车况报告" }
] as const;

export type VehicleListingSectionKey = (typeof VEHICLE_LISTING_SECTIONS)[number]["key"];
export type VehicleListingSourceSection = "CONFIGURATION_SHEET" | "CONDITION_REPORT";
export type PortalConditionPresentation = "SOURCE_DOCUMENT" | "STRUCTURED_REPORT" | "NONE";

export const VEHICLE_LISTING_SOURCE_SECTION_LABELS: Record<VehicleListingSourceSection, string> = {
  CONFIGURATION_SHEET: "车辆配置单原件",
  CONDITION_REPORT: "车辆检测报告原件"
};

export interface VehicleListingSourceDocumentView {
  createdAt?: string | null;
  deletedAt?: string | null;
  documentStatus: string;
  documentType: string;
  fileName: string;
  id: string;
  mimeType?: string | null;
  previewUrl: string;
  versionNo?: number | null;
}

export interface VehicleListingSourceBindingView {
  document: Omit<VehicleListingSourceDocumentView, "deletedAt" | "documentStatus">;
  id: string;
  section: VehicleListingSourceSection;
  vehicleId: string;
}

export interface VehicleListingWorkspaceInput {
  bindings: VehicleListingSourceBindingView[];
  media: Array<{
    customerVisible: boolean;
    isCover: boolean;
  }>;
  plans: Array<{
    visible: boolean;
  }>;
  profile: {
    displayName?: string | null;
    listingStatus?: string | null;
    portalVisible?: boolean;
    shortTitle?: string | null;
  } | null;
}

export interface VehicleListingReadiness {
  listingComplete: boolean;
  missingRequirements: string[];
  sourceBindings: {
    conditionReport: VehicleListingSourceBindingView | null;
    configurationSheet: VehicleListingSourceBindingView | null;
  };
  warnings: string[];
}

const SOURCE_DOCUMENT_TYPE_BY_SECTION: Record<VehicleListingSourceSection, string> = {
  CONFIGURATION_SHEET: "VEHICLE_CONFIGURATION_SHEET",
  CONDITION_REPORT: "VEHICLE_INSPECTION_REPORT"
};

const SUPPORTED_SOURCE_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp"
]);

export function getVehicleListingReadiness(
  input: VehicleListingWorkspaceInput
): VehicleListingReadiness {
  const sourceBindings = {
    conditionReport:
      input.bindings.find((binding) => binding.section === "CONDITION_REPORT") ?? null,
    configurationSheet:
      input.bindings.find((binding) => binding.section === "CONFIGURATION_SHEET") ?? null
  };
  const missingRequirements: string[] = [];
  const title = input.profile?.displayName?.trim() || input.profile?.shortTitle?.trim();

  if (!title) {
    missingRequirements.push("缺少商品展示标题");
  }
  if (!input.media.some((media) => media.customerVisible && media.isCover)) {
    missingRequirements.push("缺少客户可见封面图");
  }
  if (!input.plans.some((plan) => plan.visible)) {
    missingRequirements.push("缺少客户可见订阅方案");
  }

  const warnings: string[] = [];
  if (!sourceBindings.configurationSheet) {
    warnings.push("未引用车辆配置单原件");
  }
  if (!sourceBindings.conditionReport) {
    warnings.push("未引用车辆检测报告原件");
  }

  return {
    listingComplete: missingRequirements.length === 0,
    missingRequirements,
    sourceBindings,
    warnings
  };
}

export function getEligibleSourceDocuments(
  section: VehicleListingSourceSection,
  documents: readonly VehicleListingSourceDocumentView[]
) {
  const expectedType = SOURCE_DOCUMENT_TYPE_BY_SECTION[section];
  return documents
    .filter(
      (document) =>
        document.documentType === expectedType &&
        document.documentStatus === "ACTIVE" &&
        !document.deletedAt &&
        Boolean(document.mimeType && SUPPORTED_SOURCE_IMAGE_MIME_TYPES.has(document.mimeType))
    )
    .sort((left, right) => {
      const versionDifference = (right.versionNo ?? 0) - (left.versionNo ?? 0);
      if (versionDifference !== 0) {
        return versionDifference;
      }
      return timestamp(right.createdAt) - timestamp(left.createdAt);
    });
}

export function getSourceBindingPresentation(binding: VehicleListingSourceBindingView) {
  return {
    autoUpdates: false,
    fileName: binding.document.fileName,
    previewUrl: binding.document.previewUrl,
    sectionLabel: VEHICLE_LISTING_SOURCE_SECTION_LABELS[binding.section],
    uploadedAt: binding.document.createdAt ?? null,
    versionLabel:
      typeof binding.document.versionNo === "number"
        ? `V${binding.document.versionNo}`
        : "历史资料"
  };
}

export function getPortalConditionPresentation(input: {
  binding: VehicleListingSourceBindingView | null;
  latestPublishedReport: { id: string } | null;
}): PortalConditionPresentation {
  if (input.binding?.section === "CONDITION_REPORT") {
    return "SOURCE_DOCUMENT";
  }
  if (input.latestPublishedReport) {
    return "STRUCTURED_REPORT";
  }
  return "NONE";
}

function timestamp(value?: string | null) {
  if (!value) {
    return 0;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}
