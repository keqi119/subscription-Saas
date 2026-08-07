export const VEHICLE_WORKSPACE_TAB_KEYS = [
  "overview",
  "documents",
  "insurance-battery",
  "listing",
  "valuation",
  "capital"
] as const;

export const VEHICLE_LISTING_SECTION_KEYS = [
  "overview",
  "copy",
  "source-media",
  "plans",
  "condition-report"
] as const;

export const VEHICLE_VALUATION_SECTION_KEYS = [
  "overview",
  "residual",
  "reviews",
  "sale-price-history",
  "depreciation"
] as const;

export const VEHICLE_CAPITAL_SECTION_KEYS = [
  "overview",
  "events",
  "allocations",
  "revenue-rules",
  "revenue-preview"
] as const;

export type VehicleWorkspaceTabKey = (typeof VEHICLE_WORKSPACE_TAB_KEYS)[number];
export type VehicleListingSectionKey = (typeof VEHICLE_LISTING_SECTION_KEYS)[number];
export type VehicleValuationSectionKey = (typeof VEHICLE_VALUATION_SECTION_KEYS)[number];
export type VehicleCapitalSectionKey = (typeof VEHICLE_CAPITAL_SECTION_KEYS)[number];

export interface VehicleWorkspaceLocation {
  section?: VehicleListingSectionKey | VehicleValuationSectionKey | VehicleCapitalSectionKey;
  tab: VehicleWorkspaceTabKey;
}

const VEHICLE_WORKSPACE_TAB_KEY_SET = new Set<string>(VEHICLE_WORKSPACE_TAB_KEYS);
const VEHICLE_LISTING_SECTION_KEY_SET = new Set<string>(VEHICLE_LISTING_SECTION_KEYS);
const VEHICLE_VALUATION_SECTION_KEY_SET = new Set<string>(VEHICLE_VALUATION_SECTION_KEYS);
const VEHICLE_CAPITAL_SECTION_KEY_SET = new Set<string>(VEHICLE_CAPITAL_SECTION_KEYS);

const VEHICLE_WORKSPACE_TAB_VIEW_PERMISSIONS = {
  capital: [
    "capital_structure:view",
    "financing:view",
    "vehicle_asset_pool:view",
    "revenue_right:view",
    "revenue_share:view"
  ],
  documents: ["vehicle_document:view"],
  "insurance-battery": ["vehicle_insurance:view", "vehicle_baas:view"],
  valuation: [
    "residual_forecast:view",
    "vehicle_valuation_review:view",
    "vehicle:history_view",
    "vehicle_depreciation:view"
  ]
} as const satisfies Record<
  Exclude<VehicleWorkspaceTabKey, "overview" | "listing">,
  readonly string[]
>;

export function getVisibleVehicleWorkspaceTabs(
  permissions: Iterable<string>
): VehicleWorkspaceTabKey[] {
  const permissionSet = permissions instanceof Set ? permissions : new Set(permissions);
  if (!permissionSet.has("vehicle:view")) {
    return [];
  }

  return VEHICLE_WORKSPACE_TAB_KEYS.filter((tab) => {
    if (tab === "overview" || tab === "listing") {
      return true;
    }
    return VEHICLE_WORKSPACE_TAB_VIEW_PERMISSIONS[tab].some((permission) =>
      permissionSet.has(permission)
    );
  });
}

export function parseVehicleWorkspaceLocation(
  searchParams: URLSearchParams,
  visibleTabs: readonly VehicleWorkspaceTabKey[]
): VehicleWorkspaceLocation {
  const firstVisibleTab = visibleTabs[0];
  if (!firstVisibleTab) {
    throw new Error("vehicle workspace has no visible tabs");
  }

  const requestedTab = searchParams.get("tab");
  const tab =
    isVehicleWorkspaceTabKey(requestedTab) && visibleTabs.includes(requestedTab)
      ? requestedTab
      : firstVisibleTab;
  const section = validNonDefaultSection(tab, searchParams.get("section"));
  return section ? { section, tab } : { tab };
}

export function buildVehicleWorkspaceHref(input: {
  section?: string;
  tab: VehicleWorkspaceTabKey;
  vehicleId: string;
}): string {
  const searchParams = new URLSearchParams({ tab: input.tab });
  const section = validNonDefaultSection(input.tab, input.section);
  if (section) {
    searchParams.set("section", section);
  }
  return `/vehicles/${encodeURIComponent(input.vehicleId)}?${searchParams.toString()}`;
}

export function isVehicleWorkspaceTabKey(value: string | null | undefined): value is VehicleWorkspaceTabKey {
  return Boolean(value && VEHICLE_WORKSPACE_TAB_KEY_SET.has(value));
}

export function isVehicleListingSectionKey(
  value: string | null | undefined
): value is VehicleListingSectionKey {
  return Boolean(value && VEHICLE_LISTING_SECTION_KEY_SET.has(value));
}

export function isVehicleValuationSectionKey(
  value: string | null | undefined
): value is VehicleValuationSectionKey {
  return Boolean(value && VEHICLE_VALUATION_SECTION_KEY_SET.has(value));
}

export function isVehicleCapitalSectionKey(
  value: string | null | undefined
): value is VehicleCapitalSectionKey {
  return Boolean(value && VEHICLE_CAPITAL_SECTION_KEY_SET.has(value));
}

function validNonDefaultSection(
  tab: VehicleWorkspaceTabKey,
  section: string | null | undefined
): VehicleWorkspaceLocation["section"] {
  if (!section || section === "overview") {
    return undefined;
  }
  if (tab === "listing" && isVehicleListingSectionKey(section)) {
    return section;
  }
  if (tab === "valuation" && isVehicleValuationSectionKey(section)) {
    return section;
  }
  if (tab === "capital" && isVehicleCapitalSectionKey(section)) {
    return section;
  }
  return undefined;
}
