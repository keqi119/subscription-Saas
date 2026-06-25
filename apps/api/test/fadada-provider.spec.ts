import { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";

import { createESignProviderClient } from "../src/esign/esign.module";
import { buildFadadaMsgDigest } from "../src/esign/fadada/fadada-digest";
import { FadadaESignProvider } from "../src/esign/fadada/fadada-esign.provider";
import { loadFadadaConfig } from "../src/esign/fadada/fadada.config";
import { MockESignProvider } from "../src/esign/mock-esign.provider";

describe("Fadada provider configuration", () => {
  it("does not require Fadada env when the selected provider is mock", () => {
    const provider = createESignProviderClient(new ConfigService({ ESIGN_PROVIDER: "mock" }));

    expect(provider).toBeInstanceOf(MockESignProvider);
  });

  it("requires base URL, app ID, and app secret when ESIGN_PROVIDER=fadada", () => {
    expect(() => loadFadadaConfig(new ConfigService({ ESIGN_PROVIDER: "fadada" }))).toThrow(
      /FADADA_CONFIG_MISSING: FADADA_BASE_URL, FADADA_APP_ID, FADADA_APP_SECRET/
    );
  });

  it("creates a Fadada skeleton provider when selected and configured", () => {
    const provider = createESignProviderClient(configService({ ESIGN_PROVIDER: "fadada" }));

    expect(provider).toBeInstanceOf(FadadaESignProvider);
  });

  it("rejects unknown provider values with a clear error", () => {
    expect(() => createESignProviderClient(new ConfigService({ ESIGN_PROVIDER: "unexpected" }))).toThrow(
      /ESIGN_PROVIDER_UNSUPPORTED: unexpected/
    );
  });
});

describe("Fadada provider skeleton", () => {
  it("returns a Stage 10D-B2 required error for createSignTask", async () => {
    const provider = new FadadaESignProvider(loadFadadaConfig(configService()));

    await expect(
      provider.createSignTask({
        contractId: "contract-1",
        documentName: "Contract.pdf",
        signers: [{ customerId: "customer-1", signerType: "CUSTOMER" }],
        taskNo: "ESG-1"
      })
    ).rejects.toThrow(/FADADA_PROVIDER_STAGE_B2_REQUIRED/);
  });

  it("returns a Stage 10D-B2 required error for getSignerUrl", async () => {
    const provider = new FadadaESignProvider(loadFadadaConfig(configService()));

    await expect(provider.getSignerUrl({ providerTaskId: "transaction-1" })).rejects.toThrow(
      /FADADA_SIGN_URL_STAGE_B2_REQUIRED/
    );
  });

  it("verifies form callback digest without advancing business state", async () => {
    const provider = new FadadaESignProvider(loadFadadaConfig(configService()));
    const receivedMsgDigest = buildFadadaMsgDigest({
      appId: "app-123",
      appSecret: "secret-xyz",
      explicitSortString: "transaction-1",
      timestamp: "20260102030405"
    });

    const result = await provider.verifyCallback({
      contract_id: "contract-1",
      download_url: "https://example.test/download",
      msg_digest: receivedMsgDigest,
      result_code: "3000",
      result_desc: "success",
      timestamp: "20260102030405",
      transaction_id: "transaction-1",
      viewpdf_url: "https://example.test/view"
    });

    expect(result).toMatchObject({
      eventType: "FADADA_SIGN_COMPLETED",
      providerTaskId: "transaction-1",
      verified: true
    });
  });

  it("returns verified=false for invalid or missing callback digest", async () => {
    const provider = new FadadaESignProvider(loadFadadaConfig(configService()));

    await expect(
      provider.verifyCallback({
        result_code: "3000",
        timestamp: "20260102030405",
        transaction_id: "transaction-1"
      })
    ).resolves.toMatchObject({
      providerTaskId: "transaction-1",
      verified: false
    });

    await expect(
      provider.verifyCallback({
        msg_digest: "bad-digest",
        result_code: "3003",
        timestamp: "20260102030405",
        transaction_id: "transaction-1"
      })
    ).resolves.toMatchObject({
      eventType: "FADADA_SIGN_REJECTED",
      verified: false
    });
  });
});

function configService(overrides: Record<string, string> = {}) {
  return new ConfigService({
    ESIGN_PROVIDER: "fadada",
    FADADA_API_VERSION: "2.0",
    FADADA_APP_ID: "app-123",
    FADADA_APP_SECRET: "secret-xyz",
    FADADA_BASE_URL: "https://testapi.fadada.com:8443/api/",
    FADADA_ENABLED: "false",
    FADADA_ENV: "sandbox",
    FADADA_REQUEST_TIMEOUT_MS: "15000",
    ...overrides
  });
}
