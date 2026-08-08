const DEFAULT_MAX_FILENAME_LENGTH = 255;

function isUnsafeFilenameCharacter(character: string) {
  const codePoint = character.codePointAt(0) ?? 0;

  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function removeUnsafeFilenameCharacters(value: string) {
  return Array.from(value)
    .filter((character) => !isUnsafeFilenameCharacter(character))
    .join("");
}

function cleanFilename(value: string) {
  const basename = value.replaceAll("\\", "/").split("/").at(-1) ?? "";

  return removeUnsafeFilenameCharacters(basename.normalize("NFC")).trim();
}

function truncateFilename(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  const extensionIndex = value.lastIndexOf(".");
  if (extensionIndex <= 0) {
    return value.slice(0, maxLength);
  }

  const extension = value.slice(extensionIndex);
  if (extension.length >= maxLength) {
    return value.slice(0, maxLength);
  }

  return `${value.slice(0, maxLength - extension.length)}${extension}`;
}

export function normalizeUploadFilename(
  originalName: string,
  fallback = "upload",
  maxLength = DEFAULT_MAX_FILENAME_LENGTH
) {
  const cleaned = cleanFilename(originalName);
  const safeFallback = cleanFilename(fallback) || "upload";
  const filename = cleaned === "." || cleaned === ".." ? safeFallback : cleaned;

  return truncateFilename(filename || safeFallback, maxLength);
}
