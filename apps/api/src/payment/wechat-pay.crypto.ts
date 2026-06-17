import { createCipheriv, createDecipheriv, createSign, createVerify, randomBytes } from "node:crypto";

export function createWechatPayNonce(size = 16) {
  return randomBytes(size).toString("hex");
}

export function signWechatPayMessage(message: string, privateKeyPem: string) {
  const signer = createSign("RSA-SHA256");
  signer.update(message);
  signer.end();
  return signer.sign(privateKeyPem, "base64");
}

export function buildWechatPayAuthorizationHeader(input: {
  body: string;
  method: string;
  merchantId: string;
  nonce: string;
  privateKeyPem: string;
  serialNo: string;
  timestamp: string;
  urlPathWithQuery: string;
}) {
  const message = [
    input.method.toUpperCase(),
    input.urlPathWithQuery,
    input.timestamp,
    input.nonce,
    input.body
  ].join("\n") + "\n";
  const signature = signWechatPayMessage(message, input.privateKeyPem);
  const token = [
    `mchid="${input.merchantId}"`,
    `nonce_str="${input.nonce}"`,
    `signature="${signature}"`,
    `timestamp="${input.timestamp}"`,
    `serial_no="${input.serialNo}"`
  ].join(",");

  return `WECHATPAY2-SHA256-RSA2048 ${token}`;
}

export function buildWechatJsapiPaySign(input: {
  appId: string;
  nonceStr: string;
  packageValue: string;
  privateKeyPem: string;
  timeStamp: string;
}) {
  const message = [
    input.appId,
    input.timeStamp,
    input.nonceStr,
    input.packageValue
  ].join("\n") + "\n";

  return signWechatPayMessage(message, input.privateKeyPem);
}

export function verifyWechatPaySignature(input: {
  body: string;
  nonce: string;
  publicKeyOrCertificatePem: string;
  signature: string;
  timestamp: string;
}) {
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${input.timestamp}\n${input.nonce}\n${input.body}\n`);
  verifier.end();
  return verifier.verify(input.publicKeyOrCertificatePem, input.signature, "base64");
}

export function decryptWechatPayResource(input: {
  apiV3Key: string;
  associatedData?: string;
  ciphertext: string;
  nonce: string;
}) {
  const key = Buffer.from(input.apiV3Key, "utf8");
  if (key.length !== 32) {
    throw new Error("WECHAT_PAY_API_V3_KEY must be 32 bytes");
  }

  const encrypted = Buffer.from(input.ciphertext, "base64");
  const authTag = encrypted.subarray(encrypted.length - 16);
  const data = encrypted.subarray(0, encrypted.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(input.nonce, "utf8"));
  if (input.associatedData) {
    decipher.setAAD(Buffer.from(input.associatedData, "utf8"));
  }
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function encryptWechatPayResourceForTest(input: {
  apiV3Key: string;
  associatedData?: string;
  nonce: string;
  plaintext: string;
}) {
  const key = Buffer.from(input.apiV3Key, "utf8");
  const cipher = createCipheriv("aes-256-gcm", key, Buffer.from(input.nonce, "utf8"));
  if (input.associatedData) {
    cipher.setAAD(Buffer.from(input.associatedData, "utf8"));
  }
  const encrypted = Buffer.concat([cipher.update(input.plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64");
}
