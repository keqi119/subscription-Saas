// Held native caller only. Admission, no-swap, and encrypted-root custody belong
// to the caller; this module creates one short-lived private TLS child beneath it.
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash, createPublicKey, randomBytes, X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";

const CODE = "R3_APPLICATION_TLS_FAILED";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_OUTPUT = 1024 * 1024;
const MAX_FILE = 1024 * 1024;
const ENV = Object.freeze({ PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C", LANG: "C" });
const REQUIRED_FILES = Object.freeze([
  "ca.pem",
  "server.pem",
  "server.key",
  "nss/cert9.db",
  "nss/key4.db"
]);

function fail() {
  throw Object.assign(new Error(CODE), { code: CODE });
}

function requireThat(value) {
  if (!value) fail();
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function hostFromApiUrl(value) {
  requireThat(typeof value === "string" && value.length > 0 && value.length <= 2048);
  const url = new URL(value);
  requireThat(
    url.protocol === "https:" &&
      url.hostname &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      url.pathname === "/api" &&
      value === `${url.origin}/api`
  );
  const bracketed = url.hostname.startsWith("[") && url.hostname.endsWith("]");
  const host = bracketed ? url.hostname.slice(1, -1) : url.hostname;
  const ipVersion = isIP(host);
  if (bracketed) requireThat(ipVersion === 6);
  else if (ipVersion === 0)
    requireThat(
      host.length <= 253 &&
        host
          .split(".")
          .every(
            (label) =>
              label.length >= 1 &&
              label.length <= 63 &&
              /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
          )
    );
  return { host, ipVersion, san: `${ipVersion ? "IP" : "DNS"}:${host}` };
}

async function secureDirectory(directory, expected) {
  const stat = await fs.lstat(directory);
  requireThat(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (stat.mode & 0o777) === 0o700 &&
      stat.uid === 0 &&
      (await fs.realpath(directory)) === path.resolve(directory) &&
      (!expected || (stat.dev === expected.dev && stat.ino === expected.ino))
  );
  return stat;
}

async function readPrivateFile(directory, relative) {
  const filename = path.join(directory, relative);
  const stat = await fs.lstat(filename);
  requireThat(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === 0);
  requireThat(stat.size > 0 && stat.size <= MAX_FILE);
  await fs.chmod(filename, 0o600);
  return fs.readFile(filename);
}

function defaultRunTool(executable, args, options) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, args, {
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch {
      reject(new Error(CODE));
      return;
    }
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let exceeded = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    const collect = (kind, chunk) => {
      if (exceeded) return;
      if (stdout.length + stderr.length + chunk.length > options.maxOutputBytes) {
        exceeded = true;
        child.kill("SIGKILL");
        return;
      }
      if (kind === "stdout") stdout = Buffer.concat([stdout, chunk]);
      else stderr = Buffer.concat([stderr, chunk]);
    };
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (exceeded || timedOut) reject(new Error(CODE));
      else resolve({ code, stdout, stderr });
    });
  });
}

async function removeOwned(parent, parentStat, child, childStat) {
  if (!childStat) return;
  await secureDirectory(parent, parentStat);
  await secureDirectory(child, childStat);
  requireThat(path.dirname(child) === parent);
  await fs.rm(child, { recursive: true, force: false });
}

export async function createR3ApplicationTls({
  directory,
  operationRef,
  apiBaseUrl,
  signal,
  recheck,
  runTool = defaultRunTool
}) {
  let parent;
  let parentStat;
  let child;
  let childStat;
  let nssStat;
  let privateKey;
  try {
    requireThat(process.platform === "linux" && process.getuid?.() === 0);
    requireThat(typeof directory === "string" && path.isAbsolute(directory));
    requireThat(typeof operationRef === "string" && UUID.test(operationRef));
    requireThat(typeof recheck === "function" && typeof runTool === "function");
    requireThat(!signal || (typeof signal === "object" && "aborted" in signal));
    const { host, ipVersion, san } = hostFromApiUrl(apiBaseUrl);
    requireThat(!signal?.aborted);
    parent = path.resolve(directory);
    parentStat = await secureDirectory(parent);
    await recheck();
    requireThat(!signal?.aborted);
    await secureDirectory(parent, parentStat);
    child = path.join(parent, `application-tls-${operationRef}`);
    await fs.mkdir(child, { mode: 0o700 });
    childStat = await fs.lstat(child);
    childStat = await secureDirectory(child);
    const nss = path.join(child, "nss");
    await fs.mkdir(nss, { mode: 0o700 });
    nssStat = await secureDirectory(nss);

    const env = { ...ENV, HOME: child };
    async function command(executable, args) {
      requireThat(!signal?.aborted);
      await secureDirectory(parent, parentStat);
      await secureDirectory(child, childStat);
      await secureDirectory(nss, nssStat);
      await recheck();
      requireThat(!signal?.aborted);
      const result = await runTool(executable, args, {
        cwd: child,
        env,
        signal,
        timeoutMs: 30000,
        maxOutputBytes: MAX_OUTPUT
      });
      requireThat(
        result?.code === 0 &&
          Buffer.isBuffer(result.stdout) &&
          Buffer.isBuffer(result.stderr) &&
          result.stdout.length + result.stderr.length <= MAX_OUTPUT
      );
      await recheck();
      requireThat(!signal?.aborted);
      await secureDirectory(parent, parentStat);
      await secureDirectory(child, childStat);
      await secureDirectory(nss, nssStat);
      return result.stdout;
    }

    // OpenSSL 1.1.1 supports req -addext and x509 -extfile. The only dynamic
    // extension is a strictly parsed URL hostname, written inside the owned child.
    const caKey = path.join(child, "ca.key");
    const caPem = path.join(child, "ca.pem");
    const serverKey = path.join(child, "server.key");
    const csr = path.join(child, "server.csr");
    const serverPem = path.join(child, "server.pem");
    const extension = path.join(child, "server.ext");
    const requestConfig = path.join(child, "openssl.cnf");
    // OpenSSL 1.1.1 can append -addext to ambient v3_ca extensions, creating
    // duplicate basicConstraints. Both requests use an owned minimal config.
    await fs.writeFile(requestConfig, "[req]\ndistinguished_name=dn\nprompt=no\n[dn]\n", {
      mode: 0o600,
      flag: "wx"
    });
    await fs.writeFile(
      extension,
      `[server]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`,
      { mode: 0o600, flag: "wx" }
    );
    await command("/usr/bin/openssl", [
      "genpkey",
      "-algorithm",
      "RSA",
      "-pkeyopt",
      "rsa_keygen_bits:2048",
      "-out",
      caKey
    ]);
    await command("/usr/bin/openssl", [
      "req",
      "-config",
      requestConfig,
      "-new",
      "-x509",
      "-sha256",
      "-days",
      "1",
      "-key",
      caKey,
      "-out",
      caPem,
      "-subj",
      "/CN=R3 Stage1 Private CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign"
    ]);
    await command("/usr/bin/openssl", [
      "genpkey",
      "-algorithm",
      "RSA",
      "-pkeyopt",
      "rsa_keygen_bits:2048",
      "-out",
      serverKey
    ]);
    await command("/usr/bin/openssl", [
      "req",
      "-config",
      requestConfig,
      "-new",
      "-sha256",
      "-key",
      serverKey,
      "-out",
      csr,
      "-subj",
      `/CN=${host}`
    ]);
    await command("/usr/bin/openssl", [
      "x509",
      "-req",
      "-sha256",
      "-days",
      "1",
      "-in",
      csr,
      "-CA",
      caPem,
      "-CAkey",
      caKey,
      "-set_serial",
      `0x${randomBytes(16).toString("hex")}`,
      "-extfile",
      extension,
      "-extensions",
      "server",
      "-out",
      serverPem
    ]);
    await command("/usr/bin/openssl", [
      "verify",
      "-CAfile",
      caPem,
      "-purpose",
      "sslserver",
      serverPem
    ]);
    await command("/usr/bin/certutil", ["-N", "-d", `sql:${nss}`, "--empty-password"]);
    await command("/usr/bin/certutil", [
      "-A",
      "-d",
      `sql:${nss}`,
      "-n",
      "r3-stage1-private-ca",
      "-t",
      "C,,",
      "-i",
      caPem
    ]);
    const nssReadback = await command("/usr/bin/certutil", [
      "-L",
      "-d",
      `sql:${nss}`,
      "-n",
      "r3-stage1-private-ca",
      "-a"
    ]);
    const files = Object.fromEntries(
      await Promise.all(
        REQUIRED_FILES.map(async (name) => [name, await readPrivateFile(child, name)])
      )
    );
    privateKey = files["server.key"];
    const ca = new X509Certificate(files["ca.pem"]);
    const server = new X509Certificate(files["server.pem"]);
    const nssCertificate = new X509Certificate(nssReadback);
    const now = Date.now();
    const notBefore = Date.parse(server.validFrom);
    const notAfter = Date.parse(server.validTo);
    const caFrom = Date.parse(ca.validFrom);
    const caTo = Date.parse(ca.validTo);
    requireThat(
      ca.ca &&
        !server.ca &&
        ca.verify(ca.publicKey) &&
        server.verify(ca.publicKey) &&
        server.issuer === ca.subject &&
        ca.subject === ca.issuer &&
        nssCertificate.raw.equals(ca.raw) &&
        (ipVersion ? server.checkIP(host) === host : server.checkHost(host) === host) &&
        createPublicKey(privateKey)
          .export({ type: "spki", format: "der" })
          .equals(server.publicKey.export({ type: "spki", format: "der" })) &&
        [notBefore, notAfter, caFrom, caTo].every(Number.isFinite) &&
        notBefore <= now &&
        now < notAfter &&
        caFrom <= now &&
        now < caTo &&
        notAfter - notBefore <= 25 * 3600000 &&
        caTo - caFrom <= 25 * 3600000 &&
        server.keyUsage?.includes("1.3.6.1.5.5.7.3.1")
    );
    const metadata = Object.freeze({
      operationRef,
      apiBaseUrl,
      caCertificateDigest: digest(ca.raw),
      serverCertificateDigest: digest(server.raw),
      serverPublicKeyDigest: digest(server.publicKey.export({ type: "spki", format: "der" })),
      notBefore: new Date(notBefore).toISOString(),
      notAfter: new Date(notAfter).toISOString(),
      nssCertificateDigest: digest(nssCertificate.raw)
    });
    await recheck();
    requireThat(!signal?.aborted);
    await secureDirectory(parent, parentStat);
    await secureDirectory(child, childStat);
    let closed = false;
    return {
      files,
      metadata,
      async close() {
        if (closed) return;
        try {
          await removeOwned(parent, parentStat, child, childStat);
          closed = true;
        } catch {
          fail();
        } finally {
          privateKey.fill(0);
        }
      }
    };
  } catch {
    privateKey?.fill(0);
    try {
      if (childStat) await removeOwned(parent, parentStat, child, childStat);
    } catch {
      // The generic failure never authorizes deleting a changed path.
    }
    fail();
  }
}
