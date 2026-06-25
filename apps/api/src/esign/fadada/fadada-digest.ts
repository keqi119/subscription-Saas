import { createHash, timingSafeEqual } from "node:crypto";

const PUBLIC_PARAM_KEYS = new Set(["app_id", "timestamp", "v", "msg_digest"]);

export function md5Upper(input: string): string {
  return createHash("md5").update(input, "utf8").digest("hex").toUpperCase();
}

export function sha1Upper(input: string): string {
  return createHash("sha1").update(input, "utf8").digest("hex").toUpperCase();
}

export function base64(input: Buffer | string): string {
  return Buffer.isBuffer(input) ? input.toString("base64") : Buffer.from(input, "utf8").toString("base64");
}

export function formatFadadaTimestamp(date: Date): string {
  const parts = [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds()
  ];

  return `${parts[0]}${parts
    .slice(1)
    .map((part) => `${part}`.padStart(2, "0"))
    .join("")}`;
}

export function sortBusinessParams(
  params: Record<string, string | number | boolean | null | undefined>
): string {
  return Object.entries(params)
    .filter(([key, value]) => !PUBLIC_PARAM_KEYS.has(key) && value !== null && value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([, value]) => String(value))
    .join("");
}

export function buildFadadaMsgDigest(input: {
  appId: string;
  appSecret: string;
  timestamp: string;
  businessParams?: Record<string, unknown>;
  explicitSortString?: string;
}): string {
  const sortString =
    input.explicitSortString ??
    sortBusinessParams(
      (input.businessParams ?? {}) as Record<string, string | number | boolean | null | undefined>
    );

  return buildFadadaMsgDigestFromParts({
    appId: input.appId,
    appSecret: input.appSecret,
    md5Seed: input.timestamp,
    secretSortString: sortString
  });
}

export function buildFadadaMsgDigestFromParts(input: {
  appId: string;
  appSecret: string;
  md5Seed: string;
  secretSortString: string;
}): string {
  return base64(sha1Upper(input.appId + md5Upper(input.md5Seed) + sha1Upper(input.appSecret + input.secretSortString)));
}

export function verifyFadadaCallbackDigest(input: {
  appId: string;
  appSecret: string;
  timestamp: string;
  receivedMsgDigest: string;
  businessParams: Record<string, unknown>;
  explicitSortString?: string;
}): boolean {
  if (!input.receivedMsgDigest) {
    return false;
  }

  const expected = buildFadadaMsgDigest({
    appId: input.appId,
    appSecret: input.appSecret,
    businessParams: input.businessParams,
    explicitSortString: input.explicitSortString,
    timestamp: input.timestamp
  });

  return constantTimeEqual(expected, input.receivedMsgDigest);
}

function constantTimeEqual(expected: string, received: string) {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(received, "utf8");

  if (expectedBuffer.length === receivedBuffer.length) {
    return timingSafeEqual(expectedBuffer, receivedBuffer);
  }

  const maxLength = Math.max(expectedBuffer.length, receivedBuffer.length);
  const paddedExpected = Buffer.alloc(maxLength);
  const paddedReceived = Buffer.alloc(maxLength);
  expectedBuffer.copy(paddedExpected);
  receivedBuffer.copy(paddedReceived);
  timingSafeEqual(paddedExpected, paddedReceived);

  return false;
}
