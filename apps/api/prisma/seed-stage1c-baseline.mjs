import { executeStage1cAccessBaseline } from "../../../scripts/stage1c-access-baseline-executor.mjs";

export async function synchronizeStage1cBaselineForDemoSeed({
  execute = executeStage1cAccessBaseline,
  prisma
}) {
  const result = await execute({ mode: "apply", prisma });
  if (result.exitCode !== 0 || result.report.safeToApply !== true) {
    throw new Error("STAGE1C_SEED_BASELINE_BLOCKED");
  }
  return result;
}
