import canonicalize from "canonicalize";

function canonicalError() {
  return Object.assign(new Error("CANONICAL_JSON_REFUSED"), {
    code: "CANONICAL_JSON_REFUSED"
  });
}

function assertUnicodeScalarString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw canonicalError();
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw canonicalError();
    }
  }
}

function assertIJson(value, seen) {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    assertUnicodeScalarString(value);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw canonicalError();
    return;
  }
  if (typeof value !== "object") throw canonicalError();
  if (seen.has(value)) throw canonicalError();
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const entry of value) assertIJson(entry, seen);
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw canonicalError();
    if (Object.getOwnPropertySymbols(value).length > 0) throw canonicalError();
    for (const [key, entry] of Object.entries(value)) {
      assertUnicodeScalarString(key);
      assertIJson(entry, seen);
    }
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value) {
  try {
    assertIJson(value, new WeakSet());
    const result = canonicalize(value);
    if (typeof result !== "string") throw canonicalError();
    return result;
  } catch (error) {
    if (error?.code === "CANONICAL_JSON_REFUSED") throw error;
    throw canonicalError();
  }
}
