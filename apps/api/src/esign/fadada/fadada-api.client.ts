import {
  buildAccountRegisterRequest,
  buildApplyCertRequest,
  buildFindPersonCertInfoRequest,
  buildPersonVerifyUrlRequest,
  buildContractFilingRequest,
  buildContractStatusRequest,
  buildDownloadContractRequest,
  buildExtSignAutoRequest,
  buildFadadaRequest,
  buildQuerySignResultRequest,
  FADADA_ENDPOINTS
} from "./fadada-request-builder";
import type { AutoSealPlacement } from "../esign.provider";
import { FadadaHttpClient } from "./fadada-http-client";
import { FadadaConfig } from "./fadada.types";

export const FADADA_UPLOAD_FILE_TOO_LARGE = "FADADA_UPLOAD_FILE_TOO_LARGE";
export const FADADA_UPLOAD_REQUIRES_PDF = "FADADA_UPLOAD_REQUIRES_PDF";
export const FADADA_SIGN_URL_MISSING = "FADADA_SIGN_URL_MISSING";
export const FADADA_DOWNLOAD_REQUIRES_PDF = "FADADA_DOWNLOAD_REQUIRES_PDF";
export const FADADA_ACCOUNT_CUSTOMER_ID_MISSING = "FADADA_ACCOUNT_CUSTOMER_ID_MISSING";
export const FADADA_PERSON_VERIFY_URL_MISSING = "FADADA_PERSON_VERIFY_URL_MISSING";

const MAX_FADADA_PDF_BYTES = 20 * 1024 * 1024;

export class FadadaApiClient {
  constructor(
    private readonly config: FadadaConfig,
    private readonly httpClient: FadadaHttpClient
  ) {}

  async registerAccount(input: {
    accountType: "PERSONAL";
    openId: string;
  }): Promise<{
    openId: string;
    providerCustomerId: string;
    raw: unknown;
    resultCode?: string;
    resultDesc?: string;
  }> {
    const request = buildAccountRegisterRequest({
      businessParams: {
        account_type: input.accountType === "PERSONAL" ? "1" : input.accountType,
        open_id: input.openId
      },
      config: this.config
    });
    const response = await this.httpClient.send(request);
    assertHttpOk(response.status);
    const raw = response.parsedBody ?? response.bodyText;
    const providerCustomerId = stringField(raw, ["data", "customer_id", "customerId"]);

    if (!providerCustomerId) {
      throw new Error(`${FADADA_ACCOUNT_CUSTOMER_ID_MISSING}: account_register.api response did not include customer_id`);
    }

    return {
      openId: input.openId,
      providerCustomerId,
      raw,
      resultCode: providerCode(raw),
      resultDesc: providerMsg(raw)
    };
  }

  async getPersonVerifyUrl(input: {
    certFlag?: boolean;
    customerId: string;
    idCardNo: string;
    mobile: string;
    name: string;
    notifyUrl: string;
    option?: string;
    pageModify?: string;
    returnUrl: string;
    verifiedWay?: string;
  }): Promise<{
    customerId: string;
    raw: unknown;
    resultCode?: string;
    resultDesc?: string;
    transactionNo?: string;
    verifyUrl: string;
  }> {
    const request = buildPersonVerifyUrlRequest({
      businessParams: {
        cert_flag: input.certFlag === false ? "0" : "1",
        customer_id: input.customerId,
        customer_ident_no: input.idCardNo,
        customer_ident_type: "0",
        customer_name: input.name,
        mobile: input.mobile,
        notify_url: input.notifyUrl,
        option: input.option ?? "add",
        page_modify: input.pageModify ?? "1",
        return_url: input.returnUrl,
        verified_way: input.verifiedWay ?? "1"
      },
      config: this.config
    });
    const response = await this.httpClient.send(request);
    assertHttpOk(response.status);
    const raw = response.parsedBody ?? response.bodyText;
    const encodedUrl = stringField(raw, ["url"]);
    const verifyUrl = decodeFadadaBase64Url(encodedUrl);

    if (!verifyUrl) {
      throw new Error(`${FADADA_PERSON_VERIFY_URL_MISSING}: get_person_verify_url.api response did not include verification URL`);
    }

    return {
      customerId: input.customerId,
      raw,
      resultCode: providerCode(raw),
      resultDesc: providerMsg(raw),
      transactionNo: stringField(raw, ["transactionNo", "transaction_no"]),
      verifyUrl
    };
  }

  async findPersonCertInfo(input: {
    verifiedSerialNo: string;
  }): Promise<{
    raw: unknown;
    realNameStatus?: string;
    resultCode?: string;
    resultDesc?: string;
    verifiedSerialNo: string;
  }> {
    const request = buildFindPersonCertInfoRequest({
      businessParams: {
        verified_serialno: input.verifiedSerialNo
      },
      config: this.config
    });
    const response = await this.httpClient.send(request);
    assertHttpOk(response.status);
    const raw = response.parsedBody ?? response.bodyText;

    return {
      raw,
      realNameStatus: stringField(raw, ["status", "certStatus", "cert_status", "realNameStatus"]),
      resultCode: providerCode(raw),
      resultDesc: providerMsg(raw),
      verifiedSerialNo: input.verifiedSerialNo
    };
  }

  async applyCert(input: {
    customerId: string;
    verifiedSerialNo: string;
  }): Promise<{
    customerId: string;
    raw: unknown;
    resultCode?: string;
    resultDesc?: string;
    verifiedSerialNo: string;
  }> {
    const request = buildApplyCertRequest({
      businessParams: {
        customer_id: input.customerId,
        verified_serialno: input.verifiedSerialNo
      },
      config: this.config
    });
    const response = await this.httpClient.send(request);
    assertHttpOk(response.status);
    const raw = response.parsedBody ?? response.bodyText;

    return {
      customerId: input.customerId,
      raw,
      resultCode: providerCode(raw),
      resultDesc: providerMsg(raw),
      verifiedSerialNo: input.verifiedSerialNo
    };
  }

  async uploadDocs(input: {
    contractId: string;
    docTitle: string;
    pdf: Buffer;
    fileName: string;
  }): Promise<{
    contractId: string;
    providerDocumentId?: string;
    raw: unknown;
  }> {
    assertPdf(input.pdf, input.fileName);

    const request = buildFadadaRequest({
      businessParams: {
        contract_id: input.contractId,
        doc_title: input.docTitle,
        doc_type: ".pdf"
      },
      config: this.config,
      contentType: "multipart/form-data;charset=utf8",
      endpoint: FADADA_ENDPOINTS.uploadDocs,
      explicitSortString: input.contractId
    });
    const response = await this.httpClient.send(request, {
      buffer: input.pdf,
      contentType: "application/pdf",
      fileName: input.fileName
    });
    assertHttpOk(response.status);
    const raw = response.parsedBody ?? response.bodyText;

    return {
      contractId: input.contractId,
      providerDocumentId: stringField(raw, ["doc_id", "document_id", "providerDocumentId"]),
      raw
    };
  }

  async createExternalSignUrl(input: {
    contractId: string;
    customerId: string;
    docTitle: string;
    transactionId: string;
    returnUrl: string;
    notifyUrl: string;
    validityMinutes?: number;
    quantity?: number;
    signerName?: string;
    signerMobile?: string;
  }): Promise<{
    transactionId: string;
    signUrl: string;
    signUrlExpiresAt?: Date;
    raw: unknown;
  }> {
    const validity = input.validityMinutes ?? this.config.signUrlValidityMinutes;
    const quantity = input.quantity ?? this.config.signUrlQuantity;
    const timestamp = fadadaTimestampNow();
    const request = buildFadadaRequest({
      businessParams: {
        contract_id: input.contractId,
        customer_id: input.customerId,
        doc_title: input.docTitle,
        notify_url: input.notifyUrl,
        quantity,
        return_url: input.returnUrl,
        transaction_id: input.transactionId,
        validity: validity,
        ...(input.signerName ? { signer_name: input.signerName } : {}),
        ...(input.signerMobile ? { signer_mobile: input.signerMobile } : {})
      },
      config: this.config,
      endpoint: FADADA_ENDPOINTS.extSignValidation,
      explicitMd5Seed: `${input.transactionId}${timestamp}${validity}${quantity}`,
      explicitSortString: input.customerId,
      method: "GET",
      timestamp
    });
    const signUrl = buildGetRequestUrl(request.url, request.params);

    return {
      raw: {
        endpoint: request.endpoint,
        method: request.method,
        pageInterface: true
      },
      signUrl,
      signUrlExpiresAt: new Date(Date.now() + Math.max(validity, 1) * 60_000),
      transactionId: input.transactionId
    };
  }

  async autoSealContract(input: {
    contractId: string;
    customerId: string;
    docTitle?: string;
    notifyUrl?: string;
    placement?: AutoSealPlacement;
    signatureId: string;
    transactionId: string;
  }): Promise<{
    contractId: string;
    raw: unknown;
    resultCode?: string;
    resultDesc?: string;
    transactionId: string;
  }> {
    const request = buildExtSignAutoRequest({
      businessParams: {
        contract_id: input.contractId,
        customer_id: input.customerId,
        ...toFadadaAutoSealPlacementParams(input.placement),
        signature_id: input.signatureId,
        transaction_id: input.transactionId,
        ...(input.docTitle ? { doc_title: input.docTitle } : {}),
        ...(input.notifyUrl ? { notify_url: input.notifyUrl } : {})
      },
      config: this.config,
      explicitSortString: input.customerId
    });
    const response = await this.httpClient.send(request);
    assertHttpOk(response.status);
    const raw = response.parsedBody ?? response.bodyText;

    return {
      contractId: input.contractId,
      raw,
      resultCode: stringField(raw, ["result_code", "resultCode", "result", "code"]),
      resultDesc: stringField(raw, ["result_desc", "resultDesc", "message", "msg"]),
      transactionId: input.transactionId
    };
  }

  async querySignResult(input: {
    contractId: string;
    transactionId?: string;
  }): Promise<{
    contractId: string;
    downloadUrl?: string;
    raw: unknown;
    resultCode?: string;
    resultDesc?: string;
    transactionId?: string;
    viewPdfUrl?: string;
  }> {
    const request = buildQuerySignResultRequest({
      businessParams: {
        contract_id: input.contractId,
        ...(input.transactionId ? { transaction_id: input.transactionId } : {})
      },
      config: this.config
    });
    const response = await this.httpClient.send(request);
    assertHttpOk(response.status);
    const raw = response.parsedBody ?? response.bodyText;

    return {
      contractId: input.contractId,
      downloadUrl: stringField(raw, ["download_url", "downloadUrl"]),
      raw,
      resultCode: stringField(raw, ["result_code", "resultCode", "result"]),
      resultDesc: stringField(raw, ["result_desc", "resultDesc", "message", "msg"]),
      transactionId: input.transactionId,
      viewPdfUrl: stringField(raw, ["viewpdf_url", "viewPdfUrl", "view_pdf_url"])
    };
  }

  async queryContractStatus(input: {
    contractId: string;
  }): Promise<{
    contractId: string;
    raw: unknown;
    status?: string;
  }> {
    const request = buildContractStatusRequest({
      businessParams: { contract_id: input.contractId },
      config: this.config
    });
    const response = await this.httpClient.send(request);
    assertHttpOk(response.status);
    const raw = response.parsedBody ?? response.bodyText;

    return {
      contractId: input.contractId,
      raw,
      status: stringField(raw, ["contractStatus", "contract_status", "status"])
    };
  }

  async downloadSignedContract(input: {
    contractId: string;
    downloadUrl?: string;
  }): Promise<{
    buffer: Buffer;
    contentType: "application/pdf";
    fileName: string;
    raw?: unknown;
  }> {
    // B4 intentionally uses the official downLoadContract.api builder. Direct
    // temporary download_url handling remains gated until the HTTP method and
    // endpoint-specific digest behavior are confirmed in a real sandbox stage.
    const request = buildDownloadContractRequest({
      businessParams: { contract_id: input.contractId },
      config: this.config
    });
    const response = await this.httpClient.sendBinary(request);
    assertHttpOk(response.status);
    assertDownloadedPdf(response.bodyBuffer, headerValue(response.headers, "content-type"));

    return {
      buffer: response.bodyBuffer,
      contentType: "application/pdf",
      fileName: filenameFromContentDisposition(headerValue(response.headers, "content-disposition")) ??
        `${sanitizeFileName(input.contractId)}-signed.pdf`
    };
  }

  async createContractFiling(input: {
    contractId: string;
  }): Promise<{
    contractId: string;
    filingNo?: string;
    raw: unknown;
  }> {
    const request = buildContractFilingRequest({
      businessParams: { contract_id: input.contractId },
      config: this.config
    });
    const response = await this.httpClient.send(request);
    assertHttpOk(response.status);
    const raw = response.parsedBody ?? response.bodyText;

    return {
      contractId: input.contractId,
      filingNo: stringField(raw, ["filing_no", "filingNo", "record_no", "recordNo", "evidence_no", "evidenceNo"]),
      raw
    };
  }
}

function toFadadaAutoSealPlacementParams(placement?: AutoSealPlacement) {
  if (!placement) {
    return {};
  }
  const params: Record<string, string> = {
    position_type: "0",
    sign_keyword: placement.keyword
  };
  if (placement.keywordStrategy) {
    params.keyword_strategy = placement.keywordStrategy;
  }
  if (placement.searchIndex) {
    params.search_index = placement.searchIndex;
  }
  if (placement.keyx) {
    params.keyx = placement.keyx;
  }
  if (placement.keyy) {
    params.keyy = placement.keyy;
  }
  return params;
}

function assertPdf(pdf: Buffer, fileName: string) {
  if (pdf.length > MAX_FADADA_PDF_BYTES) {
    throw new Error(`${FADADA_UPLOAD_FILE_TOO_LARGE}: PDF must be <= 20MB`);
  }
  if (!fileName.toLowerCase().endsWith(".pdf") || !pdf.subarray(0, 5).equals(Buffer.from("%PDF-", "utf8"))) {
    throw new Error(`${FADADA_UPLOAD_REQUIRES_PDF}: uploaddocs.api accepts PDF files only`);
  }
}

function assertHttpOk(status: number) {
  if (status < 200 || status >= 300) {
    throw new Error(`FADADA_HTTP_ERROR: status ${status}`);
  }
}

function buildGetRequestUrl(baseUrl: string, params: Record<string, string>) {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function assertDownloadedPdf(buffer: Buffer, contentType?: string) {
  if (buffer.length > MAX_FADADA_PDF_BYTES) {
    throw new Error(`${FADADA_UPLOAD_FILE_TOO_LARGE}: signed PDF must be <= 20MB`);
  }
  const isPdfType = !contentType || contentType.toLowerCase().includes("application/pdf");
  if (!isPdfType || !buffer.subarray(0, 5).equals(Buffer.from("%PDF-", "utf8"))) {
    throw new Error(`${FADADA_DOWNLOAD_REQUIRES_PDF}: downLoadContract.api must return a PDF`);
  }
}

function stringField(raw: unknown, keys: string[]): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;

  for (const key of keys) {
    const direct = record[key];
    if (typeof direct === "string" && direct.trim()) {
      return direct;
    }
  }

  const data = record.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return stringField(data, keys);
  }

  for (const value of Object.values(record)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = stringField(value, keys);
      if (nested) {
        return nested;
      }
    }
  }

  return undefined;
}

function providerCode(raw: unknown) {
  return stringField(raw, ["code", "result_code", "result"]);
}

function providerMsg(raw: unknown) {
  return stringField(raw, ["msg", "message", "result_desc", "resultDesc"]);
}

function decodeFadadaBase64Url(value?: string) {
  if (!value) {
    return undefined;
  }
  try {
    return Buffer.from(decodeURIComponent(value), "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

function headerValue(headers: Record<string, string>, name: string) {
  const lower = name.toLowerCase();
  return headers[lower] ?? headers[name];
}

function filenameFromContentDisposition(value?: string) {
  if (!value) {
    return undefined;
  }
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  if (encoded) {
    return sanitizeFileName(decodeURIComponent(encoded));
  }
  const plain = /filename="?([^";]+)"?/i.exec(value)?.[1];
  return plain ? sanitizeFileName(plain) : undefined;
}

function sanitizeFileName(value: string) {
  return (value.replace(/[^\w.-]+/g, "_").slice(0, 120) || "contract").replace(/^\.+$/, "contract");
}

function fadadaTimestampNow() {
  const now = new Date();
  const parts = [
    now.getFullYear(),
    now.getMonth() + 1,
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds()
  ];

  return `${parts[0]}${parts
    .slice(1)
    .map((part) => `${part}`.padStart(2, "0"))
    .join("")}`;
}
