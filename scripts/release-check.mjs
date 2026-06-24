import { spawn } from "node:child_process";

const runReleaseScenarios = process.env.RUN_RELEASE_SCENARIOS === "1";
const runReleaseSmoke = process.env.RUN_RELEASE_SMOKE === "1";

const requiredSteps = [
  ["Prisma validate", "pnpm", ["prisma:validate"]],
  ["Prisma generate", "pnpm", ["prisma:generate"]],
  ["VehicleModel enum freeze syntax", "node", ["--check", "scripts/check-vehicle-model-enum-freeze.mjs"]],
  ["VehicleModel enum freeze", "pnpm", ["vehicle-model:enum-freeze"]],
  ["VehicleModel enum freeze tests", "pnpm", ["vehicle-model:enum-freeze:test"]],
  ["ModelDefinition backfill syntax", "node", ["--check", "scripts/model-definition-backfill.mjs"]],
  ["ModelDefinition backfill dry-run syntax", "node", ["--check", "scripts/model-definition-backfill-dry-run.mjs"]],
  ["ModelDefinition backfill tests", "pnpm", ["model-definition:backfill:test"]],
  ["Quote / Order snapshot backfill syntax", "node", ["--check", "scripts/quote-order-model-snapshot-backfill.mjs"]],
  ["Quote / Order snapshot backfill core syntax", "node", ["--check", "scripts/quote-order-model-snapshot-backfill-core.mjs"]],
  ["Quote / Order snapshot backfill tests", "pnpm", ["quote-order:snapshot-backfill:test"]],
  ["Quote / Order model code snapshot backfill syntax", "node", ["--check", "scripts/quote-order-model-code-snapshot-backfill.mjs"]],
  ["Quote / Order model code snapshot backfill core syntax", "node", ["--check", "scripts/quote-order-model-code-snapshot-backfill-core.mjs"]],
  ["Quote / Order model code snapshot backfill tests", "pnpm", ["quote-order:model-code-snapshot-backfill:test"]],
  ["Workspace lint", "pnpm", ["-r", "lint"]],
  ["API typecheck", "pnpm", ["--filter", "@subscription-saas/api", "typecheck"]],
  ["Web typecheck", "pnpm", ["--filter", "@subscription-saas/web", "typecheck"]],
  ["API tests", "pnpm", ["--filter", "@subscription-saas/api", "test"]],
  ["Prisma migrate status", "pnpm", ["prisma:migrate:status"]],
  ["Smoke script syntax", "node", ["--check", "scripts/api-smoke.mjs"]],
  ["Portal route smoke syntax", "node", ["--check", "scripts/portal-route-smoke.mjs"]],
  ["Portal API smoke syntax", "node", ["--check", "scripts/portal-api-smoke.mjs"]],
  ["WeChat Official Account smoke syntax", "node", ["--check", "scripts/wechat-official-account-smoke.mjs"]],
  ["WeChat Official Account menu syntax", "node", ["--check", "scripts/wechat-menu.mjs"]],
  ["WeChat Official Account menu dry-run syntax", "node", ["--check", "scripts/wechat-menu-dry-run.mjs"]],
  ["WeChat Pay certificate downloader syntax", "node", ["--check", "scripts/wechat-pay-download-platform-certs.mjs"]],
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
