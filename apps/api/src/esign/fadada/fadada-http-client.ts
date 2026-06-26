import { randomUUID } from "node:crypto";

import { FadadaConfig, FadadaRequest } from "./fadada.types";

export const FADADA_DISABLED = "FADADA_DISABLED";

export interface FadadaTransportRequest {
  body?: Buffer | string;
  headers: Record<string, string>;
  method: "GET" | "POST";
  responseType?: "arraybuffer" | "text";
  timeoutMs: number;
  url: string;
}

export interface FadadaHttpResponse {
  bodyText: string;
  headers: Record<string, string>;
  parsedBody?: Record<string, unknown>;
  status: number;
}

export interface FadadaBinaryHttpResponse {
  bodyBuffer: Buffer;
  bodyText: string;
  headers: Record<string, string>;
  status: number;
}

export type FadadaTransport = (request: FadadaTransportRequest) => Promise<{
  bodyBuffer?: Buffer;
  bodyText?: string;
  headers: Record<string, string>;
  status: number;
}>;

export interface FadadaMultipartFile {
  buffer: Buffer;
  contentType: "application/pdf";
  fieldName?: string;
  fileName: string;
}

export class FadadaHttpClient {
  constructor(
    private readonly config: FadadaConfig,
    private readonly transport: FadadaTransport = defaultFadadaTransport
  ) {}

  async send(request: FadadaRequest, file?: FadadaMultipartFile): Promise<FadadaHttpResponse> {
    if (!this.config.enabled) {
      throw new Error(`${FADADA_DISABLED}: FADADA_ENABLED must be true before sending Fadada HTTP requests`);
    }

    const transportRequest = buildTransportRequest(request, this.config.requestTimeoutMs, file);
    const response = await this.transport(transportRequest);
    const bodyText = response.bodyText ?? response.bodyBuffer?.toString("utf8") ?? "";

    return {
      ...response,
      bodyText,
      parsedBody: parseJsonObject(bodyText)
    };
  }

  async sendBinary(request: FadadaRequest): Promise<FadadaBinaryHttpResponse> {
    if (!this.config.enabled) {
      throw new Error(`${FADADA_DISABLED}: FADADA_ENABLED must be true before sending Fadada HTTP requests`);
    }

    const transportRequest = {
      ...buildTransportRequest(request, this.config.requestTimeoutMs),
      responseType: "arraybuffer" as const
    };
    const response = await this.transport(transportRequest);
    const bodyBuffer = response.bodyBuffer ?? Buffer.from(response.bodyText ?? "", "utf8");

    return {
      ...response,
      bodyBuffer,
      bodyText: response.bodyText ?? bodyBuffer.toString("utf8")
    };
  }
}

export const defaultFadadaTransport: FadadaTransport = async (request) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs);

  try {
    const response = await fetch(request.url, {
      body: request.body as never,
      headers: request.headers,
      method: request.method,
      signal: controller.signal
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    if (request.responseType === "arraybuffer") {
      return {
        bodyBuffer: Buffer.from(await response.arrayBuffer()),
        bodyText: "",
        headers,
        status: response.status
      };
    }

    return {
      bodyText: await response.text(),
      headers,
      status: response.status
    };
  } finally {
    clearTimeout(timeout);
  }
};

function buildTransportRequest(
  request: FadadaRequest,
  timeoutMs: number,
  file?: FadadaMultipartFile
): FadadaTransportRequest {
  if (request.contentType === "multipart/form-data;charset=utf8") {
    const multipart = buildMultipartBody(request.params, file);
    return {
      body: multipart.body,
      headers: { "content-type": `multipart/form-data; boundary=${multipart.boundary}` },
      method: request.method,
      timeoutMs,
      url: request.url
    };
  }

  if (request.method === "GET") {
    const url = new URL(request.url);
    for (const [key, value] of Object.entries(request.params)) {
      url.searchParams.set(key, value);
    }

    return {
      body: undefined,
      headers: {},
      method: request.method,
      timeoutMs,
      url: url.toString()
    };
  }

  return {
    body: new URLSearchParams(request.params).toString(),
    headers: { "content-type": request.contentType },
    method: request.method,
    timeoutMs,
    url: request.url
  };
}

function buildMultipartBody(params: Record<string, string>, file?: FadadaMultipartFile) {
  const boundary = `----subscription-saas-fadada-${randomUUID()}`;
  const chunks: Buffer[] = [];

  for (const [key, value] of Object.entries(params)) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, "utf8"));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${escapeMultipartName(key)}"\r\n\r\n`, "utf8"));
    chunks.push(Buffer.from(`${value}\r\n`, "utf8"));
  }

  if (file) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, "utf8"));
    chunks.push(Buffer.from(
      `Content-Disposition: form-data; name="${escapeMultipartName(file.fieldName ?? "file")}"; filename="${escapeMultipartName(file.fileName)}"\r\n`,
      "utf8"
    ));
    chunks.push(Buffer.from(`Content-Type: ${file.contentType}\r\n\r\n`, "utf8"));
    chunks.push(file.buffer);
    chunks.push(Buffer.from("\r\n", "utf8"));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));

  return {
    body: Buffer.concat(chunks),
    boundary
  };
}

function parseJsonObject(bodyText: string) {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function escapeMultipartName(value: string) {
  return value.replace(/["\r\n]/g, "_");
}
