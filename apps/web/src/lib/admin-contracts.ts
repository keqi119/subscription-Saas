export interface AdminContractsListQuery {
  contractNo?: string;
  orderNo?: string;
}

export interface AdminContractsRequest<T> {
  load: () => Promise<T>;
  setError: (error: unknown) => void;
  setLoading: (loading: boolean) => void;
  setRows: (rows: T) => void;
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

export function createAdminContractsRequestController() {
  let latestRequestId = 0;

  return {
    async load<T>({ load, setError, setLoading, setRows }: AdminContractsRequest<T>) {
      const requestId = latestRequestId + 1;
      latestRequestId = requestId;
      setLoading(true);

      try {
        const rows = await load();
        if (latestRequestId === requestId) {
          setRows(rows);
        }
      } catch (error) {
        if (latestRequestId === requestId) {
          setError(error);
        }
      } finally {
        if (latestRequestId === requestId) {
          setLoading(false);
        }
      }
    }
  };
}
