// GitHub-hosted, read-only custody step. No H1 access or decryption credentials.
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { readFile, mkdir, open, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import process from "node:process";
import { fileURLToPath, URL, URLSearchParams } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { validateContract } from "../../packages/release-foundation/src/schema-registry.mjs";
import { validateSnapshotCustody } from "../../packages/release-foundation/src/snapshot/custody-contracts.mjs";
import { createSnapshotReaderTransport } from "./snapshot-oss-storage.mjs";
import { readH1SnapshotPublication, readPublicSnapshotJson } from "./snapshot-h1-publication.mjs";

const REPOSITORY = "keqi119/subscription-Saas";
const WORKFLOW = ".github/workflows/sanitized-snapshot.yml";
const ACCOUNT = "1457643390906675";
const BUCKET = "subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai";
const ROLE = `acs:ram::${ACCOUNT}:role/subscription-saas-stage1-snapshot-custody-reader`;
const PROVIDER = `acs:ram::${ACCOUNT}:oidc-provider/github-actions-stage1`;
const CODE = "SNAPSHOT_CUSTODY_JOB_REJECTED";
const requireThat = (value) => {
  if (!value) throw Object.assign(new Error(CODE), { code: CODE });
};

export function snapshotCustodyContext(env, authorization) {
  validateContract("rc-dispatch-authorization.v1", authorization);
  requireThat(
    env.GITHUB_ACTIONS === "true" &&
      env.RUNNER_ENVIRONMENT === "github-hosted" &&
      env.GITHUB_REPOSITORY === REPOSITORY &&
      env.GITHUB_REPOSITORY_ID === "1253231368" &&
      env.GITHUB_ACTOR_ID === "275060624" &&
      env.GITHUB_RUN_ATTEMPT === "1" &&
      env.GITHUB_REF === "refs/heads/main" &&
      env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
      env.GITHUB_JOB === "snapshot-custody" &&
      env.GITHUB_WORKFLOW_REF === `${REPOSITORY}/${WORKFLOW}@refs/heads/main` &&
      /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID) &&
      authorization.sourceSha === env.GITHUB_SHA &&
      authorization.producerWorkflow.path === WORKFLOW &&
      authorization.producerWorkflow.ref === "main" &&
      /^sha256:[0-9a-f]{64}$/.test(env.STAGE1_SNAPSHOT_ACCESS_POLICY_DIGEST ?? "")
  );
  return {
    releaseAttemptId: authorization.releaseAttemptId,
    snapshotRunId: env.GITHUB_RUN_ID,
    sourceSha: env.GITHUB_SHA,
    dispatchAuthorizationDigest: sha256Canonical(authorization)
  };
}

async function readerSession(env, runId) {
  const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  requireThat(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      /^[a-z0-9-]+\.actions\.githubusercontent\.com$/.test(url.hostname) &&
      typeof env.ACTIONS_ID_TOKEN_REQUEST_TOKEN === "string" &&
      env.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length > 0
  );
  url.searchParams.set("audience", "sts.aliyuncs.com");
  const tokenResponse = await globalThis.fetch(url, {
    redirect: "error",
    signal: globalThis.AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }
  });
  requireThat(tokenResponse.status === 200);
  const token = (await tokenResponse.json()).value;
  requireThat(typeof token === "string" && token.length > 4 && token.length <= 20000);
  const sessionName = `stage1-reader-${runId}-attempt-1`;
  const request = new URLSearchParams({
    Action: "AssumeRoleWithOIDC",
    Version: "2015-04-01",
    Format: "JSON",
    OIDCProviderArn: PROVIDER,
    RoleArn: ROLE,
    RoleSessionName: sessionName,
    DurationSeconds: "900",
    OIDCToken: token
  });
  const response = await globalThis.fetch("https://sts.aliyuncs.com/", {
    method: "POST",
    redirect: "error",
    signal: globalThis.AbortSignal.timeout(30000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: request.toString()
  });
  requireThat(response.status === 200);
  const body = await response.json(),
    now = Date.now(),
    info = body.OIDCTokenInfo,
    credentials = body.Credentials;
  requireThat(
    body.AssumedRoleUser?.Arn === `${ROLE}/${sessionName}` &&
      info?.Issuer === "https://token.actions.githubusercontent.com" &&
      info.Subject === `repo:${REPOSITORY}:environment:stage1-snapshot-custody` &&
      info.ClientIds === "sts.aliyuncs.com" &&
      info.VerificationInfo === "Success" &&
      Date.parse(info.IssuanceTime) <= now &&
      Date.parse(info.ExpirationTime) > now &&
      Date.parse(credentials?.Expiration) > now &&
      Date.parse(credentials.Expiration) <= now + 900000
  );
  return {
    arn: body.AssumedRoleUser.Arn,
    accessKeyId: credentials.AccessKeyId,
    accessKeySecret: credentials.AccessKeySecret,
    stsToken: credentials.SecurityToken,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(credentials.Expiration).toISOString()
  };
}

export function provisionalSnapshotCustody(readback, accessPolicyDigest) {
  const envelope = readback.data.data.envelope;
  const object = readback.publication.objects[0];
  const observed = readback.observations.find((item) => item.get.key === object.key);
  requireThat(readback.status === "READBACK_VERIFIED" && observed);
  const select = (value) =>
    Object.fromEntries(
      ["key", "version", "etag", "digest", "sizeBytes"].map((key) => [key, value[key]])
    );
  const receipt = {
    schemaVersion: "snapshot-private-custody.v1",
    releaseAttemptId: envelope.releaseAttemptId,
    snapshotRunId: envelope.snapshotRunId,
    sourceSha: envelope.sourceSha,
    bucket: {
      name: BUCKET,
      region: "oss-cn-shanghai",
      fingerprint: sha256Canonical({ accountId: ACCOUNT, name: BUCKET, region: "oss-cn-shanghai" })
    },
    object: {
      key: object.key,
      version: observed.get.version,
      etag: observed.get.etag,
      ciphertextDigest: envelope.ciphertextDigest,
      ciphertextSizeBytes: envelope.ciphertextSizeBytes,
      envelopeDigest: sha256Canonical(envelope)
    },
    conditionalCreate: { result: "CREATED", forbidOverwrite: true, requestId: object.requestId },
    headReadback: select(observed.head),
    getReadback: select(observed.get),
    identities: { writer: observed.expectedWriterArn, reader: observed.readerArn },
    acl: observed.bucket.acl,
    // Operator-pinned digest from the separately approved RAM policy readback.
    // This job observes OSS custody, not RAM policy administration. A final
    // acceptance must retain the original policy readback matching this digest.
    accessPolicyDigest,
    expiresAt: envelope.expiresAt,
    terminalAt: null,
    provisional: true,
    downstreamRetainUntil: new Date(Date.parse(envelope.expiresAt) + 180 * 86400000).toISOString(),
    legalHoldUntil: null,
    worm: {
      id: observed.bucket.worm.id,
      state: observed.bucket.worm.state,
      retentionDays: observed.bucket.worm.retentionDays,
      lastModified: observed.get.lastModified,
      retainUntil: new Date(
        Date.parse(observed.get.lastModified) + observed.bucket.worm.retentionDays * 86400000
      ).toISOString(),
      readbackAt: readback.observedAt
    },
    authoritativeObservationDigest: sha256Canonical(readback)
  };
  validateSnapshotCustody(receipt, { allowProvisional: true });
  return receipt;
}

async function main() {
  requireThat(process.argv.length === 2);
  const env = process.env,
    encoded = env.STAGE1_DISPATCH_AUTHORIZATION_BASE64;
  requireThat(typeof encoded === "string" && encoded.length <= 1398104);
  const bytes = Buffer.from(encoded, "base64");
  requireThat(bytes.toString("base64") === encoded);
  const authorization = readPublicSnapshotJson(bytes),
    expected = snapshotCustodyContext(env, authorization);
  requireThat(
    execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim() === expected.sourceSha
  );
  const workflow = await readFile(new URL(`../../${WORKFLOW}`, import.meta.url));
  requireThat(sha256Bytes(workflow) === authorization.producerWorkflow.blobDigest);
  const profile = readPublicSnapshotJson(
    Buffer.from(
      canonicalJson(
        JSON.parse(
          await readFile(
            new URL("../../release/contracts/manual-stage1-profile.v2.json", import.meta.url),
            "utf8"
          )
        )
      )
    )
  );
  requireThat(
    sha256Canonical(profile) ===
      "sha256:49df6dae67aa386086f207e79e8c221ec61e466b9a19c2422d77878f621fd541" &&
      Date.parse(profile.validFrom) <= Date.now() &&
      Date.now() < Date.parse(profile.expiresAt)
  );
  const signer = {
    issuer: profile.ownerId,
    keyId: profile.keyFingerprint,
    publicKey: profile.publicKeyPem
  };
  const writerArn = `acs:ram::${ACCOUNT}:assumed-role/subscription-saas-stage1-snapshot-publisher/stage1-publisher-${expected.snapshotRunId}-attempt-1`;
  const reader = await createSnapshotReaderTransport({
    releaseAttemptId: expected.releaseAttemptId,
    snapshotRunId: expected.snapshotRunId,
    writerArn,
    session: await readerSession(env, expected.snapshotRunId)
  });
  let readback;
  const deadline = Date.now() + 600000;
  while (!readback) {
    try {
      readback = await readH1SnapshotPublication({ reader, expected, signer });
    } catch (error) {
      if (error?.code !== "SNAPSHOT_OSS_OBJECT_NOT_READY" || Date.now() >= deadline) throw error;
      await delay(5000);
    }
  }
  const custody = provisionalSnapshotCustody(readback, env.STAGE1_SNAPSHOT_ACCESS_POLICY_DIGEST);
  const directory = ".release-output";
  await mkdir(directory, { mode: 0o700, recursive: false }).catch((error) => {
    if (error?.code !== "EEXIST") throw error;
  });
  const stat = await lstat(directory);
  requireThat(stat.isDirectory() && !stat.isSymbolicLink());
  for (const [name, value] of [
    ["snapshot-custody-readback.json", readback],
    ["snapshot-private-custody.v1.json", custody]
  ]) {
    const file = await open(
      `${directory}/${name}`,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    try {
      await file.writeFile(canonicalJson(value));
      await file.sync();
    } finally {
      await file.close();
    }
  }
  process.stdout.write("SNAPSHOT_CUSTODY_PROVISIONAL_VERIFIED\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main().catch(() => {
    process.stderr.write(`${CODE}\n`);
    process.exitCode = 1;
  });
