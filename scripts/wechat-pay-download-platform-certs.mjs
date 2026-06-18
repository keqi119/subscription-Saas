#!/usr/bin/env node
import { createDecipheriv, createSign, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const WECHAT_PAY_CERTIFICATES_PATH = "/v3/certificates";
const WECHAT_PAY_API_BASE_URL = "https://api.mch.weixin.qq.com";
const DEFAULT_OUTPUT_DIR = "/opt/subscription-saas/secrets/wechatpay/platform-certs";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  loadEnvFiles(options.envFiles);

  const config = readConfig(options);
  const response = await requestWechatPayCertificates(config);
  const certificates = parseCertificateResponse(response, options.serial);
  if (certificates.length === 0) {
    throw new Error(options.serial
      ? `No platform certificate found for serial ${maskSerial(options.serial)}.`
      : "No platform certificates returned by WeChat Pay.");
  }

  mkdirSync(config.outputDir, { mode: 0o700, recursive: true });

  const mappingEntries = [];
  for (const certificate of certificates) {
    const pem = decryptPlatformCertificate(certificate, config.apiV3Key);
    const filePath = resolve(config.outputDir, `wechatpay-platform-${certificate.serialNo}.pem`);
    mappingEntries.push(`${certificate.serialNo}:${filePath}`);

    console.log([
      `certificate serial=${maskSerial(certificate.serialNo)}`,
      `effective=${certificate.effectiveTime ?? "-"}`,
      `expire=${certificate.expireTime ?? "-"}`,
      `file=${maskPath(filePath)}`
    ].join(" "));

    if (options.dryRun) {
      continue;
    }

    if (existsSync(filePath) && !options.overwrite) {
      console.log(`skip existing file ${maskPath(filePath)}; pass --overwrite to replace it.`);
      continue;
    }

    writeFileSync(filePath, ensureTrailingNewline(pem), {
      flag: options.overwrite ? "w" : "wx",
      mode: 0o600
    });
    console.log(`saved ${maskPath(filePath)}`);
  }

  if (options.writeEnvSnippet) {
    const snippetPath = resolve(options.writeEnvSnippet);
    const snippet = `WECHAT_PAY_PLATFORM_CERTS=${mappingEntries.join(",")}\n`;
    if (!options.dryRun) {
      writeFileSync(snippetPath, snippet, { flag: options.overwrite ? "w" : "wx", mode: 0o600 });
      console.log(`wrote env snippet ${maskPath(snippetPath)}`);
    } else {
      console.log(`dry-run: would write env snippet ${maskPath(snippetPath)}`);
    }
  }

  console.log("done. No AppSecret, API v3 key, merchant private key, or certificate content was printed.");
}

function parseArgs(args) {
  const options = {
    dryRun: false,
    envFiles: [],
    help: false,
    outputDir: undefined,
    overwrite: false,
    serial: undefined,
    writeEnvSnippet: undefined
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--env-file":
        options.envFiles.push(requireNextArg(args, index, arg));
        index += 1;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--output-dir":
        options.outputDir = requireNextArg(args, index, arg);
        index += 1;
        break;
      case "--overwrite":
        options.overwrite = true;
        break;
      case "--serial":
        options.serial = requireNextArg(args, index, arg).trim().toUpperCase();
        index += 1;
        break;
      case "--write-env-snippet":
        options.writeEnvSnippet = requireNextArg(args, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function requireNextArg(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function loadEnvFiles(envFiles) {
  for (const envFile of envFiles) {
    const absolutePath = resolve(envFile);
    const content = readFileSync(absolutePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const separator = trimmed.indexOf("=");
      if (separator <= 0) {
        continue;
      }
      const key = trimmed.slice(0, separator).trim();
      const value = unquoteEnvValue(trimmed.slice(separator + 1).trim());
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\""))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function readConfig(options) {
  const merchantId = requiredEnv("WECHAT_PAY_MCH_ID");
  const merchantSerialNo = requiredEnv("WECHAT_PAY_MERCHANT_SERIAL_NO");
  const merchantPrivateKeyPath = requiredEnv("WECHAT_PAY_MERCHANT_PRIVATE_KEY_PATH");
  const apiV3Key = requiredEnv("WECHAT_PAY_API_V3_KEY");
  if (Buffer.from(apiV3Key, "utf8").length !== 32) {
    throw new Error("WECHAT_PAY_API_V3_KEY must be exactly 32 bytes.");
  }

  return {
    apiV3Key,
    merchantId,
    merchantPrivateKeyPem: readFileSync(merchantPrivateKeyPath, "utf8"),
    merchantSerialNo,
    outputDir: resolve(options.outputDir ?? process.env.WECHAT_PAY_PLATFORM_CERT_OUTPUT_DIR ?? DEFAULT_OUTPUT_DIR)
  };
}

function requiredEnv(key) {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

async function requestWechatPayCertificates(config) {
  const body = "";
  const method = "GET";
  const nonce = randomBytes(16).toString("hex");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signWechatPayApiV3({
    body,
    method,
    nonce,
    privateKeyPem: config.merchantPrivateKeyPem,
    timestamp,
    urlPathWithQuery: WECHAT_PAY_CERTIFICATES_PATH
  });

  const authorization = [
    "WECHATPAY2-SHA256-RSA2048",
    [
      `mchid="${config.merchantId}"`,
      `nonce_str="${nonce}"`,
      `signature="${signature}"`,
      `timestamp="${timestamp}"`,
      `serial_no="${config.merchantSerialNo}"`
    ].join(",")
  ].join(" ");

  const response = await fetch(`${WECHAT_PAY_API_BASE_URL}${WECHAT_PAY_CERTIFICATES_PATH}`, {
    headers: {
      Accept: "application/json",
      Authorization,
      "User-Agent": "subscription-saas-cert-downloader"
    },
    method
  });
  const text = await response.text();
  const payload = parseJson(text);

  if (!response.ok) {
    const record = asRecord(payload);
    throw new Error(`WeChat Pay certificates request failed: status=${response.status} code=${stringOrDash(record.code)} message=${stringOrDash(record.message)}`);
  }

  return payload;
}

function signWechatPayApiV3(input) {
  const message = [
    input.method.toUpperCase(),
    input.urlPathWithQuery,
    input.timestamp,
    input.nonce,
    input.body
  ].join("\n") + "\n";
  const signer = createSign("RSA-SHA256");
  signer.update(message);
  signer.end();
  return signer.sign(input.privateKeyPem, "base64");
}

function parseCertificateResponse(payload, serialFilter) {
  const data = Array.isArray(asRecord(payload).data) ? asRecord(payload).data : [];
  return data
    .map((item) => {
      const record = asRecord(item);
      const encrypted = asRecord(record.encrypt_certificate);
      const serialNo = stringOrUndefined(record.serial_no)?.toUpperCase();
      if (!serialNo) {
        return null;
      }
      return {
        algorithm: stringOrUndefined(encrypted.algorithm),
        associatedData: stringOrUndefined(encrypted.associated_data),
        ciphertext: stringOrUndefined(encrypted.ciphertext),
        effectiveTime: stringOrUndefined(record.effective_time),
        expireTime: stringOrUndefined(record.expire_time),
        nonce: stringOrUndefined(encrypted.nonce),
        serialNo
      };
    })
    .filter((item) => item && (!serialFilter || item.serialNo === serialFilter));
}

function decryptPlatformCertificate(certificate, apiV3Key) {
  if (certificate.algorithm && certificate.algorithm !== "AEAD_AES_256_GCM") {
    throw new Error(`Unsupported platform certificate algorithm for ${maskSerial(certificate.serialNo)}.`);
  }
  if (!certificate.ciphertext || !certificate.nonce) {
    throw new Error(`Encrypted platform certificate is incomplete for ${maskSerial(certificate.serialNo)}.`);
  }

  const key = Buffer.from(apiV3Key, "utf8");
  const encrypted = Buffer.from(certificate.ciphertext, "base64");
  const authTag = encrypted.subarray(encrypted.length - 16);
  const data = encrypted.subarray(0, encrypted.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(certificate.nonce, "utf8"));
  if (certificate.associatedData) {
    decipher.setAAD(Buffer.from(certificate.associatedData, "utf8"));
  }
  decipher.setAuthTag(authTag);

  const pem = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  if (!pem.includes("BEGIN CERTIFICATE") || !pem.includes("END CERTIFICATE")) {
    throw new Error(`Decrypted content for ${maskSerial(certificate.serialNo)} is not a PEM certificate.`);
  }
  return pem;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("WeChat Pay certificates response is not valid JSON.");
  }
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringOrUndefined(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringOrDash(value) {
  return stringOrUndefined(value) ?? "-";
}

function ensureTrailingNewline(value) {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function maskSerial(serial) {
  const normalized = serial.trim();
  if (normalized.length <= 8) {
    return "****";
  }
  return `${normalized.slice(0, 6)}****${normalized.slice(-4)}`;
}

function maskPath(path) {
  const fileName = basename(path);
  const maskedFileName = fileName.replace(/[A-Fa-f0-9]{16,}/g, (serial) => maskSerial(serial));
  return path.replace(fileName, maskedFileName);
}

function printHelp() {
  console.log(`Download and decrypt WeChat Pay API v3 platform certificates.

Usage:
  node scripts/wechat-pay-download-platform-certs.mjs --env-file .env.production.images [options]

Required env:
  WECHAT_PAY_MCH_ID
  WECHAT_PAY_MERCHANT_SERIAL_NO
  WECHAT_PAY_MERCHANT_PRIVATE_KEY_PATH
  WECHAT_PAY_API_V3_KEY

Options:
  --env-file <path>             Load env values from a file. Can be repeated.
  --output-dir <path>           Certificate output directory.
                                Default: ${DEFAULT_OUTPUT_DIR}
  --serial <serial>             Save only one platform certificate serial.
  --write-env-snippet <path>    Write WECHAT_PAY_PLATFORM_CERTS=... to a 600-permission file.
  --overwrite                   Replace existing certificate/snippet files.
  --dry-run                     Request and decrypt certificates, but do not write files.
  -h, --help                    Show this help.

The script masks serials in console output and never prints AppSecret, API v3 key,
merchant private key, or certificate content.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
