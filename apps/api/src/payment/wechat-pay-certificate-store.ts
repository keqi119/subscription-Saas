import { readFileSync } from "node:fs";

import { ConfigService } from "@nestjs/config";

export interface WeChatPayVerifierPemResult {
  errorMessage?: string;
  pem?: string;
}

interface CertPathEntry {
  path: string;
  serial: string;
}

export class WeChatPayCertificateStore {
  private mappedCertsConfigured = false;
  private readonly pemCache = new Map<string, string>();
  private mappedCertPaths: CertPathEntry[] | null = null;

  constructor(private readonly configService: ConfigService) {}

  getVerifierPem(serial: string): WeChatPayVerifierPemResult {
    const normalizedSerial = normalizeSerial(serial);
    if (!normalizedSerial) {
      return { errorMessage: "WECHATPAY_SERIAL_MISSING" };
    }

    const mappedCerts = this.getMappedPlatformCertPaths();
    if (this.mappedCertsConfigured) {
      if (mappedCerts.length === 0) {
        return { errorMessage: "WECHATPAY_PLATFORM_CERTS_INVALID" };
      }
      const matched = mappedCerts.find((entry) => normalizeSerial(entry.serial) === normalizedSerial);
      if (!matched) {
        return { errorMessage: "WECHATPAY_SERIAL_NOT_CONFIGURED" };
      }
      return this.readPem(matched.path);
    }

    const publicKeyPath = this.configService.get<string>("WECHAT_PAY_PUBLIC_KEY_PATH")?.trim();
    const publicKeyId = normalizeSerial(this.configService.get<string>("WECHAT_PAY_PUBLIC_KEY_ID"));
    if (publicKeyPath) {
      if (publicKeyId && publicKeyId !== normalizedSerial) {
        return { errorMessage: "WECHATPAY_SERIAL_NOT_CONFIGURED" };
      }
      return this.readPem(publicKeyPath);
    }

    const platformCertPath = this.configService.get<string>("WECHAT_PAY_PLATFORM_CERT_PATH")?.trim();
    if (platformCertPath) {
      return this.readPem(platformCertPath);
    }

    return { errorMessage: "WECHATPAY_VERIFIER_CERT_MISSING" };
  }

  getMappedPlatformCertCount() {
    return this.getMappedPlatformCertPaths().length;
  }

  private getMappedPlatformCertPaths() {
    if (this.mappedCertPaths) {
      return this.mappedCertPaths;
    }

    const configuredValue = this.configService.get<string>("WECHAT_PAY_PLATFORM_CERTS")?.trim();
    if (!configuredValue) {
      this.mappedCertsConfigured = false;
      this.mappedCertPaths = [];
      return this.mappedCertPaths;
    }

    this.mappedCertsConfigured = true;
    this.mappedCertPaths = configuredValue
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf(":");
        if (separator <= 0 || separator === entry.length - 1) {
          return null;
        }
        const serial = entry.slice(0, separator).trim();
        const path = entry.slice(separator + 1).trim();
        if (!serial || !path) {
          return null;
        }
        return { path, serial };
      })
      .filter((entry): entry is CertPathEntry => Boolean(entry));

    return this.mappedCertPaths;
  }

  private readPem(path: string): WeChatPayVerifierPemResult {
    const cached = this.pemCache.get(path);
    if (cached) {
      return { pem: cached };
    }

    try {
      const pem = readFileSync(path, "utf8");
      this.pemCache.set(path, pem);
      return { pem };
    } catch {
      return { errorMessage: "WECHATPAY_VERIFIER_CERT_READ_FAILED" };
    }
  }
}

export function maskWechatPaySerial(serial: string) {
  const normalized = serial.trim();
  if (normalized.length <= 8) {
    return "****";
  }
  return `${normalized.slice(0, 6)}****${normalized.slice(-4)}`;
}

function normalizeSerial(value: string | undefined) {
  return value?.trim().toUpperCase();
}
