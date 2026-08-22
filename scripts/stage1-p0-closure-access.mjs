import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { executeStage1P0ClosureAccess } from "./stage1-p0-closure-access-executor.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromApi = createRequire(resolve(repoRoot, "apps/api/package.json"));
let prisma;

export function parseStage1P0ClosureAccessArgs(args) {
  const modes = args.filter((item) => ["--dry-run", "--apply", "--cleanup"].includes(item));
  if (modes.length !== 1 || args.length !== 1)
    throw new Error("STAGE1_P0_CLOSURE_ACCESS_ARGUMENT_INVALID");
  return modes[0].slice(2);
}

export function assertDedicatedLocalDatabase(databaseUrl, mode, env) {
  const url = new URL(databaseUrl);
  const local = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (!local || !/codex|test|local/i.test(url.pathname))
    throw new Error("STAGE1_P0_CLOSURE_ACCESS_DEDICATED_LOCAL_REQUIRED");
  if (
    ["apply", "cleanup"].includes(mode) &&
    env.STAGE1_P0_CLOSURE_ACCESS_CONFIRM !== "SYNC_DEDICATED_LOCAL"
  ) {
    throw new Error("STAGE1_P0_CLOSURE_ACCESS_CONFIRMATION_REQUIRED");
  }
}

export async function runStage1P0ClosureAccess({
  args = process.argv.slice(2),
  env = process.env
} = {}) {
  const mode = parseStage1P0ClosureAccessArgs(args);
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("STAGE1_P0_CLOSURE_ACCESS_DATABASE_URL_REQUIRED");
  assertDedicatedLocalDatabase(databaseUrl, mode, env);
  const [{ PrismaPg }, { PrismaClient }] = await Promise.all([
    import(pathToFileURL(requireFromApi.resolve("@prisma/adapter-pg")).href),
    import(pathToFileURL(requireFromApi.resolve("@prisma/client")).href)
  ]);
  const normalized = new URL(databaseUrl);
  if (normalized.hostname === "localhost") normalized.hostname = "127.0.0.1";
  prisma = new PrismaClient({ adapter: new PrismaPg(normalized.toString()) });
  const outcome = await executeStage1P0ClosureAccess({ mode, prisma });
  process.stdout.write(`${JSON.stringify(outcome.report, null, 2)}\n`);
  return outcome.exitCode;
}

async function main() {
  const { config } = await import(pathToFileURL(requireFromApi.resolve("dotenv")).href);
  config({ path: resolve(repoRoot, ".env"), quiet: true });
  config({ path: resolve(repoRoot, "apps/api/.env"), quiet: true });
  try {
    return await runStage1P0ClosureAccess();
  } finally {
    await prisma?.$disconnect();
  }
}

if ((process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null) === import.meta.url) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.stderr.write('{"error":"STAGE1_P0_CLOSURE_ACCESS_FAILED"}\n');
      process.exitCode = 1;
    });
}
