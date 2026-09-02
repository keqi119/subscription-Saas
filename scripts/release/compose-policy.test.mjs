import assert from "node:assert/strict";
import test from "node:test";

import { verifyComposeConfig } from "./verify-compose-policy.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const images = Object.freeze({
  api: `ghcr.io/example/subscription-api@${digest("a")}`,
  web: `ghcr.io/example/subscription-web@${digest("b")}`,
  runner: `ghcr.io/example/subscription-runner@${digest("c")}`,
  playwright: `mcr.microsoft.com/playwright:v1.62.1-noble@${digest("d")}`
});
const sourceSha = "f".repeat(40);

function validConfig() {
  return {
    name: "release-gate",
    services: {
      postgres: {
        image: `postgres@${digest("e")}`,
        profiles: ["database"],
        command: [
          "postgres",
          "-c",
          "ssl=on",
          "-c",
          "ssl_cert_file=/etc/ssl/certs/ssl-cert-snakeoil.pem",
          "-c",
          "ssl_key_file=/etc/ssl/private/ssl-cert-snakeoil.key"
        ],
        volumes: [
          {
            type: "volume",
            source: "release-gate-db",
            target: "/var/lib/postgresql/data"
          }
        ]
      },
      "runner-migration": runner("migrate"),
      "runner-verify": runner("verify"),
      "runner-database-test": databaseTestRunner(),
      api: {
        image: images.api,
        profiles: ["api"],
        environment: {
          RELEASE_FINAL_GATE: "true",
          DATABASE_URL: "postgresql://runtime:policy-only@postgres:5432/release_gate",
          DATABASE_MANIFEST_ID: "manifest-ab12",
          DATABASE_SESSION_NONCE: "session-cd34"
        },
        labels: { "com.subscription.release.source-revision": sourceSha }
      },
      web: {
        image: images.web,
        profiles: ["web"],
        labels: { "com.subscription.release.source-revision": sourceSha }
      },
      playwright: {
        image: images.playwright,
        profiles: ["client"],
        restart: "no",
        environment: { PLAYWRIGHT_VERSION: "1.62.1" }
      }
    },
    volumes: { "release-gate-db": {} }
  };
}

function runner(capability) {
  return {
    image: images.runner,
    profiles: [`runner-${capability}`],
    restart: "no",
    environment: { RUNNER_CAPABILITY_PROFILE: capability },
    labels: { "com.subscription.release.source-revision": sourceSha }
  };
}

function databaseTestRunner() {
  return {
    image: images.runner,
    profiles: ["runner-database-test"],
    restart: "no",
    environment: {
      RUNNER_LAUNCH_ENVELOPE_FILE: "/run/launch/runner-launch-envelope.v1.json"
    },
    labels: { "com.subscription.release.source-revision": sourceSha }
  };
}

test("accepts digest-pinned capability-separated final gate services", () => {
  assert.deepEqual(
    verifyComposeConfig(validConfig(), { expectedImages: images, expectedSourceSha: sourceSha }),
    {
      serviceCount: 7,
      runnerCapabilities: ["migrate", "verify"]
    }
  );
});

for (const [name, mutate, code] of [
  ["build", (config) => (config.services.api.build = "."), "COMPOSE_BUILD_FORBIDDEN"],
  [
    "source mount",
    (config) => (config.services.api.volumes = [{ type: "bind", source: ".", target: "/app" }]),
    "COMPOSE_SOURCE_MOUNT_FORBIDDEN"
  ],
  [
    "mutable tag",
    (config) => (config.services.api.image = "example/api:latest"),
    "COMPOSE_IMAGE_NOT_IMMUTABLE"
  ],
  [
    "docker socket",
    (config) =>
      (config.services["runner-verify"].volumes = [
        { type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" }
      ]),
    "COMPOSE_DOCKER_SOCKET_FORBIDDEN"
  ],
  [
    "entrypoint override",
    (config) => (config.services.api.entrypoint = ["sh"]),
    "COMPOSE_ENTRYPOINT_OVERRIDE_FORBIDDEN"
  ],
  [
    "command override",
    (config) => (config.services.api.command = ["sh"]),
    "COMPOSE_COMMAND_OVERRIDE_FORBIDDEN"
  ],
  [
    "privileged",
    (config) => (config.services.api.privileged = true),
    "COMPOSE_PRIVILEGED_FORBIDDEN"
  ],
  [
    "interactive stdin",
    (config) => (config.services["runner-verify"].stdin_open = true),
    "COMPOSE_EXEC_PATH_FORBIDDEN"
  ],
  ["tty", (config) => (config.services["runner-verify"].tty = true), "COMPOSE_EXEC_PATH_FORBIDDEN"]
]) {
  test(`rejects ${name}`, () => {
    const config = validConfig();
    mutate(config);
    assert.throws(() => verifyComposeConfig(config, { expectedImages: images }), { code });
  });
}

test("rejects a Runner service with a combined capability identity", () => {
  const config = validConfig();
  config.services["runner-verify"].environment.RUNNER_CAPABILITY_PROFILE = "verify,migrate";
  assert.throws(() => verifyComposeConfig(config, { expectedImages: images }), {
    code: "COMPOSE_RUNNER_CAPABILITY_INVALID"
  });
});

test("rejects capability injection into the closed database-test execution mode", () => {
  const config = validConfig();
  config.services["runner-database-test"].environment.RUNNER_CAPABILITY_PROFILE = "runtime-test";
  assert.throws(() => verifyComposeConfig(config, { expectedImages: images }), {
    code: "COMPOSE_RUNNER_EXECUTION_MODE_INVALID"
  });
});

test("rejects governance credentials on API, Web or browser services", () => {
  for (const [service, key] of [
    ["api", "MIGRATION_DATABASE_PASSWORD"],
    ["web", "DATABASE_URL"],
    ["playwright", "RUNNER_CAPABILITY_SECRET"]
  ]) {
    const config = validConfig();
    config.services[service].environment ??= {};
    config.services[service].environment[key] = "forbidden";
    assert.throws(() => verifyComposeConfig(config, { expectedImages: images }), {
      code:
        service === "api"
          ? "COMPOSE_API_SESSION_IDENTITY_MISSING"
          : "COMPOSE_APPLICATION_CREDENTIAL_SCOPE_INVALID"
    });
  }
});

test("rejects an incomplete final release bundle", () => {
  const config = validConfig();
  delete config.services.web;
  assert.throws(() => verifyComposeConfig(config, { expectedImages: images }), {
    code: "COMPOSE_RELEASE_SERVICE_MISSING"
  });
});

test("rejects a Compose source revision that differs from the build proof", () => {
  assert.throws(
    () =>
      verifyComposeConfig(validConfig(), {
        expectedImages: images,
        expectedSourceSha: "0".repeat(40)
      }),
    { code: "COMPOSE_SOURCE_REVISION_MISMATCH" }
  );
});
