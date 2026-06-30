import { createHash } from "node:crypto";

export function hashSigningPlanPayload(value: unknown) {
  const canonical = canonicalJson(value);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonical(value));
}

function toCanonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(toCanonical);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, toCanonical(item)])
    );
  }
  return value;
}
