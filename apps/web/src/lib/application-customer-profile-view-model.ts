export const APPLICATION_DRIVING_QUALIFICATION_COPY =
  "驾驶资格以驾驶证材料人工审核结果为准";

export type ApplicationCustomerProfileDisplaySource =
  | "CURRENT"
  | "SNAPSHOT"
  | "HISTORICAL_CURRENT_FALLBACK";

export interface ApplicationCustomerProfileReadinessIssue {
  key: string;
  label?: string;
  reason: string;
}

export interface ApplicationCustomerProfileSnapshotView {
  capturedAt: string;
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
}

export interface ApplicationCustomerProfileDetail {
  customer: {
    identity?: { idCardNo?: string | null } | null;
    mobile: string;
    name: string;
    profile?: {
      emergencyContactMobile?: string | null;
      emergencyContactName?: string | null;
      residenceAddress?: string | null;
      residenceCity?: string | null;
      residenceDetail?: string | null;
      residenceDistrict?: string | null;
      residenceProvince?: string | null;
    } | null;
  };
  customerProfileDisplaySource: ApplicationCustomerProfileDisplaySource;
  customerProfileReadiness: {
    complete: boolean;
    missingFields: ApplicationCustomerProfileReadinessIssue[];
  };
  customerProfileSnapshot?: ApplicationCustomerProfileSnapshotView | null;
  customerProfileUpdatedAt?: string | null;
}

export interface ApplicationCustomerProfileView {
  address: string;
  capturedAt: string | null;
  emergencyContactMobile: string;
  emergencyContactName: string;
  idCardNo: string;
  missingFieldLabels: string[];
  mobile: string;
  name: string;
  profileComplete: boolean;
  sourceLabel: string;
}

const MISSING_FIELD_LABELS: Record<string, string> = {
  emergencyContactMobile: "紧急联系人手机号",
  emergencyContactName: "紧急联系人姓名",
  idCardNo: "身份证号",
  mobile: "登录手机号",
  name: "客户姓名",
  residenceCity: "居住城市",
  residenceDetail: "详细居住地址",
  residenceDistrict: "居住区县",
  residenceProvince: "居住省份"
};

export function buildApplicationCustomerProfileView(
  detail: ApplicationCustomerProfileDetail
): ApplicationCustomerProfileView {
  const snapshot = detail.customerProfileSnapshot ?? null;
  const usesSnapshot =
    detail.customerProfileDisplaySource === "SNAPSHOT" && snapshot !== null;
  const profile = detail.customer.profile;

  return {
    address: usesSnapshot
      ? displayText(snapshot.residenceAddress)
      : formatCurrentAddress(profile),
    capturedAt: usesSnapshot
      ? snapshot.capturedAt
      : detail.customerProfileUpdatedAt ?? null,
    emergencyContactMobile: displayText(
      usesSnapshot
        ? snapshot.emergencyContactMobile
        : profile?.emergencyContactMobile
    ),
    emergencyContactName: displayText(
      usesSnapshot ? snapshot.emergencyContactName : profile?.emergencyContactName
    ),
    idCardNo: displayText(
      usesSnapshot ? snapshot.idCardNo : detail.customer.identity?.idCardNo
    ),
    missingFieldLabels: detail.customerProfileReadiness.missingFields.map(
      (field) => MISSING_FIELD_LABELS[field.key] ?? field.label ?? field.key
    ),
    mobile: displayText(usesSnapshot ? snapshot.mobile : detail.customer.mobile),
    name: displayText(usesSnapshot ? snapshot.name : detail.customer.name),
    profileComplete: detail.customerProfileReadiness.complete,
    sourceLabel: sourceLabel(detail.customerProfileDisplaySource, snapshot)
  };
}

function formatCurrentAddress(
  profile: ApplicationCustomerProfileDetail["customer"]["profile"]
) {
  if (profile?.residenceAddress?.trim()) {
    return profile.residenceAddress.trim();
  }
  const province = profile?.residenceProvince?.trim() ?? "";
  const city = profile?.residenceCity?.trim() ?? "";
  const district = profile?.residenceDistrict?.trim() ?? "";
  const detail = profile?.residenceDetail?.trim() ?? "";
  return displayText([province, city === province ? "" : city, district, detail].join(""));
}

function sourceLabel(
  source: ApplicationCustomerProfileDisplaySource,
  snapshot: ApplicationCustomerProfileSnapshotView | null
) {
  if (source === "CURRENT") {
    return "客户当前资料";
  }
  if (source === "SNAPSHOT") {
    return snapshot ? `V${snapshot.snapshotVersion} 进件提交快照` : "进件提交快照";
  }
  return "历史记录，当前展示客户档案";
}

function displayText(value?: string | null) {
  return value?.trim() || "-";
}
