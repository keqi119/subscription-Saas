import { describe, expect, it } from "vitest";

import { calculateWriteOffAmount } from "../src/finance/finance.service";

describe("payment settlement allocation", () => {
  it("allocates no more than the bill or payment remainder", () => {
    expect(calculateWriteOffAmount(100n, 60n, 80n)).toBe(60n);
    expect(calculateWriteOffAmount(100n, 120n, 80n)).toBe(80n);
  });

  it("preserves a later receipt as unallocated when the bill is settled", () => {
    expect(calculateWriteOffAmount(100n, 0n, 100n)).toBe(0n);
  });

  it("rejects negative ledger amounts", () => {
    expect(() => calculateWriteOffAmount(100n, -1n, 100n)).toThrow(
      "Settlement amounts cannot be negative."
    );
  });
});
