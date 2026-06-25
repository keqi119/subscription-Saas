import {
  buildContractFilingRequest,
  buildContractStatusRequest,
  buildDownloadContractRequest,
  buildFadadaRequest,
  buildQuerySignResultRequest,
  FADADA_ENDPOINTS
} from "./fadada-request-builder";
import { FadadaHttpClient } from "./fadada-http-client";
import { FadadaConfig } from "./fadada.types";

export const FADADA_UPLOAD_FILE_TOO_LARGE = "FADADA_UPLOAD_FILE_TOO_LARGE";
export const FADADA_UPLOAD_REQUIRES_PDF = "FADADA_UPLOAD_REQUIRES_PDF";
export const FADADA_SIGN_URL_MISSING = "FADADA_SIGN_URL_MISSING";
export const FADADA_DOWNLOAD_REQUIRES_PDF = "FADADA_DOWNLOAD_REQUIRES_PDF";

const MAX_FADADA_PDF_BYTES = 20 * 1024 * 1024;

export class FadadaApiClient {
  constructor(
    private readonly config: FadadaConfig,
    private readonly httpClient: FadadaHttpClient
  ) {}

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
      timestamp
    });
    const response = await this.httpClient.send(request);
    assertHttpOk(response.status);
    const raw = response.parsedBody ?? response.bodyText;
    const signUrl = stringField(raw, ["sign_url", "signUrl", "url"]);

    if (!signUrl) {
      throw new Error(`${FADADA_SIGN_URL_MISSING}: extsign_validation.api response did not include sign URL`);
    }

    return {
      raw,
      signUrl,
      signUrlExpiresAt: new Date(Date.now() + Math.max(validity, 1) * 60_000),
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

  return undefined;
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
