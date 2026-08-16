import {
  buildAccountRegisterRequest,
  buildApplyCertRequest,
  buildFindPersonCertInfoRequest,
  buildFindSerialNoRequest,
  buildPersonVerifyUrlRequest,
  buildContractFilingRequest,
  buildContractStatusRequest,
  buildDownloadContractRequest,
  buildFadadaRequest,
  buildQueryCertRequest,
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
export const FADADA_TRANSACTION_ID_INVALID = "FADADA_TRANSACTION_ID_INVALID";
export const FADADA_SIGNATURE_POSITIONS_INVALID = "FADADA_SIGNATURE_POSITIONS_INVALID";

const MAX_FADADA_PDF_BYTES = 20 * 1024 * 1024;
const FADADA_TRANSACTION_ID_PATTERN = /^[A-Za-z0-9]{1,32}$/;
const MAX_PROVIDER_JSON_PARSE_DEPTH = 3;

export interface FadadaManualSignPosition {
  pagenum: number;
  x: number;
  y: number;
}

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

  async queryCert(input: {
    customerId: string;
  }): Promise<{
    certBound: boolean;
    certSerialNo?: string;
    customerId: string;
    raw: unknown;
    resultCode?: string;
    resultDesc?: string;
  }> {
    const request = buildQueryCertRequest({
      businessParams: {
        customerId: input.customerId
      },
      config: this.config
    });
    const response = await this.httpClient.send(request);
    assertHttpOk(response.status);
    const raw = response.parsedBody ?? response.bodyText;
    const resultCode = providerCode(raw);
    const certEvidence = queryCertEvidence(raw);

    return {
      certBound: isProviderSuccess(resultCode) && certEvidence.complete,
      certSerialNo: certEvidence.certSerialNo,
      customerId: input.customerId,
      raw,
      resultCode,
      resultDesc: providerMsg(raw)
    };
  }

  async findRealNameSerialNumbers(input: {
    customerId: string;
  }): Promise<{
    bindSerialNo?: string;
    customerId: string;
    raw: unknown;
    resultCode?: string;
    resultDesc?: string;
    transactions: Array<{
      status?: string;
      transactionNo?: string;
      type?: string;
      verifyUrl?: string;
    }>;
  }> {
    const request = buildFindSerialNoRequest({
      businessParams: {
        customer_id: input.customerId
      },
      config: this.config
    });
    const response = await this.httpClient.send(request);
    assertHttpOk(response.status);
    const raw = response.parsedBody ?? response.bodyText;

    return {
      bindSerialNo: stringField(raw, ["bindSerialNo", "bind_serial_no"]),
      customerId: input.customerId,
      raw,
      resultCode: providerCode(raw),
      resultDesc: providerMsg(raw),
      transactions: objectArrayField(raw, ["transactionList", "transactions"]).map((item) => ({
        status: stringField(item, ["status"]),
        transactionNo: stringField(item, ["transactionNo", "transaction_no"]),
        type: stringField(item, ["type"]),
        verifyUrl: decodeFadadaBase64Url(stringField(item, ["url", "verifyUrl", "verify_url"]))
      }))
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
    signaturePositions?: FadadaManualSignPosition[];
    signerName?: string;
    signerMobile?: string;
  }): Promise<{
    transactionId: string;
    signUrl: string;
    signUrlExpiresAt?: Date;
    raw: unknown;
  }> {
    assertFadadaTransactionId(input.transactionId);
    const signaturePositions = normalizeManualSignPositions(input.signaturePositions);
    if (signaturePositions) {
      const timestamp = fadadaTimestampNow();
      const validity = input.validityMinutes ?? this.config.signUrlValidityMinutes;
      const serializedSignaturePositions = serializeManualSignPositions(signaturePositions);
      const request = buildFadadaRequest({
        businessParams: {
          contract_id: input.contractId,
          customer_id: input.customerId,
          doc_title: input.docTitle,
          notify_url: input.notifyUrl,
          position_type: "1",
          return_url: input.returnUrl,
          signature_positions: serializedSignaturePositions,
          transaction_id: input.transactionId,
          ...(input.signerName ? { signer_name: input.signerName } : {}),
          ...(input.signerMobile ? { signer_mobile: input.signerMobile } : {})
        },
        config: this.config,
        endpoint: FADADA_ENDPOINTS.extSign,
        explicitMd5Seed: `${input.transactionId}${timestamp}`,
        explicitSortString: input.customerId,
        method: "GET",
        timestamp
      });
      const signUrl = buildGetRequestUrl(request.url, request.params);

      return {
        raw: {
          endpoint: request.endpoint,
          method: request.method,
          pageInterface: true,
          signaturePositions: signaturePositions.length
        },
        signUrl,
        signUrlExpiresAt: new Date(Date.now() + Math.max(validity, 1) * 60_000),
        transactionId: input.transactionId
      };
    }

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
    signaturePositions?: FadadaManualSignPosition[];
    signatureId: string;
    transactionId: string;
  }): Promise<{
    contractId: string;
    raw: unknown;
    resultCode?: string;
    resultDesc?: string;
    transactionId: string;
  }> {
    assertFadadaTransactionId(input.transactionId);
    const timestamp = fadadaTimestampNow();
    const request = buildFadadaRequest({
      businessParams: {
        contract_id: input.contractId,
        customer_id: input.customerId,
        ...toFadadaAutoSealPlacementParams(input.placement, input.signaturePositions),
        signature_id: input.signatureId,
        transaction_id: input.transactionId,
        ...(input.docTitle ? { doc_title: input.docTitle } : {}),
        ...(input.notifyUrl ? { notify_url: input.notifyUrl } : {})
      },
      config: this.config,
      endpoint: FADADA_ENDPOINTS.extSignAuto,
      explicitMd5Seed: `${input.transactionId}${timestamp}`,
      explicitSortString: input.customerId,
      timestamp
    });
    const response = await this.httpClient.send(request);
    assertHttpOk(response.status);
    const raw = response.parsedBody ?? response.bodyText;

    return {
      contractId: input.contractId,
      raw,
      resultCode: providerCode(raw),
      resultDesc: stringField(raw, ["result_desc", "resultDesc", "message", "msg"]),
      transactionId: input.transactionId
    };
  }

  async querySignResult(input: {
    contractId: string;
    customerId?: string;
    transactionId?: string;
  }): Promise<{
    contractId: string;
    downloadUrl?: string;
    providerContractId?: string;
    providerCustomerId?: string;
    providerTransactionId?: string;
    raw: unknown;
    resultCode?: string;
    resultDesc?: string;
    status: "SIGNED" | "SIGNING" | "FAILED" | "UNKNOWN";
    transactionId?: string;
    viewPdfUrl?: string;
  }> {
    if (!input.customerId || !input.transactionId) {
      return {
        contractId: input.contractId,
        raw: {
          reason: !input.customerId
            ? "FADADA_QUERY_SIGN_RESULT_CUSTOMER_ID_MISSING"
            : "FADADA_QUERY_SIGN_RESULT_TRANSACTION_ID_MISSING",
          skipped: true
        },
        status: "UNKNOWN",
        transactionId: input.transactionId
      };
    }
    assertFadadaTransactionId(input.transactionId);
    const timestamp = fadadaTimestampNow();
    const request = buildFadadaRequest({
      businessParams: {
        contract_id: input.contractId,
        customer_id: input.customerId,
        transaction_id: input.transactionId
      },
      config: this.config,
      endpoint: FADADA_ENDPOINTS.querySignResult,
      explicitSortString: `${input.contractId}${input.customerId}${input.transactionId}`,
      timestamp
    });
    const response = await this.httpClient.send(request);
    assertHttpOk(response.status);
    const raw = response.parsedBody ?? response.bodyText;
    const resultCode = stringField(raw, ["result_code", "resultCode", "result"]);
    const resultDesc =
      nestedDataStringField(raw, ["result_desc", "resultDesc"]) ??
      stringField(raw, ["result_desc", "resultDesc", "message", "msg"]);

    return {
      contractId: input.contractId,
      downloadUrl: stringField(raw, ["download_url", "downloadUrl"]),
      providerContractId: stringField(raw, [
        "contract_id",
        "contractId"
      ]),
      providerCustomerId: stringField(raw, [
        "customer_id",
        "customerId"
      ]),
      providerTransactionId: stringField(raw, [
        "transaction_id",
        "transactionId"
      ]),
      raw,
      resultCode,
      resultDesc,
      status: mapQuerySignResultStatus(raw, resultCode),
      transactionId: input.transactionId,
      viewPdfUrl: stringField(raw, ["view_url", "viewUrl", "viewpdf_url", "viewPdfUrl", "view_pdf_url"])
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

function toFadadaAutoSealPlacementParams(
  placement?: AutoSealPlacement,
  signaturePositions?: FadadaManualSignPosition[]
) {
  if (signaturePositions !== undefined) {
    return {
      position_type: "1",
      signature_positions: JSON.stringify(normalizeManualSignPositions(signaturePositions))
    };
  }
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

function normalizeManualSignPositions(value: FadadaManualSignPosition[] | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${FADADA_SIGNATURE_POSITIONS_INVALID}: signature_positions must include at least one coordinate`);
  }

  return value.map((position) => {
    if (
      !Number.isInteger(position.pagenum) ||
      position.pagenum < 0 ||
      !isFiniteNumberInRange(position.x, 0, 800) ||
      !isFiniteNumberInRange(position.y, 0, 1131)
    ) {
      throw new Error(`${FADADA_SIGNATURE_POSITIONS_INVALID}: invalid SearchLocation coordinate`);
    }

    return {
      pagenum: position.pagenum,
      x: position.x,
      y: position.y
    };
  });
}

function serializeManualSignPositions(value: FadadaManualSignPosition[]) {
  return JSON.stringify(value.map((position) => ({
    pagenum: position.pagenum,
    x: position.x,
    y: position.y
  })));
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

export function isValidFadadaTransactionId(value: string) {
  return FADADA_TRANSACTION_ID_PATTERN.test(value);
}

export function assertFadadaTransactionId(value: string) {
  if (!isValidFadadaTransactionId(value)) {
    throw new Error(`${FADADA_TRANSACTION_ID_INVALID}: transaction_id must be 1-32 ASCII letters or digits`);
  }
}

function buildGetRequestUrl(baseUrl: string, params: Record<string, string>) {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function isFiniteNumberInRange(value: unknown, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
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
  return scalarField(raw, keys);
}

function nestedDataStringField(raw: unknown, keys: string[]): string | undefined {
  const record = recordField(raw);
  if (!record) {
    return undefined;
  }
  for (const data of nestedProviderRecords(record.data, 0)) {
    const nested = scalarField(data, keys);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function scalarField(
  raw: unknown,
  keys: string[],
  options: { acceptNumbers?: boolean } = {},
  seen = new WeakSet<object>(),
  depth = 0
): string | undefined {
  const record = recordField(raw);
  if (!record || seen.has(record)) {
    return undefined;
  }
  seen.add(record);

  for (const key of keys) {
    const direct = scalarToString(record[key], options);
    if (direct) {
      return direct;
    }
  }

  for (const data of nestedProviderRecords(record.data, depth)) {
    const nested = scalarField(data, keys, options, seen, depth + 1);
    if (nested) {
      return nested;
    }
  }

  for (const value of Object.values(record)) {
    if (value === record.data) {
      continue;
    }
    for (const nestedRecord of nestedProviderRecords(value, depth)) {
      const nested = scalarField(nestedRecord, keys, options, seen, depth + 1);
      if (nested) {
        return nested;
      }
    }
  }

  return undefined;
}

function providerCode(raw: unknown) {
  return scalarField(raw, ["code", "result_code", "result"], { acceptNumbers: true });
}

function providerMsg(raw: unknown) {
  return stringField(raw, ["msg", "message", "result_desc", "resultDesc"]);
}

function isProviderSuccess(code: string | undefined) {
  return code === "1" || code === "1000" || code === "success";
}

function queryCertEvidence(raw: unknown) {
  const certSerialNo = scalarField(raw, ["sequenceNo", "sequence_no", "serialNo", "certSerialNo"], {
    acceptNumbers: true
  });
  const dn = scalarField(raw, ["dn", "certDn", "cert_dn"]);
  const certType = scalarField(raw, ["certType", "cert_type"], { acceptNumbers: true });
  const startTime = scalarField(raw, ["startTime", "start_time", "validStartTime", "valid_start_time"], {
    acceptNumbers: true
  });
  const endTime = scalarField(raw, ["endTime", "end_time", "validEndTime", "valid_end_time"], {
    acceptNumbers: true
  });

  return {
    certSerialNo,
    complete: Boolean(certSerialNo && dn && certType && startTime && endTime)
  };
}

function objectArrayField(raw: unknown, keys: string[]): Array<Record<string, unknown>> {
  const record = recordField(raw);
  if (!record) {
    return [];
  }
  for (const key of keys) {
    const direct = record[key];
    if (Array.isArray(direct)) {
      return direct.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object" && !Array.isArray(item))
      );
    }
  }
  for (const data of nestedProviderRecords(record.data, 0)) {
    const nested = objectArrayField(data, keys);
    if (nested.length) {
      return nested;
    }
  }
  for (const value of Object.values(record)) {
    if (value === record.data) {
      continue;
    }
    for (const nestedRecord of nestedProviderRecords(value, 0)) {
      const nested = objectArrayField(nestedRecord, keys);
      if (nested.length) {
        return nested;
      }
    }
  }
  return [];
}

function scalarToString(value: unknown, options: { acceptNumbers?: boolean }) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (options.acceptNumbers && typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function recordField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nestedProviderRecords(value: unknown, depth: number) {
  const record = recordField(value);
  if (record) {
    return [record];
  }
  const parsed = parseJsonRecord(value, depth);
  return parsed ? [parsed] : [];
}

function parseJsonRecord(value: unknown, depth: number): Record<string, unknown> | undefined {
  if (depth >= MAX_PROVIDER_JSON_PARSE_DEPTH || typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }
  try {
    return recordField(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function mapQuerySignResultStatus(raw: unknown, resultCode: string | undefined): "SIGNED" | "SIGNING" | "FAILED" | "UNKNOWN" {
  switch (resultCode) {
    case "3000":
      return "SIGNED";
    case "3001":
    case "3002":
    case "3003":
      return "FAILED";
    default:
      break;
  }

  const signStatus = stringField(raw, ["sign_status", "signStatus"]);
  switch (signStatus) {
    case "0":
      return "SIGNING";
    case "1":
      return "SIGNED";
    case "2":
    case "3":
      return "FAILED";
    default:
      return "UNKNOWN";
  }
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
