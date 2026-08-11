import type { PortalCustomerProfile } from "./portal-types";

export interface PortalProfileFormValues {
  emergencyContactMobile: string;
  emergencyContactName: string;
  idCardNo?: string;
  name: string;
  residenceDetail: string;
  residenceRegion: string[];
}

export interface PortalProfileUpdatePayload {
  emergencyContactMobile: string;
  emergencyContactName: string;
  idCardNo?: string;
  name: string;
  residenceCity: string;
  residenceDetail: string;
  residenceDistrict: string;
  residenceProvince: string;
}

export function toPortalProfileFormValues(
  profile: PortalCustomerProfile
): PortalProfileFormValues {
  const residenceRegion = [
    profile.residenceProvince,
    profile.residenceCity,
    profile.residenceDistrict
  ].filter((value): value is string => Boolean(value));

  return {
    emergencyContactMobile: profile.emergencyContactMobile ?? "",
    emergencyContactName: profile.emergencyContactName ?? "",
    idCardNo: undefined,
    name: profile.name,
    residenceDetail: profile.residenceDetail ?? "",
    residenceRegion: residenceRegion.length === 3 ? residenceRegion : []
  };
}

export function toPortalProfileUpdatePayload(
  values: PortalProfileFormValues,
  idCardNoPresent = false
): PortalProfileUpdatePayload {
  const region = values.residenceRegion.map((value) => value.trim());
  if (region.length !== 3 || region.some((value) => !value)) {
    throw new Error("PROFILE_REGION_REQUIRED");
  }
  const idCardNo = values.idCardNo?.trim();

  return {
    emergencyContactMobile: values.emergencyContactMobile.trim(),
    emergencyContactName: values.emergencyContactName.trim(),
    ...(!idCardNo && idCardNoPresent ? {} : { idCardNo }),
    name: values.name.trim(),
    residenceCity: region[1]!,
    residenceDetail: values.residenceDetail.trim(),
    residenceDistrict: region[2]!,
    residenceProvince: region[0]!
  };
}
