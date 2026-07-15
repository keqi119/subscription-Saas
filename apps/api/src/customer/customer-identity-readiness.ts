import { BadRequestException } from "@nestjs/common";

export const CUSTOMER_IDENTITY_PROFILE_INCOMPLETE = "CUSTOMER_IDENTITY_PROFILE_INCOMPLETE";
export const CUSTOMER_IDENTITY_PROFILE_INVALID = "CUSTOMER_IDENTITY_PROFILE_INVALID";
export const CUSTOMER_IDENTITY_PROFILE_MOBILE_MISMATCH = "CUSTOMER_IDENTITY_PROFILE_MOBILE_MISMATCH";

export type CustomerIdentityProfileFieldKey = "name" | "mobile" | "idCardNo";

export interface CustomerIdentityProfileFieldIssue {
  key: CustomerIdentityProfileFieldKey;
  label: string;
  reason: "INVALID" | "MISSING" | "PLACEHOLDER";
}

export interface CustomerIdentityProfileReadiness {
  complete: boolean;
  missingFields: CustomerIdentityProfileFieldIssue[];
}

export interface CustomerIdentityProfileSource {
  identity?: { idCardNo?: null | string } | null;
  mobile?: null | string;
  name?: null | string;
  sourceChannel?: null | string;
}

export interface CustomerApplicationIdentityInput {
  idCardNo?: null | string;
  mobile?: null | string;
  name?: null | string;
}

const FIELD_LABELS: Record<CustomerIdentityProfileFieldKey, string> = {
  idCardNo: "ID number",
  mobile: "Real-name mobile",
  name: "Name"
};

export function normalizeCustomerApplicationIdentityInput(
  input: CustomerApplicationIdentityInput
) {
  return {
    idCardNo: normalizeIdCardNo(input.idCardNo),
    mobile: normalizeMobile(input.mobile),
    name: normalizeProfileText(input.name)
  };
}

export function buildCustomerIdentityProfileReadiness(
  source: CustomerIdentityProfileSource
): CustomerIdentityProfileReadiness {
  const missingFields: CustomerIdentityProfileFieldIssue[] = [];
  const name = normalizeProfileText(source.name);
  const mobile = normalizeMobile(source.mobile);
  const idCardNo = normalizeIdCardNo(source.identity?.idCardNo);

  if (!name) {
    missingFields.push(issue("name", "MISSING"));
  } else if (isPortalPlaceholderName(name, mobile, source.sourceChannel)) {
    missingFields.push(issue("name", "PLACEHOLDER"));
  }

  if (!mobile) {
    missingFields.push(issue("mobile", "MISSING"));
  } else if (!isValidMainlandMobile(mobile)) {
    missingFields.push(issue("mobile", "INVALID"));
  }

  if (!idCardNo) {
    missingFields.push(issue("idCardNo", "MISSING"));
  } else if (!isValidMainlandIdCardNo(idCardNo)) {
    missingFields.push(issue("idCardNo", "INVALID"));
  }

  return {
    complete: missingFields.length === 0,
    missingFields
  };
}

export function assertCustomerIdentityProfileReady(source: CustomerIdentityProfileSource) {
  const readiness = buildCustomerIdentityProfileReadiness(source);
  if (!readiness.complete) {
    throw new BadRequestException(formatProfileError(CUSTOMER_IDENTITY_PROFILE_INCOMPLETE, readiness.missingFields));
  }
}

export function assertValidCustomerApplicationIdentityInput(input: CustomerApplicationIdentityInput) {
  const normalized = normalizeCustomerApplicationIdentityInput(input);
  const missingFields: CustomerIdentityProfileFieldIssue[] = [];

  if (!normalized.name) {
    missingFields.push(issue("name", "MISSING"));
  }
  if (!normalized.mobile) {
    missingFields.push(issue("mobile", "MISSING"));
  } else if (!isValidMainlandMobile(normalized.mobile)) {
    missingFields.push(issue("mobile", "INVALID"));
  }
  if (!normalized.idCardNo) {
    missingFields.push(issue("idCardNo", "MISSING"));
  } else if (!isValidMainlandIdCardNo(normalized.idCardNo)) {
    missingFields.push(issue("idCardNo", "INVALID"));
  }

  if (missingFields.length > 0) {
    throw new BadRequestException(formatProfileError(CUSTOMER_IDENTITY_PROFILE_INVALID, missingFields));
  }

  return normalized as { idCardNo: string; mobile: string; name: string };
}

export function assertPortalProfileMobileMatchesLogin(
  mobile: null | string | undefined,
  loginPhone: string
) {
  const normalizedMobile = normalizeMobile(mobile);
  const normalizedLoginPhone = normalizeMobile(loginPhone);
  if (normalizedMobile && normalizedLoginPhone && normalizedMobile !== normalizedLoginPhone) {
    throw new BadRequestException(
      `${CUSTOMER_IDENTITY_PROFILE_MOBILE_MISMATCH}: real-name mobile must match the verified login phone`
    );
  }
}

export function maskIdCardNo(idCardNo: null | string | undefined) {
  const normalized = normalizeIdCardNo(idCardNo);
  if (!normalized) {
    return null;
  }
  if (normalized.length <= 8) {
    return `${normalized.slice(0, 2)}****${normalized.slice(-2)}`;
  }
  return `${normalized.slice(0, 6)}********${normalized.slice(-4)}`;
}

export function normalizeIdCardNo(value: null | string | undefined) {
  const normalized = normalizeProfileText(value)?.toUpperCase();
  return normalized || null;
}

export function normalizeMobile(value: null | string | undefined) {
  const normalized = normalizeProfileText(value)?.replace(/[\s-]/g, "");
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith("+86") && normalized.length === 14) {
    return normalized.slice(3);
  }
  if (normalized.startsWith("0086") && normalized.length === 15) {
    return normalized.slice(4);
  }
  if (normalized.startsWith("86") && normalized.length === 13) {
    return normalized.slice(2);
  }
  return normalized;
}

export function isValidMainlandMobile(value: string) {
  return /^1\d{10}$/.test(value);
}

export function isValidMainlandIdCardNo(value: string) {
  return /^\d{17}[\dX]$/.test(value.toUpperCase());
}

function normalizeProfileText(value: null | string | undefined) {
  const normalized = value?.trim();
  return normalized || null;
}

function isPortalPlaceholderName(
  name: string,
  mobile: null | string,
  sourceChannel?: null | string
) {
  if (sourceChannel !== "portal" || !mobile) {
    return false;
  }
  return name.includes(maskPhone(mobile));
}

function maskPhone(phone: string) {
  return phone.replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

function issue(
  key: CustomerIdentityProfileFieldKey,
  reason: CustomerIdentityProfileFieldIssue["reason"]
): CustomerIdentityProfileFieldIssue {
  return {
    key,
    label: FIELD_LABELS[key],
    reason
  };
}

function formatProfileError(code: string, fields: CustomerIdentityProfileFieldIssue[]) {
  const details = fields.map((field) => `${field.key}:${field.reason}`).join(",");
  return `${code}: required customer identity profile is incomplete or invalid (${details})`;
}
