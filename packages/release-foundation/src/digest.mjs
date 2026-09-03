import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.mjs";

export function sha256Canonical(value) {
  const digest = createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
  return `sha256:${digest}`;
}

export function sha256Bytes(value) {
  const digest = createHash("sha256").update(value).digest("hex");
  return `sha256:${digest}`;
}

export function sha256Text(value) {
  if (typeof value !== "string") {
    throw Object.assign(new Error("SHA256_TEXT_INPUT_INVALID"), {
      code: "SHA256_TEXT_INPUT_INVALID"
    });
  }
  return createHash("sha256").update(value, "utf8").digest("hex");
}
