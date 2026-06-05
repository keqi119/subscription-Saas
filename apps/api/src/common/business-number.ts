import { randomInt } from "node:crypto";

export const BUSINESS_NO_RETRY_LIMIT = 3;

const RANDOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function createBusinessNo(prefix: string, now = new Date(), randomCode = createRandomCode) {
  return `${prefix}${formatDateTime(now)}${randomCode()}`;
}

export async function withUniqueBusinessNoRetry<T>(
  operation: () => Promise<T>,
  maxAttempts = BUSINESS_NO_RETRY_LIMIT
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isUniqueConstraintError(error) || attempt === maxAttempts) {
        throw error;
      }
    }
  }

  throw new Error("Business number retry exhausted.");
}

function createRandomCode(length = 4) {
  let code = "";
  for (let index = 0; index < length; index += 1) {
    code += RANDOM_ALPHABET[randomInt(RANDOM_ALPHABET.length)];
  }
  return code;
}

function formatDateTime(date: Date) {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds())
  ].join("");
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function isUniqueConstraintError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
