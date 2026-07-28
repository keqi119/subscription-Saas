import { describe, expect, it } from "vitest";

import { buildAdminContractsListPath } from "../src/lib/admin-contracts";

describe("admin contract list paths", () => {
  it("omits empty filters", () => {
    expect(buildAdminContractsListPath({})).toBe("/contracts");
  });

  it("adds one trimmed contract-number filter", () => {
    expect(buildAdminContractsListPath({ contractNo: "  CON 2026  " })).toBe(
      "/contracts?contractNo=CON+2026"
    );
  });

  it("adds both independent filters", () => {
    expect(buildAdminContractsListPath({ contractNo: "CON-1", orderNo: "ORD-2" })).toBe(
      "/contracts?contractNo=CON-1&orderNo=ORD-2"
    );
  });

  it("encodes Unicode filter values", () => {
    expect(buildAdminContractsListPath({ contractNo: "合同 一号", orderNo: "订单/2" })).toBe(
      "/contracts?contractNo=%E5%90%88%E5%90%8C+%E4%B8%80%E5%8F%B7&orderNo=%E8%AE%A2%E5%8D%95%2F2"
    );
  });

  it("restores the unfiltered list after both filters are cleared", () => {
    expect(buildAdminContractsListPath({ contractNo: "", orderNo: "   " })).toBe("/contracts");
  });
});
