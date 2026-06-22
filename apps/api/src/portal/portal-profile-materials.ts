import {
  ApplicationMaterialType,
  CustomerProfileMaterialStatus,
  CustomerProfileMaterialType
} from "@prisma/client";

export interface CustomerProfileMaterialRequirement {
  label: string;
  required: boolean;
  type: CustomerProfileMaterialType;
}

export interface CustomerProfileMaterialCompleteness {
  canSubmit: boolean;
  complete: boolean;
  completedCount: number;
  missingMaterials: Array<{
    label: string;
    type: CustomerProfileMaterialType;
  }>;
  requiredCount: number;
  stronglyRecommendedUploadBeforeSubmit: boolean;
}

export const CUSTOMER_PROFILE_MATERIAL_REQUIREMENTS: CustomerProfileMaterialRequirement[] = [
  { label: "身份证人像面", required: true, type: CustomerProfileMaterialType.ID_CARD_FRONT },
  { label: "身份证国徽面", required: true, type: CustomerProfileMaterialType.ID_CARD_BACK },
  { label: "驾驶证主页", required: true, type: CustomerProfileMaterialType.DRIVER_LICENSE_FRONT },
  { label: "驾驶证副页", required: true, type: CustomerProfileMaterialType.DRIVER_LICENSE_BACK }
];

export const CUSTOMER_PROFILE_MATERIAL_LABELS: Record<CustomerProfileMaterialType, string> = {
  DRIVER_LICENSE_BACK: "驾驶证副页",
  DRIVER_LICENSE_FRONT: "驾驶证主页",
  ID_CARD_BACK: "身份证国徽面",
  ID_CARD_FRONT: "身份证人像面",
  OTHER: "其他资料"
};

export const CUSTOMER_PROFILE_MATERIAL_STATUS_LABELS: Record<CustomerProfileMaterialStatus, string> = {
  ACTIVE: "当前有效",
  ARCHIVED: "已归档",
  REPLACED: "已替换"
};

export function buildCustomerProfileMaterialCompleteness(
  materials: Array<{
    deletedAt?: Date | null;
    materialStatus: CustomerProfileMaterialStatus;
    materialType: CustomerProfileMaterialType;
  }>
): CustomerProfileMaterialCompleteness {
  const activeTypes = new Set(
    materials
      .filter((material) => material.materialStatus === CustomerProfileMaterialStatus.ACTIVE && !material.deletedAt)
      .map((material) => material.materialType)
  );
  const missingMaterials = CUSTOMER_PROFILE_MATERIAL_REQUIREMENTS
    .filter((requirement) => !activeTypes.has(requirement.type))
    .map((requirement) => ({
      label: requirement.label,
      type: requirement.type
    }));
  const requiredCount = CUSTOMER_PROFILE_MATERIAL_REQUIREMENTS.length;
  const completedCount = requiredCount - missingMaterials.length;
  const complete = missingMaterials.length === 0;

  return {
    canSubmit: true,
    complete,
    completedCount,
    missingMaterials,
    requiredCount,
    stronglyRecommendedUploadBeforeSubmit: !complete
  };
}

export function getCustomerProfileMaterialLabel(type: CustomerProfileMaterialType) {
  return CUSTOMER_PROFILE_MATERIAL_LABELS[type] ?? type;
}

export function toApplicationMaterialType(type: CustomerProfileMaterialType): ApplicationMaterialType {
  if (
    type === CustomerProfileMaterialType.ID_CARD_FRONT ||
    type === CustomerProfileMaterialType.ID_CARD_BACK
  ) {
    return ApplicationMaterialType.ID_CARD;
  }

  if (
    type === CustomerProfileMaterialType.DRIVER_LICENSE_FRONT ||
    type === CustomerProfileMaterialType.DRIVER_LICENSE_BACK
  ) {
    return ApplicationMaterialType.DRIVER_LICENSE;
  }

  return ApplicationMaterialType.OTHER;
}

export function isAllowedCustomerProfileMaterialMimeType(mimeType?: string | null) {
  if (!mimeType) {
    return false;
  }
  return mimeType.startsWith("image/") || mimeType === "application/pdf";
}

export function isCustomerProfileMaterialObjectKey(objectKey?: string | null) {
  return Boolean(objectKey?.startsWith("customer-profile-materials/"));
}
