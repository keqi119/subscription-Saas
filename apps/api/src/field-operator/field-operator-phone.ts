import { BadRequestException } from "@nestjs/common";

export function normalizeFieldOperatorPhone(phone: string) {
  const normalized = normalizePhoneForChinaMobile(phone);
  if (!/^1[3-9]\d{9}$/.test(normalized)) {
    throw new BadRequestException("Invalid field operator phone.");
  }
  return normalized;
}

export function normalizeOptionalFieldOperatorPhone(phone: null | string | undefined) {
  const trimmed = phone?.trim();
  return trimmed ? normalizeFieldOperatorPhone(trimmed) : null;
}

export function maskFieldOperatorPhone(phone: null | string | undefined) {
  if (!phone) {
    return null;
  }
  if (phone.length < 7) {
    return "***";
  }
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

function normalizePhoneForChinaMobile(phone: string) {
  const stripped = stripWrappingQuotes(phone).replace(/[\s-]/g, "");
  if (stripped.startsWith("+86") && stripped.length === 14) {
    return stripped.slice(3);
  }
  if (stripped.startsWith("0086") && stripped.length === 15) {
    return stripped.slice(4);
  }
  if (stripped.startsWith("86") && stripped.length === 13) {
    return stripped.slice(2);
  }
  return stripped;
}

function stripWrappingQuotes(value: string) {
  const trimmed = value.trim();
  const quotePairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"]
  ];

  for (const [left, right] of quotePairs) {
    if (trimmed.startsWith(left) && trimmed.endsWith(right)) {
      return trimmed.slice(left.length, -right.length).trim();
    }
  }

  return trimmed;
}
