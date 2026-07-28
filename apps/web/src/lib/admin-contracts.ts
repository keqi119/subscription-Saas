export interface AdminContractsListQuery {
  contractNo?: string;
  orderNo?: string;
}

export function buildAdminContractsListPath(query: AdminContractsListQuery) {
  const params = new URLSearchParams();
  const contractNo = query.contractNo?.trim();
  const orderNo = query.orderNo?.trim();

  if (contractNo) {
    params.set("contractNo", contractNo);
  }
  if (orderNo) {
    params.set("orderNo", orderNo);
  }

  const search = params.toString();
  return search ? `/contracts?${search}` : "/contracts";
}
