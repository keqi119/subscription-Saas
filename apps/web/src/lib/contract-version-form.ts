export type ContractTemplateType =
  | "DELIVERY_HANDOVER"
  | "SUBSCRIPTION_STANDARD"
  | "SUBSCRIPTION_EXTENSION";

export const DEFAULT_CONTRACT_TEMPLATE_TYPE: ContractTemplateType =
  "SUBSCRIPTION_STANDARD";

export const CONTRACT_TEMPLATE_TYPE_OPTIONS = [
  { label: "标准订阅合同", value: "SUBSCRIPTION_STANDARD" },
  { label: "车辆交接确认单", value: "DELIVERY_HANDOVER" },
  { label: "订阅续期补充协议", value: "SUBSCRIPTION_EXTENSION" }
] as const satisfies ReadonlyArray<{
  label: string;
  value: ContractTemplateType;
}>;

export interface ContractVersionCreatePayload {
  businessType: "SUBSCRIPTION";
  contentTemplate: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  templateName: string;
  templateType: ContractTemplateType;
  versionNo: string;
}

export function buildContractVersionCreatePayload(
  input: Omit<ContractVersionCreatePayload, "businessType">
): ContractVersionCreatePayload {
  return { businessType: "SUBSCRIPTION", ...input };
}

export function labelContractTemplateType(value: string) {
  return CONTRACT_TEMPLATE_TYPE_OPTIONS.find(
    (option) => option.value === value
  )?.label ?? value;
}
