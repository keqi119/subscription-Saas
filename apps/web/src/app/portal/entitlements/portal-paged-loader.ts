import type {
  PortalEntitlementGrant,
  PortalEntitlementUsage,
  PortalPagedResponse
} from "../../../lib/portal-types";

export type PortalPageFetcher = <T>(path: string) => Promise<PortalPagedResponse<T>>;

export function portalPagedPath(basePath: string, page: number, pageSize: number): string {
  const questionMarkIndex = basePath.indexOf("?");
  const pathname = questionMarkIndex === -1 ? basePath : basePath.slice(0, questionMarkIndex);
  const query = questionMarkIndex === -1 ? "" : basePath.slice(questionMarkIndex + 1);
  const searchParams = new URLSearchParams(query);

  searchParams.set("page", String(page));
  searchParams.set("pageSize", String(pageSize));

  return `${pathname}?${searchParams.toString()}`;
}

export async function fetchAllPortalPages<T>(
  basePath: string,
  fetchPage: PortalPageFetcher,
  pageSize = 100
): Promise<T[]> {
  const rows: T[] = [];
  let page = 1;
  let total: number | null = null;

  do {
    const response = await fetchPage<T>(portalPagedPath(basePath, page, pageSize));
    total ??= response.total;

    if (response.items.length === 0 && rows.length < total) {
      throw new Error("PORTAL_PAGINATION_INCOMPLETE");
    }

    rows.push(...response.items);
    page += 1;
  } while (rows.length < (total ?? 0));

  return rows;
}

export interface PortalEntitlementPageData {
  grants: PortalEntitlementGrant[];
  usages: PortalEntitlementUsage[];
}

export async function loadPortalEntitlementPageData(
  orderId: string | null,
  fetchPage: PortalPageFetcher
): Promise<PortalEntitlementPageData> {
  const filter = orderId ? `?${new URLSearchParams({ orderId }).toString()}` : "";
  const [grants, usages] = await Promise.all([
    fetchAllPortalPages<PortalEntitlementGrant>(`/portal/entitlements${filter}`, fetchPage),
    fetchAllPortalPages<PortalEntitlementUsage>(`/portal/entitlements/usages${filter}`, fetchPage)
  ]);

  return { grants, usages };
}
