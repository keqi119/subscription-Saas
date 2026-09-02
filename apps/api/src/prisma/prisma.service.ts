import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool, type PoolConfig } from "pg";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(PrismaService.name);
  private readonly pool: Pool;

  constructor(configService: ConfigService) {
    const databaseUrl = configService.get<string>("DATABASE_URL");

    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required.");
    }

    const poolConfig = createPoolConfig(databaseUrl, configService);
    const pool = new Pool(poolConfig);
    const logPoolError = (error: Error) => {
      PrismaService.logger.error("Unexpected PostgreSQL pool error.", error.stack);
    };
    const logConnectionError = (error: Error) => {
      PrismaService.logger.error("Unexpected PostgreSQL connection error.", error.stack);
    };

    pool.on("error", logPoolError);

    super({
      adapter: new PrismaPg(pool, {
        disposeExternalPool: false,
        onConnectionError: logConnectionError,
        onPoolError: logPoolError
      })
    });

    this.pool = pool;
  }

  async onModuleInit() {
    await this.$connect();
    await this.$queryRaw`SELECT 1`;
    PrismaService.logger.log("Connected to PostgreSQL.");
  }

  async onModuleDestroy() {
    await this.$disconnect();
    await this.pool.end();
    PrismaService.logger.log("PostgreSQL connection pool closed.");
  }
}

function createPoolConfig(databaseUrl: string, configService: ConfigService): PoolConfig {
  return {
    application_name: resolveDatabaseApplicationName(configService),
    connectionString: normalizeLocalhostDatabaseUrl(databaseUrl),
    connectionTimeoutMillis: readNumber(
      configService,
      "DATABASE_POOL_CONNECTION_TIMEOUT_MS",
      10_000
    ),
    idleTimeoutMillis: readNumber(configService, "DATABASE_POOL_IDLE_TIMEOUT_MS", 30_000),
    max: readNumber(configService, "DATABASE_POOL_MAX", 10)
  };
}

export function resolveDatabaseApplicationName(configService: Pick<ConfigService, "get">) {
  if (configService.get<string>("RELEASE_FINAL_GATE") !== "true") {
    return "subscription-api";
  }
  const manifestId = configService.get<string>("DATABASE_MANIFEST_ID");
  const sessionNonce = configService.get<string>("DATABASE_SESSION_NONCE");
  if (!manifestId || !sessionNonce) {
    throw new Error("DATABASE_SESSION_IDENTITY_REQUIRED");
  }
  return buildDatabaseApplicationName(manifestId, sessionNonce);
}

export function buildDatabaseApplicationName(manifestId: string, sessionNonce: string) {
  const componentPattern = /^[a-z0-9][a-z0-9-]{1,39}$/;
  const applicationName = `subscription-api/${manifestId}/${sessionNonce}`;
  if (
    !componentPattern.test(manifestId) ||
    !componentPattern.test(sessionNonce) ||
    Buffer.byteLength(applicationName, "utf8") > 63
  ) {
    throw new Error("DATABASE_SESSION_IDENTITY_INVALID");
  }
  return applicationName;
}

export function normalizeLocalhostDatabaseUrl(databaseUrl: string) {
  const url = new URL(databaseUrl);

  if (url.hostname === "localhost") {
    url.hostname = "127.0.0.1";
  }

  return url.toString();
}

function readNumber(configService: ConfigService, key: string, fallback: number) {
  const value = configService.get<string>(key);
  const parsed = value ? Number(value) : fallback;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
