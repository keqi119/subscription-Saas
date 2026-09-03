import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresConnector } from "../src/postgres-connector.mjs";

test("connects with discrete TLS target fields and observes the actual database identity", async () => {
  const calls = [];
  const client = {
    async unsafe(statement, parameters) {
      calls.push([String(statement), parameters]);
      if (String(statement).includes("current_database")) {
        return [
          {
            databaseName: "s1ci_aaaaaaaaaaaaaaaaaaaaaaaa",
            databaseOid: "42",
            role: "verify_role",
            tls: true,
            schemas: ["public"],
            extensions: ["pgcrypto"]
          }
        ];
      }
      if (String(statement).includes("to_regclass")) return [{ name: null }];
      return [];
    },
    async begin(callbackOrMode, maybeCallback) {
      return (maybeCallback ?? callbackOrMode)(client);
    },
    async end() {}
  };
  let clientOptions;
  const connectDatabase = createPostgresConnector({
    createClient(options) {
      clientOptions = options;
      return client;
    }
  });
  const database = await connectDatabase({
    credential: {
      username: "verify_role",
      password: "not-exposed",
      capabilityProfile: "verify"
    },
    target: {
      hostname: "postgres",
      databaseName: "s1ci_aaaaaaaaaaaaaaaaaaaaaaaa",
      tlsMode: "require"
    }
  });

  const identity = await database.observeIdentity();

  assert.deepEqual(
    {
      host: clientOptions.host,
      database: clientOptions.database,
      username: clientOptions.username,
      ssl: clientOptions.ssl,
      prepare: clientOptions.prepare
    },
    {
      host: "postgres",
      database: "s1ci_aaaaaaaaaaaaaaaaaaaaaaaa",
      username: "verify_role",
      ssl: "require",
      prepare: false
    }
  );
  assert.equal(Object.hasOwn(clientOptions, "connectionString"), false);
  assert.equal(identity.databaseOid, "42");
  assert.equal(identity.migrationHead, null);
  assert.match(database.databaseIdentityFingerprint, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(calls.length, 2);
});

test("rejects a missing capability profile before constructing a client", async () => {
  let clients = 0;
  const connectDatabase = createPostgresConnector({
    createClient() {
      clients += 1;
    }
  });

  await assert.rejects(
    () =>
      connectDatabase({
        credential: { username: "verify_role", password: "not-exposed" },
        target: { hostname: "postgres", databaseName: "s1ci_test", tlsMode: "require" }
      }),
    { code: "RUNNER_DATABASE_CONNECTION_INPUT_INVALID" }
  );
  assert.equal(clients, 0);
});
