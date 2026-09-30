// Independent reconstruction of a held final application attempt. This grants no success authority.
import { Buffer } from "node:buffer";
import { createHash, X509Certificate } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { TextDecoder } from "node:util";
import { URL } from "node:url";
import { load as loadYaml, JSON_SCHEMA } from "js-yaml";
import { sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { createFinalApplicationAdapters } from "./final-compose-application-adapters.mjs";
import {
  applicationContainerSpecs,
  assessR3ApplicationContainer,
  assessR3ApplicationImage
} from "./r3-application-containers.mjs";
import { R3_BROWSER_ENTRYPOINT, R3_BROWSER_IMAGE } from "./r3-browser-runtime.mjs";
import { assessR3ApplicationPostgresReadback } from "./r3-destination.mjs";
import { buildR3ApplicationPlan } from "./r3-final-application.mjs";

const CODE = "R3_APPLICATION_ORIGINALS_INVALID";
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const BARE_DIGEST = /^[0-9a-f]{64}$/u;
const CID = /^[0-9a-f]{64}$/u;
const ROLES = ["api", "web", "browser"];
const PACKAGE_HASHES = [
  ["@playwright/test", "009534220efd98c0361d8c4ee7e3db1ed510ab88a23e98b5081ef1c8fed64965"],
  ["playwright", "1982556a882b246ccb7c16337fab5e4e790292b69f835a2db1011dddc440ed98"],
  ["playwright-core", "954be1e183d0ddb9748fe0d2d08b0b66a9210c74dd75c397aeb70303b9f08a00"]
];
const OVERLAY =
  'import base from "./playwright.release.config";\nexport default { ...base, use: { ...base.use, proxy: { server: "http://127.0.0.1:8080" } } };\n';
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const need = (value) => {
  if (!value) fail();
};
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const empty = (value) =>
  value == null || (typeof value === "object" && Object.keys(value).length === 0);
const exact = (value, expected) =>
  need(
    object(value) &&
      Reflect.ownKeys(value).length === expected.length &&
      expected.every((key) => Object.hasOwn(value, key))
  );
const same = (left, right) => sha256Canonical(left) === sha256Canonical(right);
const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const freeze = (value) => {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};

function base64(value, maximum) {
  need(typeof value === "string" && value.length <= Math.ceil(maximum / 3) * 4 + 4);
  const bytes = Buffer.from(value, "base64");
  need(bytes.length > 0 && bytes.length <= maximum && bytes.toString("base64") === value);
  return bytes;
}

async function sourceOriginals(repoRoot, browserOriginal) {
  exact(browserOriginal.sourceDigests, [
    "playwright.release.config.ts",
    "tests/release/web-public-api.spec.ts"
  ]);
  const digests = {};
  for (const name of Object.keys(browserOriginal.sourceDigests)) {
    const file = path.join(repoRoot, name);
    need((await stat(file)).size <= 1048576);
    const bytes = await readFile(file);
    need(bytes.length > 0 && bytes.length <= 1048576);
    digests[name] = hash(bytes);
    need(browserOriginal.sourceDigests[name] === digests[name]);
    if (name === "playwright.release.config.ts") {
      const text = bytes.toString("utf8");
      need(/ignoreHTTPSErrors:\s*false\b/u.test(text));
      need(!/ignoreHTTPSErrors:\s*true\b|rejectUnauthorized:\s*false\b/u.test(text));
    } else {
      const text = bytes.toString("utf8");
      need(!/\b(?:page|context)\.route\s*\(|\broute\.fulfill\s*\(/u.test(text));
    }
  }
  return digests;
}

async function packageOriginals(repoRoot, packages) {
  need(Array.isArray(packages) && packages.length === 3);
  const filename = path.join(repoRoot, "pnpm-lock.yaml");
  need((await stat(filename)).size <= 4 * 1024 * 1024);
  const raw = await readFile(filename);
  need(raw.length > 0 && raw.length <= 4 * 1024 * 1024);
  const lock = loadYaml(raw.toString("utf8"), { schema: JSON_SCHEMA });
  need(
    lock?.lockfileVersion === "9.0" &&
      lock.importers?.["."]?.devDependencies?.["@playwright/test"]?.specifier === "1.62.1" &&
      lock.importers["."].devDependencies["@playwright/test"].version === "1.62.1" &&
      lock.snapshots?.["@playwright/test@1.62.1"]?.dependencies?.playwright === "1.62.1" &&
      lock.snapshots?.["playwright@1.62.1"]?.dependencies?.["playwright-core"] === "1.62.1"
  );
  return packages.map((item, index) => {
    exact(item, ["name", "version", "integrity", "digest"]);
    const [name, digest] = PACKAGE_HASHES[index];
    const record = lock.packages?.[`${name}@1.62.1`]?.resolution;
    need(
      item.name === name &&
        item.version === "1.62.1" &&
        BARE_DIGEST.test(item.digest) &&
        item.digest === digest &&
        object(record) &&
        Reflect.ownKeys(record).length === 1 &&
        /^sha512-[A-Za-z0-9+/]{86}==$/u.test(record.integrity ?? "") &&
        item.integrity === record.integrity
    );
    return { name, version: item.version, digest: item.digest, integrity: item.integrity };
  });
}

function tlsOriginals(observation, plan, browserTime) {
  exact(observation, ["metadata", "caPemBase64", "serverPemBase64"]);
  const ca = new X509Certificate(base64(observation.caPemBase64, 1048576));
  const server = new X509Certificate(base64(observation.serverPemBase64, 1048576));
  const metadata = observation.metadata;
  exact(metadata, [
    "operationRef",
    "apiBaseUrl",
    "caCertificateDigest",
    "serverCertificateDigest",
    "serverPublicKeyDigest",
    "notBefore",
    "notAfter",
    "nssCertificateDigest"
  ]);
  const url = new URL(plan.apiBaseUrl);
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  const serverFrom = Date.parse(server.validFrom);
  const serverTo = Date.parse(server.validTo);
  const caFrom = Date.parse(ca.validFrom);
  const caTo = Date.parse(ca.validTo);
  const time = Date.parse(browserTime);
  need(
    Number.isFinite(time) &&
      Number.isFinite(serverFrom) &&
      Number.isFinite(serverTo) &&
      Number.isFinite(caFrom) &&
      Number.isFinite(caTo) &&
      metadata.operationRef === plan.operationRef &&
      metadata.apiBaseUrl === plan.apiBaseUrl &&
      metadata.caCertificateDigest === hash(ca.raw) &&
      metadata.nssCertificateDigest === hash(ca.raw) &&
      metadata.serverCertificateDigest === hash(server.raw) &&
      metadata.serverPublicKeyDigest ===
        hash(server.publicKey.export({ type: "spki", format: "der" })) &&
      metadata.notBefore === new Date(serverFrom).toISOString() &&
      metadata.notAfter === new Date(serverTo).toISOString() &&
      ca.ca &&
      !server.ca &&
      ca.subject === ca.issuer &&
      server.issuer === ca.subject &&
      ca.verify(ca.publicKey) &&
      server.verify(ca.publicKey) &&
      (isIP(host) ? server.checkIP(host) === host : server.checkHost(host) === host) &&
      server.subjectAltName === `${isIP(host) ? "IP Address" : "DNS"}:${host}` &&
      server.keyUsage?.includes("1.3.6.1.5.5.7.3.1") &&
      caFrom <= time &&
      time < caTo &&
      serverFrom <= time &&
      time < serverTo &&
      caTo - caFrom <= 25 * 3600000 &&
      serverTo - serverFrom <= 25 * 3600000
  );
  return { caDigest: hash(ca.raw), serverDigest: hash(server.raw) };
}

function readExchange(entry) {
  exact(entry, ["method", "url", "status", "requestBody", "bodyBase64"]);
  need(
    ["GET", "POST", "DELETE"].includes(entry.method) &&
      typeof entry.url === "string" &&
      Number.isInteger(entry.status) &&
      typeof entry.bodyBase64 === "string" &&
      entry.bodyBase64.length <= Math.ceil((8 * 1024 * 1024) / 3) * 4 + 4
  );
  const bytes = Buffer.from(entry.bodyBase64, "base64");
  need(bytes.length <= 8 * 1024 * 1024 && bytes.toString("base64") === entry.bodyBase64);
  return { ...entry, bytes };
}

function lifecycleOriginals(originals, identity) {
  exact(originals, ["operationRef", "sourceSha", "specDigest", "exchanges", "streams", "cleaned"]);
  const specs = applicationContainerSpecs(identity);
  need(
    originals.operationRef === identity.operationRef &&
      originals.sourceSha === identity.sourceSha &&
      originals.specDigest === sha256Canonical(specs) &&
      originals.cleaned === true &&
      Array.isArray(originals.exchanges) &&
      originals.exchanges.length >= 42 &&
      originals.exchanges.length <= 128
  );
  const log = originals.exchanges.map(readExchange);
  let position = 0;
  const take = (method, url, status, body = null) => {
    const item = log[position++];
    need(
      item?.method === method &&
        item.url === url &&
        item.status === status &&
        same(item.requestBody, body)
    );
    return item;
  };
  const json = (item) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(item.bytes));
  const held = [];
  for (const role of ROLES) {
    const spec = specs[role];
    const reference = spec.body.Image;
    const pull = take(
      "POST",
      `/images/create?fromImage=${encodeURIComponent(reference)}&platform=linux%2Famd64`,
      200
    );
    const progress = pull.bytes
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    need(progress.length > 0 && progress.every((entry) => !entry.error && !entry.errorDetail));
    const image = json(take("GET", `/images/${encodeURIComponent(reference)}/json`, 200));
    assessR3ApplicationImage({ identity, role, image });
    const created = json(take("POST", `/containers/create?name=${spec.name}`, 201, spec.body));
    need(CID.test(created?.Id) && empty(created.Warnings));
    const id = created.Id;
    need(!held.some((item) => item.id === id || item.image.Id === image.Id));
    const createdContainer = json(take("GET", `/containers/${id}/json`, 200));
    assessR3ApplicationContainer({
      identity,
      role,
      id,
      state: "created",
      image,
      container: createdContainer
    });
    take("POST", `/containers/${id}/start`, 204);
    const running = json(take("GET", `/containers/${id}/json`, 200));
    const facts = assessR3ApplicationContainer({
      identity,
      role,
      id,
      state: "running",
      image,
      container: running
    });
    held.push({ role, reference, image, id, running, spec, address: facts.address });
  }
  const firstStop = `POST /containers/${held[2].id}/stop?t=10`;
  while (position < log.length && `${log[position].method} ${log[position].url}` !== firstStop) {
    const entry = log[position++];
    const item = held.find((value) => entry.url === `/containers/${value.id}/json`);
    need(item && entry.method === "GET" && entry.status === 200 && same(entry.requestBody, null));
    assessR3ApplicationContainer({
      identity,
      role: item.role,
      id: item.id,
      state: "running",
      image: item.image,
      container: json(entry)
    });
  }
  for (const [index, item] of [...held].reverse().entries()) {
    // The browser pre-stop readback was included in the running inspection loop.
    if (index > 0) {
      const running = json(take("GET", `/containers/${item.id}/json`, 200));
      assessR3ApplicationContainer({
        identity,
        role: item.role,
        id: item.id,
        state: "running",
        image: item.image,
        container: running
      });
    }
    take("POST", `/containers/${item.id}/stop?t=10`, 204);
    const stopped = json(take("GET", `/containers/${item.id}/json`, 200));
    need(
      stopped.Id === item.id &&
        stopped.Image === item.image.Id &&
        stopped.Name === `/${item.spec.name}` &&
        same(stopped.Config, item.running.Config) &&
        same(stopped.HostConfig, item.running.HostConfig) &&
        stopped.State?.Status === "exited" &&
        stopped.State.Running === false &&
        stopped.State.Pid === 0 &&
        [0, 143].includes(stopped.State.ExitCode)
    );
    take("DELETE", `/containers/${item.id}?force=1&v=1`, 204);
    take("GET", `/containers/${item.id}/json`, 404);
  }
  for (const item of [...held].reverse()) {
    take("DELETE", `/images/${encodeURIComponent(item.reference)}?force=0&noprune=1`, 200);
    take("GET", `/images/${encodeURIComponent(item.reference)}/json`, 404);
  }
  need(position === log.length);
  exact(originals.streams, ROLES);
  for (const role of ROLES) {
    exact(originals.streams[role], role === "browser" ? ["stderr"] : ["stdout", "stderr"]);
    for (const summary of Object.values(originals.streams[role])) {
      exact(summary, ["bytes", "digest"]);
      need(Number.isSafeInteger(summary.bytes) && summary.bytes >= 0 && summary.bytes <= 4194304);
      need(DIGEST.test(summary.digest));
    }
  }
  return held.map(({ role, id, image, address }) => ({
    role,
    containerId: id,
    imageId: image.Id,
    address
  }));
}

async function replayAdapters(context, plan, observation) {
  exact(observation.observations, ["startApplications", "verifyApi", "verifyWebClient"]);
  need(Array.isArray(observation.httpOriginals) && observation.httpOriginals.length === 2);
  const expectedCalls = [
    ["health", `${observation.observations.startApplications.apiBase}/health`],
    [
      "catalog",
      new URL(
        "portal/catalog/model-definitions",
        `${observation.observations.startApplications.publicApiBase}/`
      ).toString()
    ]
  ];
  let requestIndex = 0;
  const runtime = {
    async start() {
      const source = observation.observations.startApplications;
      return Object.fromEntries(
        ["api", "web", "apiBase", "webBase", "publicApiBase", "embeddedApiBase"].map((key) => [
          key,
          source[key]
        ])
      );
    },
    async request({ purpose, url }) {
      const item = observation.httpOriginals[requestIndex];
      const expected = expectedCalls[requestIndex++];
      need(expected && item?.purpose === purpose && purpose === expected[0] && item.url === url);
      need(url === expected[1] && item.status === 200 && Object.hasOwn(item, "body"));
      exact(item, ["purpose", "url", "status", "body"]);
      return { status: item.status, body: item.body };
    },
    async queryApiSessions() {
      return observation.apiSessionRows;
    },
    async runBrowser() {
      return {
        ...observation.browserOriginal.evidence,
        traceDigest: observation.browserOriginal.traceDigest
      };
    }
  };
  const adapter = createFinalApplicationAdapters({
    composeProject: `s1r3app_${plan.operationRef.replaceAll("-", "")}`,
    chain: plan.chain,
    manifest: plan.manifest,
    buildProof: context.buildProof,
    operationId: plan.operationRef,
    apiManifestId: plan.identity.apiManifestId,
    apiSessionNonce: plan.identity.apiSessionNonce,
    runtime
  });
  const startApplications = await adapter.startApplications({
    prepareTarget: {
      databaseOid: plan.target.databaseOid,
      runtimeRole: plan.target.runtimeRole
    }
  });
  need(same(startApplications, observation.observations.startApplications));
  const verifyApi = await adapter.verifyApi({ startApplications });
  need(requestIndex === 2 && same(verifyApi, observation.observations.verifyApi));
  need(same(observation.apiSessionRows, verifyApi.apiSessionRows));
  const verifyWebClient = await adapter.verifyWebClient({ startApplications, verifyApi });
  need(same(verifyWebClient, observation.observations.verifyWebClient));
  return { startApplications, verifyApi, verifyWebClient };
}

export async function assessR3ApplicationOriginals({
  context,
  observation,
  inventoryReadbacks,
  repoRoot
}) {
  try {
    need(typeof repoRoot === "string" && path.isAbsolute(repoRoot));
    exact(observation, [
      "schemaVersion",
      "plan",
      "observations",
      "httpOriginals",
      "apiSessionRows",
      "browserOriginal",
      "tls",
      "packages",
      "containers",
      "tlsCleaned",
      "promotionEligible"
    ]);
    const plan = buildR3ApplicationPlan(context);
    need(
      observation.schemaVersion === "r3-final-application-observation.v1" &&
        same(observation.plan, plan) &&
        observation.tlsCleaned === true &&
        observation.promotionEligible === false
    );
    const browser = observation.browserOriginal;
    exact(browser, [
      "evidence",
      "traceBase64",
      "traceDigest",
      "proxyConnectCount",
      "overlayDigest",
      "sourceDigests"
    ]);
    const trace = base64(browser.traceBase64, 8 * 1024 * 1024);
    need(
      DIGEST.test(browser.traceDigest) &&
        hash(trace) === browser.traceDigest &&
        Number.isSafeInteger(browser.proxyConnectCount) &&
        browser.proxyConnectCount > 0 &&
        browser.overlayDigest === hash(Buffer.from(OVERLAY)) &&
        browser.evidence?.observedAt &&
        Date.parse(browser.evidence.observedAt) >= Date.parse(plan.manifest.provenance.generatedAt)
    );
    const sourceDigests = await sourceOriginals(repoRoot, browser);
    const packages = await packageOriginals(repoRoot, observation.packages);
    const tls = tlsOriginals(observation.tls, plan, browser.evidence.observedAt);
    const specs = applicationContainerSpecs(plan.identity);
    need(
      specs.browser.body.Image === R3_BROWSER_IMAGE &&
        same(specs.browser.body.Entrypoint, R3_BROWSER_ENTRYPOINT) &&
        specs.browser.body.HostConfig.ReadonlyRootfs === true &&
        !specs.browser.body.Env.some((entry) =>
          /^(?:NODE_TLS_REJECT_UNAUTHORIZED|NODE_OPTIONS)=/u.test(entry)
        )
    );
    const held = lifecycleOriginals(observation.containers, plan.identity);
    const started = observation.observations.startApplications;
    need(
      started?.apiBase === `http://${held[0].address}:3001/api` &&
        started.webBase === "http://web:3000" &&
        started.publicApiBase === plan.apiBaseUrl &&
        started.embeddedApiBase === plan.apiBaseUrl
    );
    need(
      Array.isArray(inventoryReadbacks) &&
        inventoryReadbacks.length >= 2 &&
        inventoryReadbacks.length <= 32
    );
    const inventoryDigests = [];
    let allRunning = false;
    for (const readback of inventoryReadbacks) {
      const facts = assessR3ApplicationPostgresReadback(readback);
      const resources = readback.resources.applicationResources;
      need(same(resources.identity, plan.identity));
      for (const [key, value] of Object.entries(context.postgres)) {
        if (["credentialRef", "status"].includes(key)) continue;
        need(Object.hasOwn(facts, key) && same(facts[key], value));
      }
      need(
        resources.images.every((item) =>
          held.some((one) => one.role === item.role && one.imageId === item.imageId)
        ) &&
          resources.containers.every((item) =>
            held.some((one) => one.role === item.role && one.containerId === item.id)
          )
      );
      if (
        resources.images.length === 3 &&
        resources.containers.length === 3 &&
        resources.containers.every((item) => item.state === "running")
      )
        allRunning = true;
      inventoryDigests.push(sha256Canonical(readback));
    }
    for (const readback of [inventoryReadbacks[0], inventoryReadbacks.at(-1)]) {
      need(
        readback.resources.applicationResources.images.length === 0 &&
          readback.resources.applicationResources.containers.length === 0 &&
          readback.resources.containerInventory.length === 1 &&
          readback.resources.imageInventory.length === 1
      );
    }
    need(allRunning);
    const replay = await replayAdapters(context, plan, observation);
    return freeze({
      schemaVersion: "r3-final-application-originals-assessment.v1",
      operationRef: plan.operationRef,
      planDigest: sha256Canonical(plan),
      observationDigest: sha256Canonical(observation),
      migrationObservationDigest: plan.migrationObservationDigest,
      containerSpecDigest: observation.containers.specDigest,
      applicationResources: held,
      inventoryReadbackDigests: inventoryDigests,
      apiReadinessDigest: replay.verifyApi.apiReadiness.evidenceDigest,
      browserEvidenceDigest: replay.verifyWebClient.evidenceDigest,
      browserTraceDigest: browser.traceDigest,
      overlayDigest: browser.overlayDigest,
      sourceDigests,
      packageDigests: packages.map(({ name, digest }) => ({ name, digest })),
      tls,
      promotionEligible: false
    });
  } catch {
    fail();
  }
}
