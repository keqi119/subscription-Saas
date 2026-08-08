import type { PortalCatalogVehicle } from "../../../lib/portal-types";

export interface PortalCatalogTag {
  color?: "blue" | "green";
  label: string;
}

export function buildPortalCatalogTitle(vehicle: PortalCatalogVehicle) {
  const preferred =
    cleanText(vehicle.shortTitle) ?? cleanText(vehicle.modelDefinition?.customerDisplayName);
  if (preferred) {
    return preferred;
  }

  const internalCode =
    cleanText(vehicle.modelCode) ?? cleanText(vehicle.modelDefinition?.modelCode);
  for (const candidate of [vehicle.customerModelDisplayName, vehicle.displayName]) {
    const compatible = safeCompatibleTitle(candidate, internalCode);
    if (compatible) {
      return compatible;
    }
  }

  return buildStructuredTitle(vehicle) ?? "待确认车型";
}

export function buildPortalCatalogTags(vehicle: PortalCatalogVehicle): PortalCatalogTag[] {
  const conditionGrade = cleanText(vehicle.conditionGrade);
  const candidates: PortalCatalogTag[] = [
    ...(vehicle.customerTags ?? []).map((label) => ({ label })),
    ...vehicle.tags.map((label) => ({ label })),
    ...(conditionGrade ? [{ color: "blue" as const, label: `车况 ${conditionGrade}` }] : []),
    ...(vehicle.batteryHealthPercent !== null &&
    vehicle.batteryHealthPercent !== undefined
      ? [
          {
            color: "green" as const,
            label: `电池健康度 ${vehicle.batteryHealthPercent}%`
          }
        ]
      : []),
    ...(vehicle.hasMajorAccident === false
      ? [{ color: "green" as const, label: "未标记重大事故" }]
      : []),
    { label: "押金审核后确认" }
  ];

  const registrationMonth = formatPortalCatalogMonth(vehicle.registrationDate);
  const excluded = new Set(
    [
      buildPortalCatalogTitle(vehicle),
      vehicle.city,
      vehicle.modelYear ? `${vehicle.modelYear}款` : null,
      registrationMonth,
      registrationMonth ? `上牌 ${registrationMonth}` : null,
      `${vehicle.currentMileageKm.toLocaleString("zh-CN")} km`,
      `${vehicle.currentMileageKm} km`
    ]
      .map(normalizeComparisonKey)
      .filter((value): value is string => Boolean(value))
  );
  const seen = new Set<string>();

  return candidates.flatMap((candidate) => {
    const label = cleanText(candidate.label);
    const key = normalizeComparisonKey(label);
    if (!label || !key || excluded.has(key) || seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [{ ...candidate, label }];
  });
}

export function formatPortalCatalogMonth(value?: string | null) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function formatPortalCatalogMonthlyFee(amount?: number | null) {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) {
    return "月租审核后确认";
  }
  const yuan = (amount / 100).toLocaleString("zh-CN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0
  });
  return `¥${yuan} / 月起`;
}

function safeCompatibleTitle(value?: string | null, internalCode?: string | null) {
  const title = cleanText(value);
  if (!title) {
    return null;
  }
  if (
    internalCode &&
    title.toLocaleLowerCase("zh-CN") === internalCode.toLocaleLowerCase("zh-CN")
  ) {
    return null;
  }
  const years = title.match(/\d{4}款/g) ?? [];
  if (new Set(years).size !== years.length) {
    return null;
  }
  return title;
}

function buildStructuredTitle(vehicle: PortalCatalogVehicle) {
  const seen = new Set<string>();
  const tokens = [vehicle.brand, vehicle.series, vehicle.model].flatMap((value) => {
    const token = cleanText(value);
    const key = normalizeComparisonKey(token);
    if (!token || !key || seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [token];
  });
  if (vehicle.modelYear) {
    tokens.push(`${vehicle.modelYear}款`);
  }
  return tokens.length ? tokens.join(" ") : null;
}

function cleanText(value?: string | null) {
  const text = value?.trim().replace(/\s+/g, " ");
  return text || null;
}

function normalizeComparisonKey(value?: string | null) {
  return cleanText(value)?.toLocaleLowerCase("zh-CN") ?? null;
}
