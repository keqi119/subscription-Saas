import { spawn } from "node:child_process";

const runReleaseScenarios = process.env.RUN_RELEASE_SCENARIOS === "1";
const runReleaseSmoke = process.env.RUN_RELEASE_SMOKE === "1";

const requiredSteps = [
  ["Prisma validate", "pnpm", ["prisma:validate"]],
  ["Prisma generate", "pnpm", ["prisma:generate"]],
  ["Workspace lint", "pnpm", ["-r", "lint"]],
  ["API typecheck", "pnpm", ["--filter", "@subscription-saas/api", "typecheck"]],
  ["Web typecheck", "pnpm", ["--filter", "@subscription-saas/web", "typecheck"]],
  ["API tests", "pnpm", ["--filter", "@subscription-saas/api", "test"]],
  ["Prisma migrate status", "pnpm", ["prisma:migrate:status"]],
  ["Smoke script syntax", "node", ["--check", "scripts/api-smoke.mjs"]],
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
