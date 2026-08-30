import { config as dotenvConfig, type DotenvConfigOptions } from "dotenv";

export const PRISMA_MIGRATION_SKIP_DOTENV = "STAGE1_ACCEPTANCE_MIGRATION_SKIP_DOTENV";

type Environment = Record<string, string | undefined>;
type DotenvLoader = (options?: DotenvConfigOptions) => unknown;

export function loadPrismaEnvironment(options: {
  environment?: Environment;
  loadDotenv?: DotenvLoader;
  repositoryEnvPath: string;
}) {
  const environment = options.environment ?? process.env;
  if (environment[PRISMA_MIGRATION_SKIP_DOTENV] === "1") return;

  const loadDotenv = options.loadDotenv ?? dotenvConfig;
  loadDotenv({ path: options.repositoryEnvPath, processEnv: environment, quiet: true });
  loadDotenv({ processEnv: environment, quiet: true });
}
