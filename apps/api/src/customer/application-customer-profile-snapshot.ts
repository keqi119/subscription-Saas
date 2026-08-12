import {
  type CustomerApplicationProfileSource,
  normalizeCustomerApplicationProfile
} from "./customer-application-profile-readiness";

export interface ApplicationCustomerProfileSnapshot {
  capturedAt: string;
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
  snapshotVersion: number;
  source: "CUSTOMER_PORTAL_PROFILE";
}

export function buildApplicationCustomerProfileSnapshot(
  source: CustomerApplicationProfileSource,
  previousSnapshot: unknown,
  capturedAt: Date
): ApplicationCustomerProfileSnapshot {
  const profile = normalizeCustomerApplicationProfile(source);

  return {
    capturedAt: capturedAt.toISOString(),
    customerId: profile.customerId,
    emergencyContactMobile: profile.emergencyContactMobile,
    emergencyContactName: profile.emergencyContactName,
    idCardNo: profile.idCardNo,
    mobile: profile.mobile,
    name: profile.name,
    residenceAddress: profile.residenceAddress,
    residenceCity: profile.residenceCity,
    residenceDetail: profile.residenceDetail,
    residenceDistrict: profile.residenceDistrict,
    residenceProvince: profile.residenceProvince,
    snapshotVersion: previousSnapshotVersion(previousSnapshot) + 1,
    source: "CUSTOMER_PORTAL_PROFILE"
  };
}

export function parseApplicationCustomerProfileSnapshot(
  value: unknown
): ApplicationCustomerProfileSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const snapshot = value as Record<string, unknown>;
  if (
    snapshot.source !== "CUSTOMER_PORTAL_PROFILE" ||
    typeof snapshot.snapshotVersion !== "number" ||
    !Number.isInteger(snapshot.snapshotVersion) ||
    snapshot.snapshotVersion < 1
  ) {
    return null;
  }
  const requiredStrings = [
    "capturedAt",
    "customerId",
    "emergencyContactMobile",
    "emergencyContactName",
    "idCardNo",
    "mobile",
    "name",
    "residenceAddress",
    "residenceCity",
    "residenceDetail",
    "residenceDistrict",
    "residenceProvince"
  ] as const;
  if (requiredStrings.some((key) => typeof snapshot[key] !== "string")) {
    return null;
  }
  return snapshot as unknown as ApplicationCustomerProfileSnapshot;
}

function previousSnapshotVersion(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return 0;
  }
  const version = (value as Record<string, unknown>).snapshotVersion;
  return typeof version === "number" && Number.isInteger(version) && version > 0
    ? version
    : 0;
}
