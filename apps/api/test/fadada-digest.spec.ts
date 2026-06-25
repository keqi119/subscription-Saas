import { describe, expect, it, vi } from "vitest";

import {
  buildFadadaMsgDigest,
  formatFadadaTimestamp,
  md5Upper,
  sha1Upper,
  sortBusinessParams,
  verifyFadadaCallbackDigest
} from "../src/esign/fadada/fadada-digest";
import {
  buildContractFilingRequest,
  buildContractStatusRequest,
  buildDownloadContractRequest,
  buildExtSignAutoRequest,
  buildExtSignRequest,
  buildExtSignValidationRequest,
  buildFadadaRequest,
  buildGetUrlRequest,
  buildQuerySignResultRequest,
  buildUploadDocsRequest,
  buildViewContractRequest
} from "../src/esign/fadada/fadada-request-builder";
import { FadadaConfig } from "../src/esign/fadada/fadada.types";

describe("Fadada digest helpers", () => {
  it("formats timestamps as yyyyMMddHHmmss", () => {
    expect(formatFadadaTimestamp(new Date(2026, 0, 2, 3, 4, 5))).toBe("20260102030405");
  });

  it("returns uppercase MD5 and SHA1 hex strings", () => {
    expect(md5Upper("20260102030405")).toBe("D8A723FBC893DA8D0A86A82E1E6DD88C");
    expect(sha1Upper("hello")).toBe("AAF4C61DDCC5E8A2DABEDE0F3B482CD9AEA9434D");
  });

  it("sorts business params by key and ignores null, undefined, and public fields", () => {
    expect(
      sortBusinessParams({
        a: 7,
        app_id: "ignored",
        contract_id: "contract-1",
        customer_id: "customer-1",
        msg_digest: "ignored",
        optional: null,
        timestamp: "ignored",
        v: "ignored",
        z: "last"
      })
    ).toBe("7contract-1customer-1last");
  });

  it("builds a deterministic local digest fixture", () => {
    expect(
      buildFadadaMsgDigest({
        appId: "app-123",
        appSecret: "secret-xyz",
        businessParams: {
          a: 7,
          contract_id: "contract-1",
          customer_id: "customer-1",
          z: "last"
        },
        timestamp: "20260102030405"
      })
    ).toBe("Qjg2MkVCNTQ0RkMzRTE0MjUwRDA1MTgwNjhEMjk2QkJBMTkwMzk0Rg==");
  });

  it("supports callback digest verification with constant-time compare", () => {
    const receivedMsgDigest = buildFadadaMsgDigest({
      appId: "app-123",
      appSecret: "secret-xyz",
      explicitSortString: "transaction-1",
      timestamp: "20260102030405"
    });

    expect(
      verifyFadadaCallbackDigest({
        appId: "app-123",
        appSecret: "secret-xyz",
        businessParams: { transaction_id: "transaction-1" },
        receivedMsgDigest,
        timestamp: "20260102030405"
      })
    ).toBe(true);

    expect(
      verifyFadadaCallbackDigest({
        appId: "app-123",
        appSecret: "secret-xyz",
        businessParams: { transaction_id: "transaction-1" },
        receivedMsgDigest: "bad-digest",
        timestamp: "20260102030405"
      })
    ).toBe(false);
  });
});

describe("Fadada request builder", () => {
  it("injects common params and does not send a network request", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const request = buildFadadaRequest({
      businessParams: { contract_id: "CONTRACT-1" },
      config: fadadaConfig(),
      endpoint: "contract_status.api",
      timestamp: "20260102030405"
    });

    expect(request).toMatchObject({
      contentType: "application/x-www-form-urlencoded;charset=UTF-8",
      endpoint: "contract_status.api",
      method: "POST",
      url: "https://testapi.fadada.com:8443/api/contract_status.api"
    });
    expect(request.params).toMatchObject({
      app_id: "app-123",
      contract_id: "CONTRACT-1",
      msg_digest: "MjU4RDk1NzBCMkJBMEI4OTI2NTU2MDhDNDU4RDQyMEM5MTgyMTBDNg==",
      timestamp: "20260102030405",
      v: "2.0"
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("builds multipart upload metadata without reading a file", () => {
    const request = buildUploadDocsRequest({
      businessParams: {
        contract_id: "CONTRACT-1",
        doc_title: "Document.pdf",
        doc_type: ".pdf"
      },
      config: fadadaConfig(),
      timestamp: "20260102030405"
    });

    expect(request).toMatchObject({
      contentType: "multipart/form-data;charset=utf8",
      endpoint: "uploaddocs.api",
      method: "POST",
      url: "https://testapi.fadada.com:8443/api/uploaddocs.api"
    });
    expect(request.params.file).toBeUndefined();
    expect(request.params.contract_id).toBe("CONTRACT-1");
  });

  it("provides builders for the B1 endpoint metadata matrix", () => {
    const config = fadadaConfig();
    const baseInput = {
      businessParams: { contract_id: "CONTRACT-1" },
      config,
      timestamp: "20260102030405"
    };

    expect([
      buildUploadDocsRequest(baseInput).endpoint,
      buildExtSignValidationRequest(baseInput).endpoint,
      buildExtSignRequest(baseInput).endpoint,
      buildExtSignAutoRequest(baseInput).endpoint,
      buildQuerySignResultRequest(baseInput).endpoint,
      buildContractStatusRequest(baseInput).endpoint,
      buildDownloadContractRequest(baseInput).endpoint,
      buildGetUrlRequest(baseInput).endpoint,
      buildViewContractRequest(baseInput).endpoint,
      buildContractFilingRequest(baseInput).endpoint
    ]).toEqual([
      "uploaddocs.api",
      "extsign_validation.api",
      "extsign.api",
      "extsign_auto.api",
      "query_sign_result.api",
      "contract_status.api",
      "downLoadContract.api",
      "geturl.api",
      "viewContract.api",
      "contractFiling.api"
    ]);
  });
});

function fadadaConfig(): FadadaConfig {
  return {
    apiVersion: "2.0",
    appId: "app-123",
    appSecret: "secret-xyz",
    baseUrl: "https://testapi.fadada.com:8443/api/",
    enabled: false,
    env: "sandbox",
    requestTimeoutMs: 15000
  };
}
