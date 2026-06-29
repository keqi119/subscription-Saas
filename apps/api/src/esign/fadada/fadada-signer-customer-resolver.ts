import { FadadaConfig } from "./fadada.types";

export const FADADA_SIGNER_CUSTOMER_ID_MISSING = "FADADA_SIGNER_CUSTOMER_ID_MISSING";
export const FADADA_TEST_CUSTOMER_ID_MISMATCH = "FADADA_TEST_CUSTOMER_ID_MISMATCH";

export interface ResolveFadadaSignerCustomerIdInput {
  config: FadadaConfig;
  contractId?: string;
  localCustomerId?: string;
  mode: "FULL_SIGNING_SMOKE" | "NORMAL";
  orderId?: string;
}

export interface ResolvedFadadaSignerCustomerId {
  providerCustomerId: string;
  source: "ENV_TEST_SIGNER";
}

export function resolveFadadaSignerCustomerId(
  input: ResolveFadadaSignerCustomerIdInput
): ResolvedFadadaSignerCustomerId {
  if (input.mode !== "FULL_SIGNING_SMOKE" || !input.config.fullSigningSmokeEnabled) {
    throw new Error(`${FADADA_SIGNER_CUSTOMER_ID_MISSING}: provider customer_id mapping is required`);
  }

  const localCustomerId = normalize(input.localCustomerId);
  const allowedLocalCustomerId = normalize(input.config.testLocalCustomerId);
  const providerCustomerId = normalize(input.config.testCustomerId);

  if (!localCustomerId || !allowedLocalCustomerId || !providerCustomerId) {
    throw new Error(`${FADADA_SIGNER_CUSTOMER_ID_MISSING}: provider customer_id mapping is required`);
  }

  if (localCustomerId !== allowedLocalCustomerId) {
    throw new Error(`${FADADA_TEST_CUSTOMER_ID_MISMATCH}: local customer is not approved for Fadada full-signing smoke`);
  }

  return {
    providerCustomerId,
    source: "ENV_TEST_SIGNER"
  };
}

function normalize(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
