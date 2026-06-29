import { createHash } from "node:crypto";

const FADADA_PERSON_OPEN_ID_NAMESPACE = "subauto:fadada:personal-provider-open-id:v1";

export function createFadadaProviderOpenId(customerId: string) {
  const normalized = customerId.trim();
  if (!normalized) {
    throw new Error("FADADA_PROVIDER_OPEN_ID_CUSTOMER_ID_MISSING");
  }

  const digest = createHash("sha256")
    .update(`${FADADA_PERSON_OPEN_ID_NAMESPACE}:${normalized}`, "utf8")
    .digest("hex")
    .slice(0, 24);

  return `subauto_person_v1_${digest}`;
}
