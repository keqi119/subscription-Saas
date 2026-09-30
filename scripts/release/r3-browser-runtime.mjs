// Fixed browser tooling inside the held Engine. This is not a release gate.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const R3_BROWSER_IMAGE =
  "mcr.microsoft.com/playwright:v1.62.1-noble@sha256:c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac";
const CODE = "R3_BROWSER_RUNTIME_FAILED";
const fail = () => Object.assign(new Error(CODE), { code: CODE });
const need = (condition) => {
  if (!condition) throw fail();
};
const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

// Serialized as the fixed container entrypoint; all imports and state are local.
async function browserProgram() {
  const fs = require("node:fs/promises");
  const http = require("node:http");
  const https = require("node:https");
  const net = require("node:net");
  const tls = require("node:tls");
  const { spawn } = require("node:child_process");
  const { createHash } = require("node:crypto");
  const root = "/tmp/r3-browser";
  const code = "R3_BROWSER_RUNTIME_FAILED";
  const check = (value) => {
    if (!value) throw new Error(code);
  };
  const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  let initialized = false,
    busy = false,
    sequence = 0,
    buffered = Buffer.alloc(0),
    state;
  let tlsServer,
    proxy,
    browserRun = false,
    connections = 0;
  const sockets = new Set();
  const deadline = setTimeout(() => process.exit(1), 180000);
  const write = (id, result) => process.stdout.write(`${JSON.stringify({ id, result })}\n`);
  const bad = () => {
    process.stderr.write(`${code}\n`);
    process.exit(1);
  };
  const run = (executable, args, env, timeout) =>
    new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd: root, env, stdio: "ignore", shell: false });
      const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error(code));
      });
      child.once("exit", (exitCode, signal) => {
        clearTimeout(timer);
        if (exitCode !== 0 || signal) reject(new Error(code));
        else resolve();
      });
    });
  const capture = (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const fetchBody = (transport, options) =>
    new Promise((resolve, reject) => {
      const req = transport.request({ ...options, agent: false, timeout: 10000 }, (res) => {
        const chunks = [];
        let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 1048576) req.destroy(new Error(code));
          else chunks.push(chunk);
        });
        res.once("error", reject);
        res.once("end", () =>
          res.complete
            ? resolve({
                status: res.statusCode,
                headers: res.headers,
                bytes: Buffer.concat(chunks)
              })
            : reject(new Error(code))
        );
      });
      req.once("timeout", () => req.destroy(new Error(code)));
      req.once("error", reject);
      req.end();
    });
  const forward = async (request, response, host, port, requestPath) => {
    try {
      check(["GET", "HEAD", "OPTIONS"].includes(request.method));
      check(!request.headers["content-length"] && !request.headers["transfer-encoding"]);
      const headers = { ...request.headers, host: request.headers.host, connection: "close" };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      const result = await fetchBody(http, {
        hostname: host,
        port,
        method: request.method,
        path: requestPath,
        headers
      });
      delete result.headers["transfer-encoding"];
      response.writeHead(result.status, {
        ...result.headers,
        "content-length": result.bytes.length
      });
      response.end(result.bytes);
    } catch {
      response.writeHead(502);
      response.end();
    }
  };
  const listen = (server, port) =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.on("connection", capture);
      server.listen(port, "127.0.0.1", resolve);
    });
  const decode = (value, maximum) => {
    check(typeof value === "string" && /^[A-Za-z0-9+/]*={0,2}$/u.test(value));
    const bytes = Buffer.from(value, "base64");
    check(bytes.length > 0 && bytes.length <= maximum && bytes.toString("base64") === value);
    return bytes;
  };
  const initialize = async (input) => {
    check(
      !initialized &&
        input &&
        Object.keys(input).sort().join(",") ===
          "apiAddress,apiBaseUrl,buildProofDigest,files,manifestDigest,operationId,packages,webAddress"
    );
    const api = new URL(input.apiBaseUrl);
    check(
      api.protocol === "https:" &&
        !api.port &&
        !api.username &&
        !api.password &&
        !api.search &&
        !api.hash &&
        input.apiBaseUrl === `${api.origin}/api`
    );
    for (const name of ["apiAddress", "webAddress"]) check(net.isIPv4(input[name]));
    check(input.apiAddress !== input.webAddress);
    check(/^[0-9a-f-]{36}$/u.test(input.operationId));
    for (const name of ["buildProofDigest", "manifestDigest"])
      check(/^sha256:[0-9a-f]{64}$/u.test(input[name]));
    const files = [
      "ca.pem",
      "server.pem",
      "server.key",
      "nss/cert9.db",
      "nss/key4.db",
      "playwright.release.config.ts",
      "tests/release/web-public-api.spec.ts"
    ];
    check(Object.keys(input.files).sort().join(",") === [...files].sort().join(","));
    await fs.mkdir(root, { mode: 0o700 });
    await fs.mkdir(`${root}/home/.pki/nssdb`, { recursive: true, mode: 0o700 });
    await fs.mkdir(`${root}/tests/release`, { recursive: true, mode: 0o700 });
    await fs.mkdir(`${root}/packages`, { mode: 0o700 });
    for (const name of files) {
      const bytes = decode(input.files[name], 1048576);
      const target = name.startsWith("nss/") ? `home/.pki/nssdb/${name.slice(4)}` : name;
      await fs.writeFile(`${root}/${target}`, bytes, { flag: "wx", mode: 0o600 });
      bytes.fill(0);
    }
    check(Array.isArray(input.packages) && input.packages.length === 3);
    const names = ["@playwright/test", "playwright", "playwright-core"];
    const tgz = [];
    for (const [i, item] of input.packages.entries()) {
      check(
        item.name === names[i] &&
          item.version === "1.62.1" &&
          /^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(item.integrity)
      );
      const bytes = decode(item.bytes, 8388608);
      check(`sha512-${createHash("sha512").update(bytes).digest("base64")}` === item.integrity);
      const target = `${root}/packages/${i}.tgz`;
      await fs.writeFile(target, bytes, { flag: "wx", mode: 0o600 });
      tgz.push(target);
    }
    const env = {
      PATH: "/usr/bin:/bin",
      HOME: `${root}/home`,
      NODE_ENV: "test",
      PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      npm_config_cache: `${root}/npm-cache`
    };
    await fs.writeFile(`${root}/package.json`, '{"private":true}', { flag: "wx", mode: 0o600 });
    await run(
      "/usr/bin/npm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--omit=optional",
        ...tgz
      ],
      env,
      30000
    );
    const overlay =
      'import base from "./playwright.release.config";\nexport default { ...base, use: { ...base.use, proxy: { server: "http://127.0.0.1:8080" } } };\n';
    await fs.writeFile(`${root}/r3.config.ts`, overlay, { flag: "wx", mode: 0o600 });
    const key = await fs.readFile(`${root}/server.key`),
      cert = await fs.readFile(`${root}/server.pem`);
    tlsServer = https.createServer({ key, cert, minVersion: "TLSv1.2" }, (req, res) => {
      if (req.headers.host !== api.host || !req.url.startsWith("/api/")) {
        res.writeHead(403);
        return res.end();
      }
      return forward(req, res, input.apiAddress, 3001, req.url);
    });
    key.fill(0);
    tlsServer.on("tlsClientError", () => {});
    await listen(tlsServer, 8443);
    proxy = http.createServer((req, res) => {
      let url;
      try {
        url = new URL(req.url);
      } catch {
        res.writeHead(403);
        return res.end();
      }
      if (url.origin !== "http://web:3000" || url.username || url.password) {
        res.writeHead(403);
        return res.end();
      }
      req.headers.host = "web:3000";
      return forward(req, res, input.webAddress, 3000, `${url.pathname}${url.search}`);
    });
    proxy.on("connect", (req, socket, head) => {
      const target = `${api.hostname}:443`;
      const apiTunnel = req.url === target;
      // Playwright's APIRequestContext also tunnels HTTP script downloads.
      // Both destinations remain fixed to these two held application services.
      if ((!apiTunnel && req.url !== "web:3000") || head.length > 0) return socket.destroy();
      const upstream = net.connect(
        apiTunnel ? 8443 : 3000,
        apiTunnel ? "127.0.0.1" : input.webAddress,
        () => {
          if (apiTunnel) connections++;
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          socket.pipe(upstream);
          upstream.pipe(socket);
        }
      );
      capture(upstream);
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.once("close", () => upstream.destroy());
      upstream.once("close", () => socket.destroy());
    });
    await listen(proxy, 8080);
    state = { ...input, env, api, overlayDigest: digest(Buffer.from(overlay)) };
    delete state.files;
    delete state.packages;
    initialized = true;
    return { ready: true, overlayDigest: state.overlayDigest };
  };
  const readiness = async (purpose) => {
    check(initialized && ["health", "catalog"].includes(purpose));
    const options =
      purpose === "health"
        ? { hostname: state.apiAddress, port: 3001, path: "/api/health", method: "GET" }
        : {
            hostname: "127.0.0.1",
            port: 8443,
            path: "/api/portal/catalog/model-definitions",
            method: "GET",
            headers: { host: state.api.host },
            servername: net.isIP(state.api.hostname.replace(/^\[|\]$/gu, ""))
              ? undefined
              : state.api.hostname,
            checkServerIdentity: (_hostname, certificate) =>
              tls.checkServerIdentity(state.api.hostname.replace(/^\[|\]$/gu, ""), certificate),
            ca: await fs.readFile(`${root}/ca.pem`),
            rejectUnauthorized: true
          };
    const end = Date.now() + 30000;
    while (true) {
      try {
        const result = await fetchBody(purpose === "health" ? http : https, options);
        check(result.status === 200);
        return { status: result.status, body: JSON.parse(result.bytes.toString("utf8")) };
      } catch {
        if (Date.now() >= end) throw new Error(code);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  };
  const browser = async () => {
    check(initialized && !browserRun);
    browserRun = true;
    const env = {
      ...state.env,
      PLAYWRIGHT_RELEASE_BROWSER_CHANNEL: "chromium",
      RELEASE_GATE_WEB_BASE: "http://web:3000",
      RELEASE_GATE_PUBLIC_API_BASE: state.apiBaseUrl,
      RELEASE_GATE_EMBEDDED_API_BASE: state.apiBaseUrl,
      RELEASE_GATE_OPERATION_ID: state.operationId,
      RELEASE_GATE_BUILD_PROOF_DIGEST: state.buildProofDigest,
      RELEASE_GATE_MANIFEST_DIGEST: state.manifestDigest,
      RELEASE_GATE_WEB_EVIDENCE_FILE: `${root}/browser-evidence.json`,
      RELEASE_GATE_PLAYWRIGHT_OUTPUT_DIR: `${root}/test-results`
    };
    await run(
      "/usr/bin/node",
      [
        `${root}/node_modules/@playwright/test/cli.js`,
        "test",
        "--config",
        "r3.config.ts",
        "--workers=1"
      ],
      env,
      75000
    );
    const evidenceBytes = await fs.readFile(`${root}/browser-evidence.json`);
    check(evidenceBytes.length <= 65536 && connections > 0);
    const traces = [];
    const walk = async (directory) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = `${directory}/${entry.name}`;
        check(!entry.isSymbolicLink());
        if (entry.isDirectory()) await walk(file);
        else if (entry.name === "trace.zip") traces.push(file);
      }
    };
    await walk(`${root}/test-results`);
    check(traces.length === 1);
    const stat = await fs.stat(traces[0]);
    check(stat.size > 0 && stat.size <= 8388608);
    const trace = await fs.readFile(traces[0]);
    return {
      evidence: JSON.parse(evidenceBytes.toString("utf8")),
      traceBase64: trace.toString("base64"),
      traceDigest: digest(trace),
      proxyConnectCount: connections,
      overlayDigest: state.overlayDigest
    };
  };
  const handle = async (message) => {
    check(message && message.id === ++sequence && typeof message.kind === "string");
    if (message.kind === "init") return initialize(message.input);
    if (message.kind === "request") return readiness(message.input?.purpose);
    if (message.kind === "browser") return browser();
    if (message.kind === "close") {
      check(initialized);
      clearTimeout(deadline);
      for (const socket of sockets) socket.destroy();
      proxy.close();
      tlsServer.close();
      await fs.rm(root, { recursive: true });
      initialized = false;
      return { closed: true };
    }
    throw new Error(code);
  };
  process.stdin.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length > 32 * 1024 * 1024) return bad();
    const newline = buffered.indexOf(10);
    if (newline < 0) return;
    if (busy || newline !== buffered.length - 1) return bad();
    busy = true;
    let message;
    try {
      message = JSON.parse(buffered.subarray(0, newline).toString("utf8"));
    } catch {
      return bad();
    }
    buffered.fill(0);
    buffered = Buffer.alloc(0);
    handle(message).then((result) => {
      busy = false;
      write(message.id, result);
    }, bad);
  });
  process.stdin.once("end", bad);
  process.stdin.once("error", bad);
}

export const R3_BROWSER_ENTRYPOINT = Object.freeze([
  "/usr/bin/node",
  "-e",
  `(${browserProgram.toString()})().catch(() => process.exit(1));`,
  "--"
]);

export function createR3BrowserChannel({ attached, signal, recheck }) {
  need(
    attached?.stdin?.write &&
      attached?.stdout?.on &&
      signal?.addEventListener &&
      !signal.aborted &&
      typeof recheck === "function"
  );
  let sequence = 0,
    pending,
    closed = false,
    bytes = Buffer.alloc(0);
  const stop = () => {
    closed = true;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(fail());
      pending = undefined;
    }
  };
  const data = (chunk) => {
    if (closed) return;
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length > 16 * 1024 * 1024) return stop();
    const newline = bytes.indexOf(10);
    if (newline < 0) return;
    try {
      need(!closed && pending && newline === bytes.length - 1);
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      need(value.id === sequence && Object.keys(value).sort().join(",") === "id,result");
      const held = pending;
      pending = undefined;
      clearTimeout(held.timer);
      bytes = Buffer.alloc(0);
      held.resolve(value.result);
    } catch {
      stop();
    }
  };
  attached.stdout.on("data", data);
  attached.stdout.on("end", stop);
  attached.stdout.on("error", stop);
  signal.addEventListener("abort", stop, { once: true });
  return Object.freeze({
    async call(kind, input) {
      need(
        !closed &&
          !pending &&
          !signal.aborted &&
          ["init", "request", "browser", "close"].includes(kind)
      );
      await recheck();
      need(!closed && !pending && !signal.aborted);
      const buffer = Buffer.from(`${JSON.stringify({ id: ++sequence, kind, input })}\n`);
      need(buffer.length <= 32 * 1024 * 1024);
      try {
        const result = await new Promise((resolve, reject) => {
          pending = { resolve, reject, timer: setTimeout(stop, 90000) };
          // Transport owns the queued copy; do not zero it before socket flush.
          attached.stdin.write(Buffer.from(buffer), (error) => {
            if (error) stop();
          });
        });
        await recheck();
        need(!closed && !signal.aborted);
        return result;
      } finally {
        buffer.fill(0);
      }
    },
    close() {
      stop();
      bytes.fill(0);
      attached.stdout.removeListener("data", data);
      attached.stdout.removeListener("end", stop);
      attached.stdout.removeListener("error", stop);
      signal.removeEventListener("abort", stop);
    }
  });
}

export async function withR3BrowserSession({
  attached,
  signal,
  recheck,
  repoRoot,
  identity,
  tls,
  packages,
  execute
}) {
  need(typeof execute === "function");
  need(
    tls?.metadata?.operationRef === identity?.operationId &&
      tls.metadata.apiBaseUrl === identity.apiBaseUrl
  );
  const files = {};
  for (const name of ["ca.pem", "server.pem", "server.key", "nss/cert9.db", "nss/key4.db"]) {
    need(Buffer.isBuffer(tls?.files?.[name]));
    files[name] = tls.files[name].toString("base64");
  }
  const sourceDigests = {};
  for (const name of ["playwright.release.config.ts", "tests/release/web-public-api.spec.ts"]) {
    const bytes = await readFile(path.join(repoRoot, name));
    need(bytes.length > 0 && bytes.length <= 1048576);
    files[name] = bytes.toString("base64");
    sourceDigests[name] = hash(bytes);
  }
  const channel = createR3BrowserChannel({ attached, signal, recheck });
  let failed, result, browserOriginal;
  try {
    const ready = await channel.call("init", {
      ...identity,
      files,
      packages: packages.map((item) => ({
        name: item.name,
        version: item.version,
        integrity: item.integrity,
        bytes: item.bytes.toString("base64")
      }))
    });
    need(ready?.ready === true && /^sha256:[0-9a-f]{64}$/u.test(ready.overlayDigest));
    result = await execute(
      Object.freeze({
        request: ({ purpose }) => channel.call("request", { purpose }),
        async runBrowser() {
          const original = await channel.call("browser", {});
          const trace = Buffer.from(original.traceBase64, "base64");
          need(
            trace.length > 0 &&
              trace.length <= 8388608 &&
              hash(trace) === original.traceDigest &&
              original.overlayDigest === ready.overlayDigest &&
              original.proxyConnectCount > 0
          );
          browserOriginal = {
            evidence: original.evidence,
            trace,
            traceDigest: original.traceDigest,
            proxyConnectCount: original.proxyConnectCount,
            overlayDigest: original.overlayDigest,
            sourceDigests
          };
          return { ...original.evidence, traceDigest: original.traceDigest };
        }
      })
    );
    need(browserOriginal);
  } catch (error) {
    failed = error;
  }
  try {
    need((await channel.call("close", {}))?.closed === true);
  } catch {
    failed ??= fail();
  }
  channel.close();
  if (failed) throw fail();
  return { value: result, original: browserOriginal };
}
