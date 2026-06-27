import { describe, expect, it, vi } from "vitest";

import { FadadaApiClient } from "../src/esign/fadada/fadada-api.client";
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
      transactionId: "TX-1",
      validityMinutes: 30
    });

    expect(result.transactionId).toBe("TX-1");
    expect(result.signUrlExpiresAt).toBeInstanceOf(Date);
    expect(transport).not.toHaveBeenCalled();
    const url = new URL(result.signUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://testapi.fadada.com:8443/api/extsign_validation.api");
    expect(url.searchParams.get("transaction_id")).toBe("TX-1");
    expect(url.searchParams.get("doc_title")).toBe("Contract.pdf");
    expect(url.searchParams.get("validity")).toBe("30");
    expect(url.searchParams.get("quantity")).toBe("1");
    expect(result.raw).toMatchObject({
      endpoint: "extsign_validation.api",
      method: "GET",
      pageInterface: true
    });
  });

  it("queries sign result and keeps provider URLs inside the raw response only", async () => {
    const transport: FadadaTransport = vi.fn(async () => ({
      bodyText: JSON.stringify({
        result: "3000",
        result_desc: "completed",
        download_url: "https://download.example.test/file.pdf?token=secret",
        viewpdf_url: "https://view.example.test/file.pdf?token=secret"
      }),
      headers: { "content-type": "application/json" },
      status: 200
    }));
    const apiClient = new FadadaApiClient(fadadaConfig(), new FadadaHttpClient(fadadaConfig(), transport));

    const result = await apiClient.querySignResult({
      contractId: "CON-1",
      transactionId: "TX-1"
    });

    expect(result).toMatchObject({
      contractId: "CON-1",
      downloadUrl: "https://download.example.test/file.pdf?token=secret",
      resultCode: "3000",
      resultDesc: "completed",
      transactionId: "TX-1",
      viewPdfUrl: "https://view.example.test/file.pdf?token=secret"
    });
    expect(vi.mocked(transport).mock.calls[0]?.[0]).toMatchObject({
      method: "POST",
      url: "https://testapi.fadada.com:8443/api/query_sign_result.api"
    });
    expect(String(vi.mocked(transport).mock.calls[0]?.[0].body)).toContain("contract_id=CON-1");
    expect(String(vi.mocked(transport).mock.calls[0]?.[0].body)).toContain("transaction_id=TX-1");
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
    apiVersion: "2.0",
    appId: "app-123",
    appSecret: "secret-xyz",
    baseUrl: "https://testapi.fadada.com:8443/api/",
    enabled: true,
    env: "sandbox",
    fullSigningSmokeEnabled: false,
    requestTimeoutMs: 15000,
    signUrlQuantity: 1,
    signUrlValidityMinutes: 30,
    ...overrides
  };
}

function minimalPdf() {
  return Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n", "utf8");
}
