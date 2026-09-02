import { sha256Bytes, sha256Canonical } from "../digest.mjs";
import { validateContract } from "../schema-registry.mjs";

const rules = Object.freeze({
  "china-mobile": /(?<![0-9])1[3-9][0-9]{9}(?![0-9])/g,
  "china-id-card": /(?<![0-9])[1-9][0-9]{16}[0-9Xx](?![0-9])/g,
  "credential-url": /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/g,
  "bearer-token": /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  "private-key": /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  "provider-token": /\b(?:sk|gh[oprsu])[-_][A-Za-z0-9_-]{16,}\b/g
});

function scanError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

export async function scanSanitizedArtifact({ bytes, contract, scannedAt = new Date() }) {
  validateContract("sanitization-contract.v1", contract);
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw scanError("SNAPSHOT_SCAN_SUBJECT_INVALID");
  }
  if (!(scannedAt instanceof Date) || Number.isNaN(scannedAt.getTime())) {
    throw scanError("SNAPSHOT_SCAN_CLOCK_INVALID");
  }
  const content = Buffer.from(bytes).toString("utf8");
  const findings = [];
  for (const ruleId of contract.scanRules) {
    const pattern = rules[ruleId];
    pattern.lastIndex = 0;
    const match = pattern.exec(content);
    if (match) findings.push({ ruleId, offset: match.index });
  }
  if (findings.length > 0) {
    throw scanError("SNAPSHOT_SENSITIVE_DATA_DETECTED", {
      rules: findings.map(({ ruleId }) => ruleId)
    });
  }
  return Object.freeze({
    schemaVersion: "sanitization-scan.v1",
    subjectDigest: sha256Bytes(Buffer.from(bytes)),
    contractDigest: sha256Canonical(contract),
    scannerVersion: contract.tools.scannerVersion,
    status: "PASSED",
    findingsCount: 0,
    scannedAt: scannedAt.toISOString()
  });
}
