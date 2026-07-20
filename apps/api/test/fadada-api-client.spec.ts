import { describe, expect, it, vi } from "vitest";

import { FadadaApiClient } from "../src/esign/fadada/fadada-api.client";
import { buildFadadaMsgDigest, buildFadadaMsgDigestFromParts } from "../src/esign/fadada/fadada-digest";
import { FadadaHttpClient, FadadaTransport } from "../src/esign/fadada/fadada-http-client";
import { buildContractStatusRequest } from "../src/esign/fadada/fadada-request-builder";
import { FadadaConfig } from "../src/esign/fadada/fadada.types";

describe("Fadada HTTP client", () => {
  it("does not call transport when FADADA_ENABLED=false", async () => {
    const transport: FadadaTransport = vi.fn();
    const client = new FadadaHttpClient(fadadaConfig({ enabled: false }), transport);
    const request = buildContractStatusRequest({
      businessParams: { contract_id: "CON-1" },
      config: fadadaConfig(),
      timestamp: "20260102030405"
    });

    await expect(client.send(request)).rejects.toThrow(/FADADA_DISABLED/);
    expect(transport).not.toHaveBeenCalled();
  });

  it("uses an injectable transport and parses JSON responses", async () => {
    const transport: FadadaTransport = vi.fn(async () => ({
      bodyText: "{\"code\":\"1\",\"message\":\"ok\"}",
      headers: { "content-type": "application/json" },
      status: 200
    }));
    const client = new FadadaHttpClient(fadadaConfig(), transport);
    const request = buildContractStatusRequest({
      businessParams: { contract_id: "CON-1" },
      config: fadadaConfig(),
      timestamp: "20260102030405"
    });

    const response = await client.send(request);

    expect(transport).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining("contract_id=CON-1"),
      headers: expect.objectContaining({ "content-type": "application/x-www-form-urlencoded;charset=UTF-8" }),
      method: "POST",
      timeoutMs: 15000,
      url: "https://testapi.fadada.com:8443/api/contract_status.api"
    }));
    expect(response.parsedBody).toEqual({ code: "1", message: "ok" });
  });
});

describe("Fadada API client", () => {
  it("registers a personal account through mocked transport", async () => {
    const transport: FadadaTransport = vi.fn(async () => ({
      bodyText: "{\"code\":\"1\",\"data\":\"CUSTOMER-1234567890\",\"msg\":\"success\"}",
      headers: { "content-type": "application/json" },
      status: 200
    }));
    const apiClient = new FadadaApiClient(fadadaConfig(), new FadadaHttpClient(fadadaConfig(), transport));

    const result = await apiClient.registerAccount({
      accountType: "PERSONAL",
      openId: "subauto-production-smoke-person-001"
    });

    expect(result).toMatchObject({
      openId: "subauto-production-smoke-person-001",
      providerCustomerId: "CUSTOMER-1234567890",
      resultCode: "1",
      resultDesc: "success"
    });
    const request = vi.mocked(transport).mock.calls[0]?.[0];
    expect(request?.url).toBe("https://testapi.fadada.com:8443/api/account_register.api");
    expect(String(request?.body)).toContain("account_type=1");
    expect(String(request?.body)).toContain("open_id=subauto-production-smoke-person-001");
    expect(String(request?.body)).not.toContain("secret-xyz");
  });

  it("gets a personal real-name verification URL and decodes provider Base64 URL", async () => {
    const verifyUrl = "https://verify.example.test/realname?token=secret";
    const transport: FadadaTransport = vi.fn(async () => ({
      bodyText: JSON.stringify({
        code: "1",
        data: {
          transactionNo: "VERIFY-TX-1",
          url: Buffer.from(verifyUrl, "utf8").toString("base64")
        },
        msg: "success"
      }),
      headers: { "content-type": "application/json" },
      status: 200
    }));
    const apiClient = new FadadaApiClient(fadadaConfig(), new FadadaHttpClient(fadadaConfig(), transport));

    const result = await apiClient.getPersonVerifyUrl({
      customerId: "CUSTOMER-1234567890",
      idCardNo: "110101199001011234",
      mobile: "13800138000",
      name: "Test User",
      notifyUrl: "https://api.example.test/api/esign/verify-callback/fadada",
      returnUrl: "https://app.example.test/portal/contracts"
    });

    expect(result).toMatchObject({
      customerId: "CUSTOMER-1234567890",
      resultCode: "1",
      resultDesc: "success",
      transactionNo: "VERIFY-TX-1",
      verifyUrl
    });
    const request = vi.mocked(transport).mock.calls[0]?.[0];
    expect(request?.url).toBe("https://testapi.fadada.com:8443/api/get_person_verify_url.api");
    expect(String(request?.body)).toContain("cert_flag=1");
    expect(String(request?.body)).toContain("verified_way=1");
    expect(String(request?.body)).toContain("page_modify=1");
    expect(String(request?.body)).not.toContain("secret-xyz");
  });

  it("queries personal real-name status with verified_serialno from mocked transport", async () => {
    const transport: FadadaTransport = vi.fn(async () => ({
      bodyText: JSON.stringify({
        code: "1",
        data: {
          person: {
            status: "2"
          },
          transactionNo: "VERIFY-TX-1"
        },
        msg: "success"
      }),
      headers: { "content-type": "application/json" },
      status: 200
    }));
    const apiClient = new FadadaApiClient(fadadaConfig(), new FadadaHttpClient(fadadaConfig(), transport));

    const result = await apiClient.findPersonCertInfo({ verifiedSerialNo: "VERIFY-TX-1" });

    expect(result).toMatchObject({
      raw: {
        code: "1",
        data: {
          person: { status: "2" },
          transactionNo: "VERIFY-TX-1"
        },
        msg: "success"
      },
      realNameStatus: "2",
      resultCode: "1",
      resultDesc: "success",
      verifiedSerialNo: "VERIFY-TX-1"
    });
    const request = vi.mocked(transport).mock.calls[0]?.[0];
    expect(request?.url).toBe("https://testapi.fadada.com:8443/api/find_personCertInfo.api");
    expect(String(request?.body)).toContain("verified_serialno=VERIFY-TX-1");
    expect(String(request?.body)).not.toContain("secret-xyz");
  });

  it("applies a personal certificate binding through mocked transport", async () => {
    const transport: FadadaTransport = vi.fn(async () => ({
      bodyText: JSON.stringify({
        code: "1",
        data: {
          customer_id: "CUSTOMER-1234567890",
          verified_serialno: "VERIFY-TX-1"
        },
        msg: "success"
      }),
      headers: { "content-type": "application/json" },
      status: 200
    }));
    const apiClient = new FadadaApiClient(fadadaConfig(), new FadadaHttpClient(fadadaConfig(), transport));

    const result = await apiClient.applyCert({
      customerId: "CUSTOMER-1234567890",
      verifiedSerialNo: "VERIFY-TX-1"
    });

    expect(result).toMatchObject({
      customerId: "CUSTOMER-1234567890",
      resultCode: "1",
      resultDesc: "success",
      verifiedSerialNo: "VERIFY-TX-1"
    });
    const request = vi.mocked(transport).mock.calls[0]?.[0];
    expect(request?.url).toBe("https://testapi.fadada.com:8443/api/apply_cert.api");
    expect(String(request?.body)).toContain("customer_id=CUSTOMER-1234567890");
    expect(String(request?.body)).toContain("verified_serialno=VERIFY-TX-1");
    expect(String(request?.body)).not.toContain("secret-xyz");
  });

  it("queries certificate information with customerId through mocked transport", async () => {
    const transport: FadadaTransport = vi.fn(async () => ({
      bodyText: JSON.stringify({
        code: "1",
        data: {
          cert: {
            certType: "0",
            dn: "CN=Test",
            endTime: "20270102030405",
            sequenceNo: "CERT-SEQUENCE-1",
            startTime: "20260102030405"
          }
        },
        msg: "success"
      }),
      headers: { "content-type": "application/json" },
      status: 200
    }));
    const apiClient = new FadadaApiClient(fadadaConfig(), new FadadaHttpClient(fadadaConfig(), transport));

    const result = await apiClient.queryCert({ customerId: "CUSTOMER-1234567890" });

    expect(result).toMatchObject({
      certBound: true,
      certSerialNo: "CERT-SEQUENCE-1",
      customerId: "CUSTOMER-1234567890",
      resultCode: "1",
      resultDesc: "success"
    });
    const request = vi.mocked(transport).mock.calls[0]?.[0];
    expect(request?.method).toBe("GET");
    expect(`${new URL(request?.url ?? "").origin}${new URL(request?.url ?? "").pathname}`).toBe(
      "https://testapi.fadada.com:8443/api/query_cert.api"
    );
    expect(new URL(request?.url ?? "").searchParams.get("customerId")).toBe("CUSTOMER-1234567890");
    expect(request?.body).toBeUndefined();
    expect(request?.url).not.toContain("secret-xyz");
  });

  it("parses query_cert numeric code with JSON string certificate data", async () => {
    const transport: FadadaTransport = vi.fn(async () => ({
      bodyText: JSON.stringify({
        code: 1,
        data: JSON.stringify({
          certType: "0",
          dn: "CN=Test",
          endTime: "20270102030405",
          sequenceNo: "CERT-SEQUENCE-1",
          startTime: "20260102030405"
        }),
        msg: "success"
      }),
      headers: { "content-type": "application/json" },
      status: 200
    }));
    const apiClient = new FadadaApiClient(fadadaConfig(), new FadadaHttpClient(fadadaConfig(), transport));

    const result = await apiClient.queryCert({ customerId: "CUSTOMER-1234567890" });

    expect(result).toMatchObject({
      certBound: true,
      certSerialNo: "CERT-SEQUENCE-1",
      resultCode: "1",
      resultDesc: "success"
    });
  });

  it("parses query_cert string code with object certificate data", async () => {
    const transport: FadadaTransport = vi.fn(async () => ({
      bodyText: JSON.stringify({
        code: "1",
        data: {
          certType: "0",
          dn: "CN=Test",
          endTime: "20270102030405",
          sequenceNo: "CERT-SEQUENCE-2",
          startTime: "20260102030405"
        },
        msg: "success"
      }),
      headers: { "content-type": "application/json" },
      status: 200
    }));
    const apiClient = new FadadaApiClient(fadadaConfig(), new FadadaHttpClient(fadadaConfig(), transport));

    const result = await apiClient.queryCert({ customerId: "CUSTOMER-1234567890" });

    expect(result).toMatchObject({
      certBound: true,
      certSerialNo: "CERT-SEQUENCE-2",
      resultCode: "1"
    });
  });

  it("does not mark query_cert bound when provider success lacks certificate evidence", async () => {
    const transport: FadadaTransport = vi.fn(async () => ({
      bodyText: JSON.stringify({
        code: 1,
        data: {},
        msg: "success"
      }),
      headers: { "content-type": "application/json" },
      status: 200
    }));
    const apiClient = new FadadaApiClient(fadadaConfig(), new FadadaHttpClient(fadadaConfig(), transport));

    const result = await apiClient.queryCert({ customerId: "CUSTOMER-1234567890" });

    expect(result).toMatchObject({
      certBound: false,
      certSerialNo: undefined,
      resultCode: "1",
      resultDesc: "success"
    });
  });

  it("does not mark query_cert bound when certificate evidence accompanies failure code", async () => {
    const transport: FadadaTransport = vi.fn(async () => ({
      bodyText: JSON.stringify({
        code: 3205,
        data: JSON.stringify({
          certType: "0",
          dn: "CN=Test",
          endTime: "20270102030405",
          sequenceNo: "CERT-SEQUENCE-FAILED",
          startTime: "20260102030405"
        }),
        msg: "not verified"
      }),
      headers: { "content-type": "application/json" },
      status: 200
    }));
    const apiClient = new FadadaApiClient(fadadaConfig(), new FadadaHttpClient(fadadaConfig(), transport));

    const result = await apiClient.queryCert({ customerId: "CUSTOMER-1234567890" });

    expect(result).toMatchObject({
      certBound: false,
      certSerialNo: "CERT-SEQUENCE-FAILED",
      resultCode: "3205",
      resultDesc: "not verified"
    });
  });

  it("fails closed for invalid JSON string query_cert data", async () => {
    const transport: FadadaTransport = vi.fn(async () => ({
      bodyText: JSON.stringify({
        code: "1",
        data: "{\"sequenceNo\":",
        msg: "success"
      }),
      headers: { "content-type": "application/json" },
      status: 200
    }));
    const apiClient = new FadadaApiClient(fadadaConfig(), new FadadaHttpClient(fadadaConfig(), transport));

    const result = await apiClient.queryCert({ customerId: "CUSTOMER-1234567890" });

    expect(result).toMatchObject({
      certBound: false,
      certSerialNo: undefined,
      resultCode: "1",
      resultDesc: "success"
    });
  });

  it("normalizes numeric provider codes on provider API responses", async () => {
    const transport: FadadaTransport = vi.fn(async () => ({
      bodyText: JSON.stringify({
        code: 1,
        msg: "success"
      }),
      headers: { "content-type": "application/json" },
      status: 200
    }));
    const apiClient = new FadadaApiClient(fadadaConfig(), new FadadaHttpClient(fadadaConfig(), transport));

    const result = await apiClient.applyCert({
      customerId: "CUSTOMER-1234567890",
      verifiedSerialNo: "VERIFY-TX-1"
    });

    expect(result).toMatchObject({
      resultCode: "1",
      resultDesc: "success"
    });
  });

  it("normalizes numeric 1000 provider codes for platform auto seal responses", async () => {
    const transport: FadadaTransport = vi.fn(async () => ({
      bodyText: JSON.stringify({
        code: 1000,
        msg: "success"
      }),
      headers: { "content-type": "application/json" },
      status: 200
    }));
    const apiClient = new FadadaApiClient(fadadaConfig(), new FadadaHttpClient(fadadaConfig(), transport));

    const result = await apiClient.autoSealContract({
      contractId: "CON-1",
      customerId: "platform-customer-1",
      signatureId: "platform-signature-1",
      transactionId: "TX2"
    });

    expect(result).toMatchObject({
      resultCode: "1000",
      resultDesc: "success"
    });
  });

  it("recovers real-name serial numbers and links with find_serialNo through mocked transport", async () => {
    const encodedUrl = Buffer.from("https://verify.example.test/realname?token=secret", "utf8").toString("base64");
    const transport: FadadaTransport = vi.fn(async () => ({
      bodyText: JSON.stringify({
        code: "1",
        data: {
          bindSerialNo: "VERIFY-TX-BOUND",
          transactionList: [{
            identityName: "Test User",
            status: "1",
            transactionNo: "VERIFY-TX-1",
            type: "2",
            url: encodedUrl
          }]
        },
        msg: "success"
      }),
      headers: { "content-type": "application/json" },
      status: 200
    }));
    const apiClient = new FadadaApiClient(fadadaConfig(), new FadadaHttpClient(fadadaConfig(), transport));

    const result = await apiClient.findRealNameSerialNumbers({ customerId: "CUSTOMER-1234567890" });

    expect(result).toMatchObject({
      bindSerialNo: "VERIFY-TX-BOUND",
      customerId: "CUSTOMER-1234567890",
      transactions: [{
        status: "1",
        transactionNo: "VERIFY-TX-1",
        verifyUrl: "https://verify.example.test/realname?token=secret"
      }]
    });
    const request = vi.mocked(transport).mock.calls[0]?.[0];
    expect(request?.url).toBe("https://testapi.fadada.com:8443/api/find_serialNo.api");
    expect(String(request?.body)).toContain("customer_id=CUSTOMER-1234567890");
    expect(String(request?.body)).not.toContain("secret-xyz");
  });

  it("builds uploadDocs multipart requests through mocked transport", async () => {
    const transport: FadadaTransport = vi.fn(async () => ({
      bodyText: "{\"result\":\"kept-raw\"}",
      headers: { "content-type": "application/json" },
      status: 200
    }));
    const apiClient = new FadadaApiClient(fadadaConfig(), new FadadaHttpClient(fadadaConfig(), transport));

    const result = await apiClient.uploadDocs({
      contractId: "CON-1",
      docTitle: "Contract.pdf",
      fileName: "Contract.pdf",
      pdf: minimalPdf()
    });

    expect(result).toMatchObject({
      contractId: "CON-1",
      raw: { result: "kept-raw" }
    });
    const request = vi.mocked(transport).mock.calls[0]?.[0];
    expect(request?.headers["content-type"]).toContain("multipart/form-data");
    expect(Buffer.isBuffer(request?.body)).toBe(true);
    expect((request?.body as Buffer).toString("utf8")).toContain('name="file"; filename="Contract.pdf"');
    expect((request?.body as Buffer).toString("utf8")).toContain("application/pdf");
  });

  it("rejects non-PDF and oversized uploadDocs files before transport", async () => {
    const transport: FadadaTransport = vi.fn();
    const apiClient = new FadadaApiClient(fadadaConfig(), new FadadaHttpClient(fadadaConfig(), transport));

    await expect(
      apiClient.uploadDocs({
        contractId: "CON-1",
        docTitle: "Contract.txt",
        fileName: "Contract.txt",
        pdf: Buffer.from("not-pdf")
      })
    ).rejects.toThrow(/FADADA_UPLOAD_REQUIRES_PDF/);

    await expect(
      apiClient.uploadDocs({
        contractId: "CON-1",
        docTitle: "Contract.pdf",
        fileName: "Contract.pdf",
        pdf: Buffer.concat([minimalPdf(), Buffer.alloc(20 * 1024 * 1024)])
      })
    ).rejects.toThrow(/FADADA_UPLOAD_FILE_TOO_LARGE/);

    expect(transport).not.toHaveBeenCalled();
  });

  it("builds external signing page URL metadata without prefetching the page interface", async () => {
    const transport: FadadaTransport = vi.fn(async () => {
      throw new Error("extsign_validation.api is a page URL and must not be prefetched");
    });
    const apiClient = new FadadaApiClient(fadadaConfig(), new FadadaHttpClient(fadadaConfig(), transport));

    const result = await apiClient.createExternalSignUrl({
      contractId: "CON-1",
      customerId: "fadada-customer-1",
      docTitle: "Contract.pdf",
      notifyUrl: "https://api.example.test/esign/callback/fadada",
      quantity: 1,
      returnUrl: "https://app.example.test/portal/contracts/contract-1",
      transactionId: "TX1",
      validityMinutes: 30
    });

    expect(result.transactionId).toBe("TX1");
    expect(result.signUrlExpiresAt).toBeInstanceOf(Date);
    expect(transport).not.toHaveBeenCalled();
    const url = new URL(result.signUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://testapi.fadada.com:8443/api/extsign_validation.api");
    expect(url.searchParams.get("transaction_id")).toBe("TX1");
    expect(url.searchParams.get("doc_title")).toBe("Contract.pdf");
    expect(url.searchParams.get("validity")).toBe("30");
    expect(url.searchParams.get("quantity")).toBe("1");
    expect(result.raw).toMatchObject({
      endpoint: "extsign_validation.api",
      method: "GET",
      pageInterface: true
    });
  });

  it("builds coordinate-based manual signing URL with two signature positions", async () => {
    const transport: FadadaTransport = vi.fn(async () => {
      throw new Error("extsign.api is a page URL and must not be prefetched");
    });
    const apiClient = new FadadaApiClient(fadadaConfig(), new FadadaHttpClient(fadadaConfig(), transport));

    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 2, 3, 4, 5));
    try {
      const result = await apiClient.createExternalSignUrl({
        contractId: "CON-1",
        customerId: "fadada-customer-1",
        docTitle: "Contract.pdf",
        notifyUrl: "https://api.example.test/esign/callback/fadada",
        returnUrl: "https://app.example.test/portal/contracts/contract-1",
        signaturePositions: [
          { pagenum: 0, x: 520.25, y: 730.5 },
          { pagenum: 2, x: 521.75, y: 731.25 }
        ],
        transactionId: "TX1",
        validityMinutes: 30
      });

      expect(result.transactionId).toBe("TX1");
      expect(result.signUrlExpiresAt?.getTime()).toBe(Date.now() + 30 * 60_000);
      expect(transport).not.toHaveBeenCalled();
      const url = new URL(result.signUrl);
      const serializedPositions = JSON.stringify([
        { pagenum: 0, x: 520.25, y: 730.5 },
        { pagenum: 2, x: 521.75, y: 731.25 }
      ]);
      expect(`${url.origin}${url.pathname}`).toBe("https://testapi.fadada.com:8443/api/extsign.api");
      expect(url.searchParams.get("transaction_id")).toBe("TX1");
      expect(url.searchParams.get("contract_id")).toBe("CON-1");
      expect(url.searchParams.get("customer_id")).toBe("fadada-customer-1");
      expect(url.searchParams.get("position_type")).toBe("1");
      expect(url.searchParams.get("sign_keyword")).toBeNull();
      expect(url.searchParams.get("signature_positions")).toBe(serializedPositions);
      expect(url.searchParams.get("signature_positions")).not.toContain(" ");
      expect(url.searchParams.get("timestamp")).toBe("20260102030405");
      expect(url.searchParams.get("msg_digest")).toBe(
        "RTkxMUVGNEEyQ0U2NTYyRTY4QTQ0QzNDRkU1QjMxMjA0NTE0NEE2Rg=="
      );
      expect(url.searchParams.get("msg_digest")).toBe(buildFadadaMsgDigestFromParts({
        appId: "app-123",
        appSecret: "secret-xyz",
        md5Seed: "TX120260102030405",
        secretSortString: "fadada-customer-1"
      }));
      expect(url.searchParams.get("msg_digest")).not.toBe(buildFadadaMsgDigest({
        appId: "app-123",
        appSecret: "secret-xyz",
        businessParams: {
          contract_id: "CON-1",
          customer_id: "fadada-customer-1",
          doc_title: "Contract.pdf",
          notify_url: "https://api.example.test/esign/callback/fadada",
          position_type: "1",
          return_url: "https://app.example.test/portal/contracts/contract-1",
          signature_positions: serializedPositions,
          transaction_id: "TX1"
        },
        timestamp: "20260102030405"
      }));
      expect(result.raw).toMatchObject({
        endpoint: "extsign.api",
        method: "GET",
        pageInterface: true,
        signaturePositions: 2
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects provider transaction ids outside the documented Fadada format", async () => {
    const transport: FadadaTransport = vi.fn();
    const apiClient = new FadadaApiClient(fadadaConfig(), new FadadaHttpClient(fadadaConfig(), transport));

    await expect(apiClient.createExternalSignUrl({
      contractId: "CON-1",
      customerId: "fadada-customer-1",
      docTitle: "Contract.pdf",
      notifyUrl: "https://api.example.test/esign/callback/fadada",
      quantity: 1,
      returnUrl: "https://app.example.test/portal/contracts/contract-1",
      transactionId: "TX-1",
      validityMinutes: 30
    })).rejects.toThrow(/FADADA_TRANSACTION_ID_INVALID/);

    await expect(apiClient.autoSealContract({
      contractId: "CON-1",
      customerId: "platform-customer-1",
      signatureId: "platform-signature-1",
      transactionId: "交易1"
    })).rejects.toThrow(/FADADA_TRANSACTION_ID_INVALID/);

    await expect(apiClient.querySignResult({
      contractId: "CON-1",
      customerId: "fadada-customer-1",
      transactionId: "X".repeat(33)
    })).rejects.toThrow(/FADADA_TRANSACTION_ID_INVALID/);

    expect(transport).not.toHaveBeenCalled();
  });

  it("calls the Fadada auto-sign endpoint for platform seal requests", async () => {
    const transport: FadadaTransport = vi.fn(async () => ({
      bodyText: JSON.stringify({
        code: "1000",
        msg: "success",
        result: "success"
      }),
      headers: { "content-type": "application/json" },
      status: 200
    }));
    const apiClient = new FadadaApiClient(fadadaConfig(), new FadadaHttpClient(fadadaConfig(), transport));

    const result = await apiClient.autoSealContract({
      contractId: "CON-1",
      customerId: "platform-customer-1",
      docTitle: "Contract.pdf",
      notifyUrl: "https://api.example.test/esign/callback/fadada",
      placement: {
        keyword: "出租方盖章",
        type: "KEYWORD"
      },
      signatureId: "platform-signature-1",
      transactionId: "TX2"
    });

    expect(result).toMatchObject({
      contractId: "CON-1",
      resultCode: "1000",
      resultDesc: "success",
      transactionId: "TX2"
    });
    const request = vi.mocked(transport).mock.calls[0]?.[0];
    expect(request?.url).toBe("https://testapi.fadada.com:8443/api/extsign_auto.api");
    expect(String(request?.body)).toContain("contract_id=CON-1");
    expect(String(request?.body)).toContain("customer_id=platform-customer-1");
    expect(String(request?.body)).toContain("signature_id=platform-signature-1");
    expect(String(request?.body)).toContain("transaction_id=TX2");
    const params = new URLSearchParams(String(request?.body));
    expect(params.get("position_type")).toBe("0");
    expect(params.get("msg_digest")).toBe(buildFadadaMsgDigestFromParts({
      appId: "app-123",
      appSecret: "secret-xyz",
      md5Seed: `TX2${params.get("timestamp")}`,
      secretSortString: "platform-customer-1"
    }));
    expect(params.get("sign_keyword")).toBe("出租方盖章");
    expect(String(request?.body)).not.toContain("secret-xyz");
  });

  it("builds coordinate-based auto-sign request with two platform signature positions", async () => {
    const transport: FadadaTransport = vi.fn(async () => ({
      bodyText: JSON.stringify({
        code: "1000",
        msg: "success",
        result: "success"
      }),
      headers: { "content-type": "application/json" },
      status: 200
    }));
    const apiClient = new FadadaApiClient(fadadaConfig(), new FadadaHttpClient(fadadaConfig(), transport));

    const result = await apiClient.autoSealContract({
      contractId: "CON-1",
      customerId: "platform-customer-1",
      docTitle: "Contract.pdf",
      notifyUrl: "https://api.example.test/esign/callback/fadada",
      signaturePositions: [
        { pagenum: 0, x: 521, y: 731 },
        { pagenum: 2, x: 523, y: 733 }
      ],
      signatureId: "platform-signature-1",
      transactionId: "TX2"
    });

    expect(result).toMatchObject({
      contractId: "CON-1",
      resultCode: "1000",
      transactionId: "TX2"
    });
    const request = vi.mocked(transport).mock.calls[0]?.[0];
    const params = new URLSearchParams(String(request?.body));
    expect(request?.url).toBe("https://testapi.fadada.com:8443/api/extsign_auto.api");
    expect(params.get("transaction_id")).toBe("TX2");
    expect(params.get("signature_id")).toBe("platform-signature-1");
    expect(params.get("position_type")).toBe("1");
    expect(params.get("sign_keyword")).toBeNull();
    expect(params.get("signature_positions")).toBe(JSON.stringify([
      { pagenum: 0, x: 521, y: 731 },
      { pagenum: 2, x: 523, y: 733 }
    ]));
    expect(params.get("signature_positions")).not.toContain("520");
    expect(params.get("signature_positions")).not.toContain("522");
    expect(params.get("msg_digest")).toBe(buildFadadaMsgDigestFromParts({
      appId: "app-123",
      appSecret: "secret-xyz",
      md5Seed: `TX2${params.get("timestamp")}`,
      secretSortString: "platform-customer-1"
    }));
    expect(String(request?.body)).not.toContain("sign_keyword");
    expect(String(request?.body)).not.toContain("secret-xyz");
  });

  it("queries sign result and keeps provider URLs inside the raw response only", async () => {
    const transport: FadadaTransport = vi.fn(async () => ({
      bodyText: JSON.stringify({
        result: "3000",
        result_desc: "completed",
        download_url: "https://download.example.test/file.pdf?token=secret",
        view_url: "https://view.example.test/file.pdf?token=secret"
      }),
      headers: { "content-type": "application/json" },
      status: 200
    }));
    const apiClient = new FadadaApiClient(fadadaConfig(), new FadadaHttpClient(fadadaConfig(), transport));

    const result = await apiClient.querySignResult({
      contractId: "CON-1",
      customerId: "fadada-customer-1",
      transactionId: "TX1"
    });

    expect(result).toMatchObject({
      contractId: "CON-1",
      downloadUrl: "https://download.example.test/file.pdf?token=secret",
      resultCode: "3000",
      resultDesc: "completed",
      status: "SIGNED",
      transactionId: "TX1",
      viewPdfUrl: "https://view.example.test/file.pdf?token=secret"
    });
    expect(vi.mocked(transport).mock.calls[0]?.[0]).toMatchObject({
      method: "POST",
      url: "https://testapi.fadada.com:8443/api/query_sign_result.api"
    });
    expect(String(vi.mocked(transport).mock.calls[0]?.[0].body)).toContain("contract_id=CON-1");
    expect(String(vi.mocked(transport).mock.calls[0]?.[0].body)).toContain("customer_id=fadada-customer-1");
    expect(String(vi.mocked(transport).mock.calls[0]?.[0].body)).toContain("transaction_id=TX1");
  });

  it("queries contract status through mocked transport", async () => {
    const transport: FadadaTransport = vi.fn(async () => ({
      bodyText: "{\"contractStatus\":\"2\"}",
      headers: { "content-type": "application/json" },
      status: 200
    }));
    const apiClient = new FadadaApiClient(fadadaConfig(), new FadadaHttpClient(fadadaConfig(), transport));

    const result = await apiClient.queryContractStatus({ contractId: "CON-1" });

    expect(result).toMatchObject({
      contractId: "CON-1",
      status: "2"
    });
    expect(vi.mocked(transport).mock.calls[0]?.[0].url).toBe(
      "https://testapi.fadada.com:8443/api/contract_status.api"
    );
  });

  it("downloads signed PDF buffers and rejects non-PDF responses", async () => {
    const pdf = minimalPdf();
    const transport: FadadaTransport = vi.fn(async () => ({
      bodyBuffer: pdf,
      bodyText: "",
      headers: {
        "content-disposition": "attachment; filename=signed.pdf",
        "content-type": "application/pdf"
      },
      status: 200
    }));
    const apiClient = new FadadaApiClient(fadadaConfig(), new FadadaHttpClient(fadadaConfig(), transport));

    const result = await apiClient.downloadSignedContract({ contractId: "CON-1" });

    expect(result).toMatchObject({
      contentType: "application/pdf",
      fileName: "signed.pdf"
    });
    expect(result.buffer.equals(pdf)).toBe(true);
    expect(vi.mocked(transport).mock.calls[0]?.[0]).toMatchObject({
      responseType: "arraybuffer",
      url: "https://testapi.fadada.com:8443/api/downLoadContract.api"
    });

    vi.mocked(transport).mockResolvedValueOnce({
      bodyBuffer: Buffer.from("{\"code\":\"1003\"}", "utf8"),
      bodyText: "",
      headers: { "content-type": "application/json" },
      status: 200
    });

    await expect(apiClient.downloadSignedContract({ contractId: "CON-1" })).rejects.toThrow(
      /FADADA_DOWNLOAD_REQUIRES_PDF/
    );
  });

  it("creates contract filing metadata through mocked transport", async () => {
    const transport: FadadaTransport = vi.fn(async () => ({
      bodyText: "{\"filing_no\":\"FILING-1\",\"result\":\"success\"}",
      headers: { "content-type": "application/json" },
      status: 200
    }));
    const apiClient = new FadadaApiClient(fadadaConfig(), new FadadaHttpClient(fadadaConfig(), transport));

    const result = await apiClient.createContractFiling({ contractId: "CON-1" });

    expect(result).toMatchObject({
      contractId: "CON-1",
      filingNo: "FILING-1",
      raw: { filing_no: "FILING-1", result: "success" }
    });
    expect(vi.mocked(transport).mock.calls[0]?.[0].url).toBe(
      "https://testapi.fadada.com:8443/api/contractFiling.api"
    );
  });
});

function fadadaConfig(overrides: Partial<FadadaConfig> = {}): FadadaConfig {
  return {
    accountRegisterEnabled: false,
    apiVersion: "2.0",
    appId: "app-123",
    appSecret: "secret-xyz",
    baseUrl: "https://testapi.fadada.com:8443/api/",
    enabled: true,
    env: "sandbox",
    fullSigningSmokeEnabled: false,
    requestTimeoutMs: 15000,
    realNameVerifyEnabled: false,
    signUrlQuantity: 1,
    signUrlValidityMinutes: 30,
    ...overrides
  };
}

function minimalPdf() {
  return Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n", "utf8");
}
