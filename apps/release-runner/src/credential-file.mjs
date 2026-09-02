import { readFile as defaultReadFile, unlink as defaultUnlink } from "node:fs/promises";
import path from "node:path";

import { runnerError } from "./error-codes.mjs";

export function createReadOnceCredentialReader({
  allowedRoot,
  readFile = defaultReadFile,
  unlink = defaultUnlink
}) {
  const root = path.resolve(allowedRoot);
  const consumed = new Set();
  return async function readCredential(reference) {
    const absolute = path.resolve(reference);
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw runnerError("RUNNER_CREDENTIAL_REFERENCE_FORBIDDEN");
    }
    if (consumed.has(absolute)) throw runnerError("RUNNER_CREDENTIAL_ALREADY_READ");
    consumed.add(absolute);
    let raw;
    try {
      raw = await readFile(absolute, "utf8");
    } finally {
      await unlink(absolute).catch(() => {});
    }
    let credential;
    try {
      credential = JSON.parse(raw);
    } catch {
      throw runnerError("RUNNER_CREDENTIAL_INVALID");
    }
    if (
      !credential ||
      typeof credential !== "object" ||
      Array.isArray(credential) ||
      typeof credential.username !== "string" ||
      credential.username.length === 0 ||
      typeof credential.password !== "string" ||
      credential.password.length === 0
    ) {
      throw runnerError("RUNNER_CREDENTIAL_INVALID");
    }
    return Object.freeze({ username: credential.username, password: credential.password });
  };
}
