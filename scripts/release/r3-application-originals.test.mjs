import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import { sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { createBuildProof } from "./create-build-proof.mjs";
import { createFinalApplicationAdapters } from "./final-compose-application-adapters.mjs";
import {
  applicationContainerSpecs,
  withR3ApplicationContainers
} from "./r3-application-containers.mjs";
import { assessR3ApplicationOriginals } from "./r3-application-originals.mjs";
import { assessR3ApplicationPostgresReadback } from "./r3-destination.mjs";
import { buildR3ApplicationPlan } from "./r3-final-application.mjs";
import { assessR3PostgresObservation } from "./r3-postgres-observation.mjs";
import { load as loadYaml } from "js-yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const operationId = "97c61d0d-fa2c-42bb-9ba7-66f8724bc29b";
const digest = (char) => `sha256:${char.repeat(64)}`;
const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const invalid = { code: "R3_APPLICATION_ORIGINALS_INVALID" };
const CA_PEM_BASE64 =
  "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tDQpNSUlDN3pDQ0FkZWdBd0lCQWdJVWRvd3I4bXRGRWlHQ0FDM3l4cnpmQWd5dVdNRXdEUVlKS29aSWh2Y05BUUVMDQpCUUF3SHpFZE1Cc0dBMVVFQXd3VVVqTWdVM1JoWjJVeElGQnlhWFpoZEdVZ1EwRXdIaGNOTWpZd09UTXdNVGt6DQpOak00V2hjTk1qWXhNREF4TVRrek5qTTRXakFmTVIwd0d3WURWUVFEREJSU015QlRkR0ZuWlRFZ1VISnBkbUYwDQpaU0JEUVRDQ0FTSXdEUVlKS29aSWh2Y05BUUVCQlFBRGdnRVBBRENDQVFvQ2dnRUJBSmlLNjVOSDAzZ0ZQdklmDQpoN1Q1cHdkSGlPNXl0cEl4UmN6UG54bC9VNU54Umdpdkozb3ViYmFwUS8xaFFCZ01wdjhQa252dnl4VThneEVrDQppd2NTa0syWStxRStoM3BwQndPK2pTbnhTYVpKZVJLaDlQSTlKaXNpYXFoK2ZhTEdRekFiYTNTL2dCc2lkaFI1DQpjcFQ5L1BldXAwVnc3YjN0STZuV1VtM0k3ZzhPMm1zOWV6OGZ4c1RLZjU4cGMzZExPUEM1dU1JMVlEc1JjK3NVDQpJdCt4amdvVjBSQmRMZUErQmJOUGpDYVNoY1RIeUo5L1ZhTXluQW42Q1dkY1k2V1lITmZMRUdBcHZsRVF3d1NhDQpiZi9EY0VCNE1jV1lIL0l2NEhsZ0lyY0RSdFZKNGR5emNBaUxpZytxeFhJdENWYmEwYXM1WDdMYVZsOGY0b0FHDQpaZldsM3FjQ0F3RUFBYU1qTUNFd0R3WURWUjBUQVFIL0JBVXdBd0VCL3pBT0JnTlZIUThCQWY4RUJBTUNBUVl3DQpEUVlKS29aSWh2Y05BUUVMQlFBRGdnRUJBQkZRYnBURFNhSlh4QTM0RmdpcDM2NW9kdlZacFRhQVg2Q2NPMjZTDQpmZmFwMVZvSnVndkp1M3pDWFhRNG1ibmNwZE1FdDZha0ZTUzYxS0o2bXppeFVNSG5PUjZBN1RkOVNHZ05IZGxaDQpKUEM0V3k4a3cvUjc2cHdzTXNObDRaZlMybzBHSlVrUGtTUHVNNy9xd2Q3WjNQUWJ6ajNrYjJSV3g2ZkxDVGNEDQpva09aSXNwbmdPejZ5REI2WFp3NUY1UHdDcFRvY1hFZnRYaXpzQW9PZVZLaytWT3BOaXZ2VzdGZUFFamdnbi9NDQoxeWxvRnBWM1EwcGhlK2Y5Q0h2R1lqVDdjaDArMmt2bVgxUzRBS3FmYUlFc1hMc2VEdUVZMjAzR0g1anVrbTQzDQpUTDU5V0E2TUl6MzFaTEc3aS8yc2hXZEduZDNNMWhYbld2cTNsRU5TRUFVYXRFRT0NCi0tLS0tRU5EIENFUlRJRklDQVRFLS0tLS0NCg==";
const SERVER_PEM_BASE64 =
  "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tDQpNSUlEQ3pDQ0FmT2dBd0lCQWdJRkVqUldlSkF3RFFZSktvWklodmNOQVFFTEJRQXdIekVkTUJzR0ExVUVBd3dVDQpVak1nVTNSaFoyVXhJRkJ5YVhaaGRHVWdRMEV3SGhjTk1qWXdPVE13TVRrek56QXdXaGNOTWpZeE1EQXhNVGt6DQpOekF3V2pBYk1Sa3dGd1lEVlFRRERCQmhjR2t1WlhoaGJYQnNaUzUwWlhOME1JSUJJakFOQmdrcWhraUc5dzBCDQpBUUVGQUFPQ0FROEFNSUlCQ2dLQ0FRRUFuaGxjRlNmc1d4bnZmbWxqV2E5K1NHTUEwa0JDcEluakFDL0g5SVNODQorM0MwajdvV2hOTEo0eGNqb0dKWENjUk5JMUx3TzExM3phaUZHVHlWbXpzeHR0OHJVUndrUDUvZS9nT3QzYTFtDQpvbmN2cW1QL2JzbTl5ZTdmcFpMQTB0VGFacFNpUzlxOVppM2hRSVljL2dTYk5XYjFsR3JPOG1YZ08xYXlxV2ZDDQpvcnRITkRYZ1dpRVBnYkljRjBDbExmQlFINDhPeG9FQlVBQnFWZFpVZjIzRUJHdGhtQ1VBR0VCR0FkeStSNXY1DQpBYjVWdjhCU2JGR0N5QVlVN3N2Y3lQb3d2SUg3SFdwWFYySERiRHR1aktKYjJ4anBsZTdiL2J6NnRqNDIyWGFNDQpyYUZ6Vk9BeDBZVmp4WjVjZ1d6MmlsS0h0WXFmZWtJcGx2aEhSOVd1MGM3NDV3SURBUUFCbzFJd1VEQU1CZ05WDQpIUk1CQWY4RUFqQUFNQTRHQTFVZER3RUIvd1FFQXdJRm9EQVRCZ05WSFNVRUREQUtCZ2dyQmdFRkJRY0RBVEFiDQpCZ05WSFJFRUZEQVNnaEJoY0drdVpYaGhiWEJzWlM1MFpYTjBNQTBHQ1NxR1NJYjNEUUVCQ3dVQUE0SUJBUUFKDQp3VUtXc1lTK0R4dGg0Q2xwVzlLdkVwUE85enBsemVQZjN2N01CWGdOYkQzRTEwWmpQOUhxblpYZ2g1dDdVT3lYDQpCV0tQSzRuWU9LcWJqQW01OGRiZUtvRGdpT2V3bmFOZG5icEsvWnZOMHFXYlJ3UlRpSE4yaFBTRndUN0N6NmZGDQpBR1NIWEVHOVVDU3FYbmZPRTJkc1lLNm1zNWc5WFFGSUFTODZNWTFZVVNWS1BoZGlIQzArcGk1ZkVFN3laWEFyDQpFRGdDUkhnbW5uMzI1N2I3MGphc0hpSGR3UEREUEhxV2srdlZkdit2NlpHdGp2bVlaSmJWYmlrbnAwUFNIdXZDDQpNMWhoZEh4cVQzOE44c1JpLzNNaWlvTGM5bmdrZDE2Y3Z0Szc2aHIvaDRET29PUER5TFVBYldZUWZlbWRXRnEwDQpONDRjVnk2Z2RJK0tSNmhjeU1JaA0KLS0tLS1FTkQgQ0VSVElGSUNBVEUtLS0tLQ0K";

function contextFixture() {
  const sourceSha = "a".repeat(40);
  const ciRunRef = "github://keqi119/subscription-Saas/actions/runs/2801";
  const image = (name, char) => {
    const repository = `ghcr.io/keqi119/subscription-${name}`;
    const imageDigest = digest(char);
    return {
      name,
      image: repository,
      platform: "linux/amd64",
      digest: imageDigest,
      sourceRevision: sourceSha,
      baseImageDigests: [
        { image: "node:22-bookworm-slim", declaredDigest: digest("1"), digest: digest("2") }
      ],
      builderName: "https://mobyproject.org/buildkit@v1",
      buildAttestationRef: `oci://${repository}@${imageDigest}#provenance=${digest("3")}`,
      registrySubject: `${repository}@${imageDigest}`,
      buildRunRef: ciRunRef
    };
  };
  const buildMaterialObservation = {
    schemaVersion: "build-material-observation.v1",
    sourceSha,
    checkoutRef: sourceSha,
    ciRunRef,
    repositoryContractDigest: digest("4"),
    migrationCatalogDigest: digest("5"),
    policyDigest: digest("6"),
    promotionEligibility: "trusted-candidate",
    images: [image("api", "7"), image("web", "8"), image("runner", "9")],
    webClient: { imageDigest: digest("8"), apiBaseUrl: "https://api.example.test/api" },
    externalActions: [{ name: "actions/checkout", commitSha: "2".repeat(40) }],
    builder: {
      name: "https://mobyproject.org/buildkit@v1",
      provenanceRef: `build-material-attestations:${digest("a")}`
    },
    observedAt: "2026-09-02T16:00:00.000Z"
  };
  const buildProof = createBuildProof({
    sourceSha,
    images: buildMaterialObservation.images,
    migrationCatalog: { digest: buildMaterialObservation.migrationCatalogDigest },
    repositoryContract: { digest: buildMaterialObservation.repositoryContractDigest },
    provenance: {
      generatedAt: "2026-09-02T16:00:00.000Z",
      ciRunRef,
      attestationRef: buildMaterialObservation.builder.provenanceRef,
      checkoutRef: sourceSha,
      buildMaterialObservation
    }
  });
  const record = {
    kind: "application",
    marker: "r3-application",
    databaseName: "s1a_final",
    databaseOid: "4242",
    roles: { migrate: "s1a_migrate", "api-runtime": "s1a_runtime", verify: "s1a_verify" },
    secretReferences: {
      "api-runtime": `r3/${operationId}/database-credentials/s1a_final-api-runtime.json`
    }
  };
  return {
    request: {
      schemaVersion: "manual-runner-request.v5",
      phase: "final",
      chain: "fresh",
      stage: "candidate-use",
      operationId,
      runId: "642bcd14-e4f2-42a6-afbc-61e941c66840",
      sourceSha,
      sessionNonce: "abcdef0123456789abcdef0123456789",
      targetPolicyDigest: digest("d"),
      candidate: { buildProofDigest: sha256Canonical(buildProof) }
    },
    buildProof,
    buildMaterialObservation,
    postgres: {
      engineId: "engine-1",
      containerId: "c".repeat(64),
      postgres: { serverAddress: "172.28.0.2", serverVersionNum: 170011 }
    },
    record,
    migration: {
      status: "FINAL_MIGRATION_OBSERVED",
      promotionEligible: false,
      input: {
        operationId,
        runId: "642bcd14-e4f2-42a6-afbc-61e941c66840",
        phase: "final",
        chain: "fresh",
        sourceSha,
        buildProofDigest: sha256Canonical(buildProof),
        creationEvidenceDigest: digest("c"),
        assignment: { kind: "application" },
        database: {
          databaseName: record.databaseName,
          databaseOid: record.databaseOid,
          migrationRole: record.roles.migrate,
          marker: "r3-application"
        },
        migrationCatalogDigest: buildProof.identity.migrationCatalogDigest,
        expectedSchemaDigest: digest("f")
      },
      schema: { expectedSchemaDigest: digest("f") },
      originals: {
        channel: {
          results: [
            {
              baseline: {
                identity: { migrationHead: null, schemaDigest: digest("b") }
              }
            }
          ]
        }
      }
    },
    creationEvidenceDigest: digest("c"),
    targetPolicyRef: `release/contracts/manual-stage1-r3-target-policy.v1.json@${digest("d")}`,
    observedAt: "2026-10-01T12:00:00.000Z"
  };
}

function postgresFixture() {
  const suffix = operationId.replaceAll("-", "");
  const mount = `/srv/stage1-snapshot/${suffix}`;
  const networkName = `s1r3net_${suffix}`;
  const volumeName = `s1r3data_${suffix}`;
  const pgId = "b".repeat(64);
  const networkId = "c".repeat(64);
  const pgImageId = digest("e");
  const pgDigest = digest("a");
  const labels = { "com.subscription.release.operation-ref": operationId };
  const containerName = `s1r3pg_${suffix}`;
  const volumePath = `${mount}/docker/volumes/${volumeName}/_data`;
  return {
    operationRef: operationId,
    workspaceMountPath: mount,
    engineId: "engine-synthetic",
    imageDigest: pgDigest,
    engine: {
      ID: "engine-synthetic",
      Driver: "overlay2",
      LoggingDriver: "json-file",
      DockerRootDir: `${mount}/docker`
    },
    image: {
      Id: pgImageId,
      RepoDigests: [`postgres@${pgDigest}`],
      Os: "linux",
      Architecture: "amd64"
    },
    container: {
      Id: pgId,
      Name: `/${containerName}`,
      Image: pgImageId,
      Config: { Image: `postgres:17-bookworm@${pgDigest}`, Labels: labels },
      State: { Running: true, Paused: false, Restarting: false, Dead: false, Pid: 321 },
      HostConfig: {
        NetworkMode: networkName,
        Privileged: false,
        PidMode: "",
        PortBindings: {},
        Binds: null
      },
      NetworkSettings: {
        Networks: { [networkName]: { NetworkID: networkId, IPAddress: "172.28.0.2" } },
        Ports: { "5432/tcp": null }
      },
      Mounts: [
        {
          Type: "volume",
          Name: volumeName,
          Source: volumePath,
          Destination: "/var/lib/postgresql/data",
          Driver: "local",
          RW: true
        }
      ]
    },
    network: {
      Id: networkId,
      Name: networkName,
      Driver: "bridge",
      Internal: true,
      Ingress: false,
      EnableIPv6: false,
      Labels: labels,
      Containers: { [pgId]: { Name: containerName, IPv4Address: "172.28.0.2/16" } }
    },
    volume: {
      Name: volumeName,
      Driver: "local",
      Mountpoint: volumePath,
      Options: null,
      Labels: labels
    },
    postgres: {
      systemIdentifier: "7340000000000000001",
      serverVersionNum: 170011,
      serverAddress: "172.28.0.2",
      serverPort: 5432,
      databaseName: "postgres",
      databaseOid: "5",
      role: "release_provisioner",
      tls: true,
      clusterMarker: "subscription-s1-controlled/v1"
    }
  };
}

function syntheticEngine(plan, pgBase, inventoryReadbacks) {
  const specs = applicationContainerSpecs(plan.identity);
  const images = new Map();
  const containers = new Map();
  const imageFor = (role) => {
    const reference = specs[role].body.Image;
    return {
      Id: digest({ api: "3", web: "4", browser: "7" }[role]),
      Os: "linux",
      Architecture: "amd64",
      RepoDigests: [role === "browser" ? reference.replace(":v1.62.1-noble@", "@") : reference],
      Config: {
        Cmd: specs[role].body.Cmd,
        Env: [],
        Labels: role === "browser" ? {} : { "org.opencontainers.image.revision": plan.sourceSha },
        Volumes: null
      }
    };
  };
  const containerFor = ({ role, id, state }) => {
    const spec = specs[role];
    const image = images.get(role);
    const address = `172.28.0.${3 + ["api", "web", "browser"].indexOf(role)}`;
    const running = state === "running";
    return {
      Id: id,
      Name: `/${spec.name}`,
      Image: image.Id,
      Config: {
        ...spec.body,
        Labels: { ...image.Config.Labels, ...spec.body.Labels },
        Env: spec.body.Env,
        Volumes: null
      },
      HostConfig: { ...spec.body.HostConfig, Binds: null, Mounts: [], AutoRemove: false },
      Mounts: [],
      State: {
        Status: state,
        Running: running,
        Paused: false,
        Restarting: false,
        Dead: false,
        OOMKilled: false,
        Error: "",
        Pid: running ? 101 + ["api", "web", "browser"].indexOf(role) : 0,
        ExitCode: 0
      },
      NetworkSettings: {
        Networks: {
          [spec.body.HostConfig.NetworkMode]: {
            NetworkID: state === "created" ? "" : pgBase.network.Id,
            EndpointID:
              state === "created"
                ? ""
                : ["8", "9", "a"][["api", "web", "browser"].indexOf(role)].repeat(64),
            IPAddress: state === "created" ? "" : address
          }
        },
        Ports: {}
      }
    };
  };
  const reply = (value) => Buffer.from(JSON.stringify(value));
  const engineCall = async (method, url, body, status) => {
    if (method === "POST" && url.startsWith("/images/create?")) {
      const reference = new URL(`http://engine${url}`).searchParams.get("fromImage");
      const role = ["api", "web", "browser"].find((name) => specs[name].body.Image === reference);
      assert.ok(role);
      images.set(role, imageFor(role));
      return Buffer.from('{"status":"downloaded"}\n');
    }
    if (url.startsWith("/images/")) {
      const reference = decodeURIComponent(
        url
          .slice(8)
          .split("?")[0]
          .replace(/\/json$/u, "")
      );
      const role = ["api", "web", "browser"].find((name) => specs[name].body.Image === reference);
      assert.ok(role);
      if (method === "DELETE") {
        images.delete(role);
        return reply([]);
      }
      return status === 404 ? reply({ message: "absent" }) : reply(images.get(role));
    }
    if (method === "POST" && url.startsWith("/containers/create?")) {
      const role = body.Labels["com.subscription.release.container-role"];
      const id = { api: "5", web: "6", browser: "8" }[role].repeat(64);
      containers.set(id, { role, id, state: "created" });
      return reply({ Id: id, Warnings: [] });
    }
    const match =
      /^\/containers\/([0-9a-f]{64})(?:\/json|\/start|\/stop\?t=10|\?force=1&v=1)$/u.exec(url);
    assert.ok(match, `unexpected Engine URL ${url}`);
    const id = match[1];
    const entry = containers.get(id);
    if (method === "POST" && url.endsWith("/start")) {
      entry.state = "running";
      return Buffer.alloc(0);
    }
    if (method === "POST" && url.endsWith("/stop?t=10")) {
      entry.state = "exited";
      return Buffer.alloc(0);
    }
    if (method === "DELETE") {
      containers.delete(id);
      return Buffer.alloc(0);
    }
    return status === 404 ? reply({ message: "absent" }) : reply(containerFor(entry));
  };
  const observe = async (snapshot) => {
    const resources = JSON.parse(JSON.stringify(pgBase));
    const imageObservations = snapshot.images.map((item) => images.get(item.role));
    const containerObservations = snapshot.containers.map((item) =>
      containerFor(containers.get(item.id))
    );
    resources.applicationResources = {
      identity: plan.identity,
      images: snapshot.images,
      containers: snapshot.containers,
      imageObservations,
      containerObservations
    };
    resources.engine.Containers = 1 + snapshot.containers.length;
    resources.engine.Images = 1 + snapshot.images.length;
    resources.containerInventory = [resources.container, ...containerObservations].map((value) => ({
      Id: value.Id,
      Names: [value.Name],
      ImageID: value.Image,
      Image: value.Config.Image,
      State: value.Id === resources.container.Id ? "running" : value.State.Status,
      Labels: value.Config.Labels
    }));
    resources.imageInventory = [resources.image, ...imageObservations].map((value) => ({
      Id: value.Id,
      RepoDigests: value.RepoDigests
    }));
    for (const item of snapshot.containers) {
      if (item.state !== "running") continue;
      const value = containerFor(containers.get(item.id));
      resources.network.Containers[item.id] = {
        Name: item.name,
        IPv4Address: `${value.NetworkSettings.Networks[specs[item.role].body.HostConfig.NetworkMode].IPAddress}/16`
      };
    }
    const pgBytes = Buffer.from(JSON.stringify(resources.postgres));
    const frame = Buffer.alloc(8);
    frame[0] = 1;
    frame.writeUInt32BE(pgBytes.length, 4);
    const readback = {
      resources,
      execution: { Id: "1".repeat(64) },
      streamBase64: Buffer.concat([frame, pgBytes]).toString("base64"),
      completed: { ContainerID: resources.container.Id, Running: false, ExitCode: 0 }
    };
    assessR3ApplicationPostgresReadback(readback);
    inventoryReadbacks.push(readback);
  };
  const openAttach = () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    return {
      stdin,
      stdout,
      stderr,
      ready: Promise.resolve(),
      completed: new Promise(() => {}),
      close: async () => {
        stdin.end();
        stdout.end();
        stderr.end();
      }
    };
  };
  return { engineCall, observe, openAttach };
}

async function observationFixture() {
  const context = contextFixture();
  const pgBase = postgresFixture();
  context.postgres = {
    ...assessR3PostgresObservation(pgBase),
    credentialRef: "synthetic-private-ref",
    status: "READY"
  };
  context.migration.input.postgres = {
    engineId: context.postgres.engineId,
    containerId: context.postgres.containerId,
    systemIdentifier: context.postgres.postgres.systemIdentifier
  };
  const plan = buildR3ApplicationPlan(context);
  const inventoryReadbacks = [];
  const engine = syntheticEngine(plan, pgBase, inventoryReadbacks);
  const apiSessionRows = [
    {
      database_oid: plan.target.databaseOid,
      usename: plan.target.runtimeRole,
      application_name: `subscription-api/${plan.identity.apiManifestId}/${plan.identity.apiSessionNonce}`,
      tls: true,
      state: "idle"
    }
  ];
  const evidence = {
    schemaVersion: "web-public-api-evidence.v1",
    operationId,
    buildProofDigest: sha256Canonical(context.buildProof),
    manifestDigest: sha256Canonical(plan.manifest),
    webOrigin: "http://web:3000",
    publicApiBase: plan.apiBaseUrl,
    embeddedApiBase: plan.apiBaseUrl,
    actualRequestUrl: `${plan.apiBaseUrl}/portal/catalog/model-definitions`,
    corsAllowOrigin: "http://web:3000",
    responseStatus: 200,
    bundleContainsEmbeddedApiBase: true,
    mockedNetwork: false,
    scriptSetDigest: digest("1"),
    networkSetDigest: digest("2"),
    observedAt: "2026-10-01T12:01:00.000Z"
  };
  const healthBody = { ok: true };
  const catalogBody = [];
  const httpOriginals = [
    { purpose: "health", url: "http://172.28.0.3:3001/api/health", status: 200, body: healthBody },
    {
      purpose: "catalog",
      url: `${plan.apiBaseUrl}/portal/catalog/model-definitions`,
      status: 200,
      body: catalogBody
    }
  ];
  const owned = await withR3ApplicationContainers({
    identity: plan.identity,
    signal: new globalThis.AbortController().signal,
    engineCall: engine.engineCall,
    recheck: async () => {},
    observe: engine.observe,
    readCredential: async () => ({
      username: plan.identity.runtimeRole,
      database: plan.identity.databaseName,
      password: "synthetic-password"
    }),
    openAttach: engine.openAttach,
    execute: async ({ api, web, assertRunning }) => {
      await assertRunning();
      const adapter = createFinalApplicationAdapters({
        composeProject: `s1r3app_${operationId.replaceAll("-", "")}`,
        chain: plan.chain,
        manifest: plan.manifest,
        buildProof: context.buildProof,
        operationId,
        apiManifestId: plan.identity.apiManifestId,
        apiSessionNonce: plan.identity.apiSessionNonce,
        runtime: {
          async start() {
            return {
              api: {
                reference: plan.identity.api.imageReference,
                imageDigest: plan.identity.api.imageDigest,
                sourceRevision: plan.sourceSha
              },
              web: {
                reference: plan.identity.web.imageReference,
                imageDigest: plan.identity.web.imageDigest,
                sourceRevision: plan.sourceSha
              },
              apiBase: `http://${api.address}:3001/api`,
              webBase: "http://web:3000",
              publicApiBase: plan.apiBaseUrl,
              embeddedApiBase: plan.apiBaseUrl
            };
          },
          async request({ purpose }) {
            return { status: 200, body: purpose === "health" ? healthBody : catalogBody };
          },
          async queryApiSessions() {
            return apiSessionRows;
          },
          async runBrowser() {
            return { ...evidence, traceDigest: hash(Buffer.from("synthetic trace bytes")) };
          }
        }
      });
      const startApplications = await adapter.startApplications({
        prepareTarget: {
          databaseOid: plan.target.databaseOid,
          runtimeRole: plan.target.runtimeRole
        }
      });
      const verifyApi = await adapter.verifyApi({ startApplications });
      const verifyWebClient = await adapter.verifyWebClient({ startApplications, verifyApi });
      await assertRunning();
      assert.equal(web.address, "172.28.0.4");
      return { startApplications, verifyApi, verifyWebClient };
    }
  });
  assert.equal(owned.cleaned, true);
  const sourceDigests = {};
  for (const name of ["playwright.release.config.ts", "tests/release/web-public-api.spec.ts"])
    sourceDigests[name] = hash(await readFile(path.join(repoRoot, name)));
  const trace = Buffer.from("synthetic trace bytes");
  const ca = new X509Certificate(Buffer.from(CA_PEM_BASE64, "base64"));
  const server = new X509Certificate(Buffer.from(SERVER_PEM_BASE64, "base64"));
  const lock = loadYaml(await readFile(path.join(repoRoot, "pnpm-lock.yaml"), "utf8"));
  const packageNames = ["@playwright/test", "playwright", "playwright-core"];
  const packageDigests = [
    "009534220efd98c0361d8c4ee7e3db1ed510ab88a23e98b5081ef1c8fed64965",
    "1982556a882b246ccb7c16337fab5e4e790292b69f835a2db1011dddc440ed98",
    "954be1e183d0ddb9748fe0d2d08b0b66a9210c74dd75c397aeb70303b9f08a00"
  ];
  const observation = {
    schemaVersion: "r3-final-application-observation.v1",
    plan,
    observations: owned.value,
    httpOriginals,
    apiSessionRows,
    browserOriginal: {
      evidence,
      traceBase64: trace.toString("base64"),
      traceDigest: hash(trace),
      proxyConnectCount: 1,
      overlayDigest: "sha256:f0f8e6dec5aa248fa13ccafb93169424c25f3ad92a9a460463c4857e03341d15",
      sourceDigests
    },
    tls: {
      metadata: {
        operationRef: operationId,
        apiBaseUrl: plan.apiBaseUrl,
        caCertificateDigest: hash(ca.raw),
        serverCertificateDigest: hash(server.raw),
        serverPublicKeyDigest: hash(server.publicKey.export({ type: "spki", format: "der" })),
        notBefore: new Date(Date.parse(server.validFrom)).toISOString(),
        notAfter: new Date(Date.parse(server.validTo)).toISOString(),
        nssCertificateDigest: hash(ca.raw)
      },
      caPemBase64: CA_PEM_BASE64,
      serverPemBase64: SERVER_PEM_BASE64
    },
    packages: packageNames.map((name, index) => ({
      name,
      version: "1.62.1",
      integrity: lock.packages[`${name}@1.62.1`].resolution.integrity,
      digest: packageDigests[index]
    })),
    containers: owned.originals,
    tlsCleaned: true,
    promotionEligible: false
  };
  return { context, observation, inventoryReadbacks };
}

test("rebuilds adapter results from valid private TLS, browser, Engine, and PG originals", async () => {
  const { context, observation, inventoryReadbacks } = await observationFixture();
  const result = await assessR3ApplicationOriginals({
    context,
    observation,
    inventoryReadbacks,
    repoRoot
  });
  assert.equal(result.schemaVersion, "r3-final-application-originals-assessment.v1");
  assert.deepEqual(
    result.applicationResources.map(({ role }) => role),
    ["api", "web", "browser"]
  );
  assert.equal(result.inventoryReadbackDigests.length, inventoryReadbacks.length);
  assert.equal(result.browserTraceDigest, observation.browserOriginal.traceDigest);
  assert.equal(result.promotionEligible, false);
});

test("rejects an observed plan that differs from the independently rebuilt plan", async () => {
  const { context, observation, inventoryReadbacks } = await observationFixture();
  observation.plan = { ...observation.plan, apiBaseUrl: "https://foreign.example.test/api" };
  await assert.rejects(
    assessR3ApplicationOriginals({ context, observation, inventoryReadbacks, repoRoot }),
    invalid
  );
});

test("rejects a trace whose canonical bytes do not match its SHA-256 claim", async () => {
  const { context, observation, inventoryReadbacks } = await observationFixture();
  observation.browserOriginal.traceDigest = digest("f");
  await assert.rejects(
    assessR3ApplicationOriginals({ context, observation, inventoryReadbacks, repoRoot }),
    invalid
  );
});

test("rejects browser source custody when a source digest is forged", async () => {
  const { context, observation, inventoryReadbacks } = await observationFixture();
  observation.browserOriginal.sourceDigests["playwright.release.config.ts"] = digest("f");
  await assert.rejects(
    assessR3ApplicationOriginals({ context, observation, inventoryReadbacks, repoRoot }),
    invalid
  );
});
