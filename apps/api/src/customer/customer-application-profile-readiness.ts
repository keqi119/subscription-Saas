import { BadRequestException } from "@nestjs/common";

import {
  buildCustomerIdentityProfileReadiness,
  type CustomerIdentityProfileFieldIssue,
  type CustomerIdentityProfileSource,
  isValidMainlandMobile,
  normalizeIdCardNo,
  normalizeMobile,
  normalizeProfileText
} from "./customer-identity-readiness";

export const CUSTOMER_APPLICATION_PROFILE_INCOMPLETE =
  "CUSTOMER_APPLICATION_PROFILE_INCOMPLETE";
export const CUSTOMER_APPLICATION_PROFILE_INVALID = "CUSTOMER_APPLICATION_PROFILE_INVALID";

export type CustomerApplicationProfileFieldKey =
  | "name"
  | "mobile"
  | "idCardNo"
  | "residenceProvince"
  | "residenceCity"
  | "residenceDistrict"
  | "residenceDetail"
  | "emergencyContactName"
  | "emergencyContactMobile";

export interface CustomerApplicationProfileFieldIssue {
  key: CustomerApplicationProfileFieldKey;
  label: string;
  reason: CustomerIdentityProfileFieldIssue["reason"];
}

export interface CustomerApplicationProfileReadiness {
  complete: boolean;
  missingFields: CustomerApplicationProfileFieldIssue[];
}

export interface CustomerApplicationProfileSource extends CustomerIdentityProfileSource {
  id: string;
  profile?: {
    emergencyContactMobile?: null | string;
    emergencyContactName?: null | string;
    residenceCity?: null | string;
    residenceDetail?: null | string;
    residenceDistrict?: null | string;
    residenceProvince?: null | string;
  } | null;
}

export interface NormalizedCustomerApplicationProfile {
  customerId: string;
  emergencyContactMobile: string;
  emergencyContactName: string;
  idCardNo: string;
  mobile: string;
  name: string;
  residenceAddress: string;
  residenceCity: string;
  residenceDetail: string;
  residenceDistrict: string;
  residenceProvince: string;
}

type ProfileFieldKey = Exclude<
  CustomerApplicationProfileFieldKey,
  "idCardNo" | "mobile" | "name"
>;

const PROFILE_FIELD_KEYS: ProfileFieldKey[] = [
  "residenceProvince",
  "residenceCity",
  "residenceDistrict",
  "residenceDetail",
  "emergencyContactName",
  "emergencyContactMobile"
];

const PROFILE_FIELD_LABELS: Record<ProfileFieldKey, string> = {
  emergencyContactMobile: "Emergency contact mobile",
  emergencyContactName: "Emergency contact name",
  residenceCity: "Residence city",
  residenceDetail: "Residence detail",
  residenceDistrict: "Residence district",
  residenceProvince: "Residence province"
};

export function buildCustomerApplicationProfileReadiness(
  source: CustomerApplicationProfileSource
): CustomerApplicationProfileReadiness {
  const identity = buildCustomerIdentityProfileReadiness(source);
  const missingFields: CustomerApplicationProfileFieldIssue[] =
    identity.missingFields.map((item) => ({ ...item }));
  const mobile = normalizeMobile(source.mobile);
  const profileFields = normalizedProfileFields(source.profile);

  for (const key of PROFILE_FIELD_KEYS) {
    if (!profileFields[key]) {
      missingFields.push(profileIssue(key, "MISSING"));
    }
  }

  if (
    profileFields.emergencyContactMobile &&
    (!isValidMainlandMobile(profileFields.emergencyContactMobile) ||
      profileFields.emergencyContactMobile === mobile)
  ) {
    missingFields.push(profileIssue("emergencyContactMobile", "INVALID"));
  }

  return {
    complete: missingFields.length === 0,
    missingFields
  };
}

export function assertCustomerApplicationProfileReady(
  source: CustomerApplicationProfileSource
) {
  const readiness = buildCustomerApplicationProfileReadiness(source);
  if (!readiness.complete) {
    const details = readiness.missingFields
      .map((field) => `${field.key}:${field.reason}`)
      .join(",");
    throw new BadRequestException(
      `${CUSTOMER_APPLICATION_PROFILE_INCOMPLETE}: required customer application profile is incomplete or invalid (${details})`
    );
  }
  return readiness;
}

export function normalizeCustomerApplicationProfile(
  source: CustomerApplicationProfileSource
): NormalizedCustomerApplicationProfile {
  assertCustomerApplicationProfileReady(source);
  const profile = normalizedProfileFields(source.profile);

  return {
    customerId: source.id,
    emergencyContactMobile: profile.emergencyContactMobile!,
    emergencyContactName: profile.emergencyContactName!,
    idCardNo: normalizeIdCardNo(source.identity?.idCardNo)!,
    mobile: normalizeMobile(source.mobile)!,
    name: normalizeProfileText(source.name)!,
    residenceAddress: formatResidenceAddress(profile),
    residenceCity: profile.residenceCity!,
    residenceDetail: profile.residenceDetail!,
    residenceDistrict: profile.residenceDistrict!,
    residenceProvince: profile.residenceProvince!
  };
}

export function formatResidenceAddress(profile: {
  residenceCity?: null | string;
  residenceDetail?: null | string;
  residenceDistrict?: null | string;
  residenceProvince?: null | string;
}) {
  const province = normalizeProfileText(profile.residenceProvince) ?? "";
  const city = normalizeProfileText(profile.residenceCity) ?? "";
  const district = normalizeProfileText(profile.residenceDistrict) ?? "";
  const detail = normalizeProfileText(profile.residenceDetail) ?? "";
  const address = [province, city === province ? "" : city, district, detail].join("");

  if (address.length > 255) {
    throw new BadRequestException(
      `${CUSTOMER_APPLICATION_PROFILE_INVALID}: composed residence address exceeds 255 characters`
    );
  }
  return address;
}

function normalizedProfileFields(profile: CustomerApplicationProfileSource["profile"]) {
  return {
    emergencyContactMobile: normalizeMobile(profile?.emergencyContactMobile),
    emergencyContactName: normalizeProfileText(profile?.emergencyContactName),
    residenceCity: normalizeProfileText(profile?.residenceCity),
    residenceDetail: normalizeProfileText(profile?.residenceDetail),
    residenceDistrict: normalizeProfileText(profile?.residenceDistrict),
    residenceProvince: normalizeProfileText(profile?.residenceProvince)
  };
}

function profileIssue(
  key: ProfileFieldKey,
  reason: CustomerApplicationProfileFieldIssue["reason"]
): CustomerApplicationProfileFieldIssue {
  return {
    key,
    label: PROFILE_FIELD_LABELS[key],
    reason
  };
}
