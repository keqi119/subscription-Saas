import { spawn } from "node:child_process";

const runReleaseScenarios = process.env.RUN_RELEASE_SCENARIOS === "1";
const runReleaseSmoke = process.env.RUN_RELEASE_SMOKE === "1";

const requiredSteps = [
  ["Prisma validate", "pnpm", ["prisma:validate"]],
  ["Prisma generate", "pnpm", ["prisma:generate"]],
  [
    "VehicleModel no-enum guard syntax",
    "node",
    ["--check", "scripts/check-vehicle-model-no-enum.mjs"]
  ],
  ["VehicleModel no-enum guard", "node", ["scripts/check-vehicle-model-no-enum.mjs"]],
  [
    "VehicleModel no-enum guard tests",
    "node",
    ["--test", "scripts/check-vehicle-model-no-enum.test.mjs"]
  ],
  [
    "VehicleModel no-compatibility guard syntax",
    "node",
    ["--check", "scripts/check-vehicle-model-no-compatibility.mjs"]
  ],
  [
    "VehicleModel no-compatibility guard tests",
    "node",
    ["--test", "scripts/check-vehicle-model-no-compatibility.test.mjs"]
  ],
  [
    "VehicleModel no-compatibility guard",
    "node",
    ["scripts/check-vehicle-model-no-compatibility.mjs"]
  ],
  [
    "VehicleModel removal readiness syntax",
    "node",
    ["--check", "scripts/vehicle-model-removal-readiness.mjs"]
  ],
  [
    "VehicleModel removal readiness core syntax",
    "node",
    ["--check", "scripts/vehicle-model-removal-readiness-core.mjs"]
  ],
  ["VehicleModel removal readiness tests", "pnpm", ["vehicle-model:removal-readiness:test"]],
  [
    "VehicleModel external contract governance syntax",
    "node",
    ["--check", "scripts/vehicle-model-contract-governance.mjs"]
  ],
  ["VehicleModel external contract governance", "pnpm", ["vehicle-model:contract-governance"]],
  ["Workspace lint", "pnpm", ["-r", "lint"]],
  ["API typecheck", "pnpm", ["--filter", "@subscription-saas/api", "typecheck"]],
  ["Web typecheck", "pnpm", ["--filter", "@subscription-saas/web", "typecheck"]],
  ["API tests", "pnpm", ["--filter", "@subscription-saas/api", "test"]],
  ["Smoke script syntax", "node", ["--check", "scripts/api-smoke.mjs"]],
  ["Portal route smoke syntax", "node", ["--check", "scripts/portal-route-smoke.mjs"]],
  ["Portal API smoke syntax", "node", ["--check", "scripts/portal-api-smoke.mjs"]],
  [
    "WeChat Official Account smoke syntax",
    "node",
    ["--check", "scripts/wechat-official-account-smoke.mjs"]
  ],
  ["WeChat Official Account menu syntax", "node", ["--check", "scripts/wechat-menu.mjs"]],
  [
    "WeChat Official Account menu dry-run syntax",
    "node",
    ["--check", "scripts/wechat-menu-dry-run.mjs"]
  ],
  [
    "WeChat Pay certificate downloader syntax",
    "node",
    ["--check", "scripts/wechat-pay-download-platform-certs.mjs"]
  ],
  [
    "Fadada sandbox upload/signUrl smoke syntax",
    "node",
    ["--check", "scripts/fadada-sandbox-upload-signurl-smoke.mjs"]
  ],
  [
    "Fadada sandbox upload/signUrl smoke tests",
    "pnpm",
    ["fadada:sandbox-upload-signurl-smoke:test"]
  ],
  [
    "Fadada test signer real-name prep syntax",
    "node",
    ["--check", "scripts/fadada-production-test-signer-realname.mjs"]
  ],
  [
    "Fadada production upload/signUrl smoke syntax",
    "node",
    ["--check", "scripts/fadada-production-upload-signurl-smoke.mjs"]
  ],
  ["Fadada production upload/signUrl smoke tests", "pnpm", ["fadada:upload-signurl:test"]],
  ["Stage 1 Golden Path preflight tests", "pnpm", ["stage1:golden-path:preflight:test"]],
  [
    "Stage 1 Golden Path production image guard",
    "node",
    ["scripts/stage1-golden-path-production-preflight.mjs", "--check-examples"]
  ],
  [
    "Stage 1 invalid Staging order retirement tests",
    "pnpm",
    ["stage1:staging-invalid-test-order-retirement:test:unit"]
  ],
  [
    "Stage 1C asset accounting reconciliation",
    "node",
    ["--test", "scripts/stage1c-asset-accounting-reconciliation.test.mjs"]
  ],
  ["Stage 1 closure reconciliation", "pnpm", ["stage1:p0-closure:reconcile"]],
  ["Scenario seed syntax", "node", ["--check", "apps/api/prisma/seed-scenario.mjs"]]
];

const scenarioSteps = [
  ["Scenario cleanup", "pnpm", ["seed:scenario", "cleanup"]],
  ["Scenario mainline seed", "pnpm", ["seed:scenario", "mainline"]],
  ["Scenario residual seed", "pnpm", ["seed:scenario", "residual"]]
];

const smokeSteps = [
  ["API smoke", "pnpm", ["smoke:api"]],
  ["Mainline smoke", "pnpm", ["smoke:mainline"]],
  ["Residual smoke", "pnpm", ["smoke:residual"]]
];

async function main() {
  console.log("Release check started.");
  console.log(`RUN_RELEASE_SCENARIOS=${runReleaseScenarios ? "1" : "0"}`);
  console.log(`RUN_RELEASE_SMOKE=${runReleaseSmoke ? "1" : "0"}`);

  await runSteps(requiredSteps);

  if (runReleaseScenarios) {
    await runSteps(scenarioSteps);
  } else {
    console.log("SKIP scenario seed steps: set RUN_RELEASE_SCENARIOS=1 to run them.");
  }

  if (runReleaseSmoke) {
    await runSteps(smokeSteps);
  } else {
    console.log("SKIP smoke steps: set RUN_RELEASE_SMOKE=1 to run them.");
  }

  console.log("PASS release check");
}

async function runSteps(steps) {
  for (const [name, command, args] of steps) {
    await runStep(name, command, args);
  }
}

function runStep(name, command, args) {
  const commandLine = [command, ...args].join(" ");
  const start = Date.now();
  console.log(`\nRUN ${name}: ${commandLine}`);

  return new Promise((resolve, reject) => {
    const child =
      process.platform === "win32"
        ? spawn(commandLine, { shell: true, stdio: "inherit" })
        : spawn(command, args, { stdio: "inherit" });

    child.on("error", (error) => {
      console.error(`FAIL ${name}: ${error.message}`);
      reject(error);
    });

    child.on("close", (code) => {
      const elapsedSeconds = ((Date.now() - start) / 1000).toFixed(1);
      if (code === 0) {
        console.log(`PASS ${name} (${elapsedSeconds}s)`);
        resolve();
        return;
      }

      const error = new Error(`${name} failed with exit code ${code}`);
      console.error(`FAIL ${name} (${elapsedSeconds}s)`);
      reject(error);
    });
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
