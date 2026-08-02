export function formatFieldEvidenceVideoQuality(
  mediaType: null | string | undefined,
  metadata: unknown
): string | null {
  if (mediaType !== "VIDEO") {
    return null;
  }

  const record = isRecord(metadata) ? metadata : null;
  const width = positiveInteger(record?.videoWidthPx);
  const height = positiveInteger(record?.videoHeightPx);
  if (!width || !height) {
    return "视频清晰度：历史资料未记录";
  }

  const suffix = record?.videoQualityStatus === "PASSED"
    ? "（符合环绕视频最低要求）"
    : "";
  return `视频清晰度：${width}×${height}${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}
