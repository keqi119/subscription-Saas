export function yuanToCents(yuan: number): bigint {
  return BigInt(Math.round(yuan * 100));
}

export function centsToYuan(cents: bigint | number): string {
  const value = typeof cents === "bigint" ? Number(cents) : cents;
  return (value / 100).toFixed(2);
}
