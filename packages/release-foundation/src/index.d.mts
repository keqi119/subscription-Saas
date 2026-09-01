export interface ReleaseDatabaseRuntimeIdentity {
  readonly databaseName: string;
  readonly databaseOid: string;
  readonly targetFingerprint: string;
  readonly runtimeCredentialFingerprint: string;
  readonly migrationCredentialFingerprint: string;
  readonly databaseUrl: string;
  readonly runtimeCredential: Readonly<{ username: string; password: string }>;
}

export interface ReleaseDatabaseTestContext extends ReleaseDatabaseRuntimeIdentity {
  readonly schemaVersion: "release-database-test-context.v1";
  readonly allowedFiles: readonly string[];
  readonly containerId: string;
  readonly namedDatabases?: Readonly<{
    source: ReleaseDatabaseRuntimeIdentity;
    target: ReleaseDatabaseRuntimeIdentity;
  }>;
}

export function requiredReleaseDatabaseTestContext(
  moduleUrlOrRepositoryPath: string | URL
): ReleaseDatabaseTestContext;
