// The admitted H1 holder may install one captured adapter before it imports the
// exact lifecycle test file through node:test with process isolation disabled.
// This slot is not a request, credential, or authorization interface.
let installed;

const callbacks = [
  "provision",
  "migrate",
  "grantRuntimeAccess",
  "runtimeRole",
  "migrationOwnership",
  "attemptRuntimeCreate",
  "cleanup",
  "countDatabase",
  "siblingDatabase",
  "countOwned"
];

export function installR3LifecycleAdapter(adapter) {
  if (
    installed ||
    !adapter ||
    Object.keys(adapter).sort().join(",") !==
      ["runId", "policy", "target", "reservations", ...callbacks].sort().join(",") ||
    callbacks.some((name) => typeof adapter[name] !== "function")
  ) {
    throw new Error("R3_LIFECYCLE_ADAPTER_INVALID");
  }
  const entry = { adapter: Object.freeze({ ...adapter }), consumed: false };
  installed = entry;
  return () => {
    if (installed === entry) installed = undefined;
  };
}

export function takeR3LifecycleAdapter() {
  if (!installed) return undefined;
  if (installed.consumed)
    throw Object.assign(new Error("R3_LIFECYCLE_ADAPTER_CONSUMED"), {
      code: "R3_LIFECYCLE_ADAPTER_CONSUMED"
    });
  installed.consumed = true;
  return installed.adapter;
}
