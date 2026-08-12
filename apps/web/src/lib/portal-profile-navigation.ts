export type PortalProfileTab = "basic" | "materials";

const PORTAL_PROFILE_PATHS: Record<PortalProfileTab, string> = {
  basic: "/portal/me",
  materials: "/portal/materials"
};

export function normalizePortalRedirect(value: string | null | undefined): string | null {
  if (!value || value.startsWith("//")) return null;
  if (value === "/portal" || value.startsWith("/portal/")) return value;
  return null;
}

export function buildPortalProfileHref(
  tab: PortalProfileTab,
  redirect?: string | null
): string {
  const path = PORTAL_PROFILE_PATHS[tab];
  const safeRedirect = normalizePortalRedirect(redirect);
  return safeRedirect ? `${path}?redirect=${encodeURIComponent(safeRedirect)}` : path;
}
