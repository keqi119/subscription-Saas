import path from "node:path";

import { runnerError } from "./error-codes.mjs";

const referenceKinds = Object.freeze([
  ["launch-file:///run/launch/", "launch"],
  ["secret-file:///run/secrets/", "secrets"],
  ["evidence-file:///evidence/", "evidence"]
]);

function relativeReference(reference, prefix) {
  const relative = reference.slice(prefix.length);
  if (
    !relative ||
    relative.includes("\\") ||
    relative.includes("%") ||
    relative.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw runnerError("RUNNER_REFERENCE_FORBIDDEN");
  }
  return relative;
}

export function resolveRunnerReference(reference, roots) {
  if (typeof reference !== "string") throw runnerError("RUNNER_REFERENCE_FORBIDDEN");
  for (const [prefix, rootName] of referenceKinds) {
    if (!reference.startsWith(prefix)) continue;
    const root = path.resolve(roots?.[rootName] ?? "");
    const absolute = path.resolve(root, ...relativeReference(reference, prefix).split("/"));
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw runnerError("RUNNER_REFERENCE_FORBIDDEN");
    }
    return absolute;
  }
  throw runnerError("RUNNER_REFERENCE_FORBIDDEN");
}
