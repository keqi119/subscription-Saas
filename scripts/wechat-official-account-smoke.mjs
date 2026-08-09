#!/usr/bin/env node
import { randomInt } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { PrismaPg } = apiRequire("@prisma/adapter-pg");
const { PrismaClient } = apiRequire("@prisma/client");

const WECHAT_API_BASE_URL = "https://api.weixin.qq.com";
const DEFAULT_RESULT_PATH = ".tmp/stage10h-wechat-oa-smoke-result.json";
const DEFAULT_TEST_CUSTOMER_NO = "stage10_wechat_notify_test_customer";
const DEFAULT_TEST_PHONE = "13900001010";
const TOKEN_EXPIRED_ERROR_CODES = new Set([40001, 42001]);
const RANDOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const SMOKE_TYPES = {
  APPLICATION_PROGRESS: {
    content: "Application progress updated.",
    envKey: "WECHAT_TEMPLATE_APPLICATION_PROGRESS",
    eventType: "APPLICATION_SUBMITTED",
    notificationType: "APPLICATION_PROGRESS",
    route: "/portal/applications",
    templateCode: "APPLICATION_SUBMITTED_WECHAT",
    title: "Application progress"
  },
  CONTRACT_PENDING: {
    content: "Contract is ready for signing.",
    envKey: "WECHAT_TEMPLATE_CONTRACT_PENDING",
    eventType: "CONTRACT_PENDING",
    notificationType: "CONTRACT_PENDING",
    route: "/portal/contracts",
    templateCode: "CONTRACT_PENDING_WECHAT",
    title: "Contract pending"
  },
  FINAL_PLAN_PENDING: {
    content: "Final plan is ready for confirmation.",
    envKey: "WECHAT_TEMPLATE_FINAL_PLAN_PENDING",
    eventType: "FINAL_PLAN_READY",
    notificationType: "FINAL_PLAN_PENDING",
    route: "/portal/applications",
    templateCode: "FINAL_PLAN_READY_WECHAT",
    title: "Final plan pending"
  },
  HANDOVER_PENDING: {
    content: "Vehicle handover is ready for pickup.",
    envKey: "WECHAT_TEMPLATE_HANDOVER_PENDING",
    eventType: "HANDOVER_ESIGN_PENDING",
    notificationType: "HANDOVER_ESIGN_PENDING",
    route: "/portal/orders",
    templateCode: "HANDOVER_ESIGN_PENDING_WECHAT",
    title: "Vehicle pickup pending"
  },
  PAYMENT_PENDING: {
    content: "Payment is pending.",
    envKey: "WECHAT_TEMPLATE_PAYMENT_PENDING",
    eventType: "PAYMENT_PENDING",
    notificationType: "PAYMENT_PENDING",
    route: "/portal/orders",
    templateCode: "PAYMENT_PENDING_WECHAT",
    title: "Payment pending"
  },
  SERVICE_CASE_UPDATE: {
    content: "Service case status updated.",
    envKey: "WECHAT_TEMPLATE_SERVICE_CASE_UPDATE",
    eventType: "SERVICE_CASE_UPDATED",
    notificationType: "SERVICE_CASE_UPDATE",
    route: "/portal/service-cases",
    templateCode: "SERVICE_CASE_UPDATE_WECHAT",
    title: "Service case update"
  }
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  loadEnvFiles(options.envFiles);
  const mode = normalizeMode(options.mode ?? process.env.WECHAT_OA_SMOKE_MODE ?? "token");
  const appId = requiredEnv("WECHAT_OFFICIAL_ACCOUNT_APP_ID");
  const appSecret = requiredEnv("WECHAT_OFFICIAL_ACCOUNT_APP_SECRET");
  const tokenClient = createTokenClient({ appId, appSecret });

  if (mode === "token") {
    await tokenClient.getAccessToken();
    await tokenClient.getAccessToken();
    console.log(`token smoke passed for appId=${maskAppId(appId)}.`);
    console.log(`access_token was not printed; tokenRequestCount=${tokenClient.requestCount}.`);
    return;
  }

  await runTemplateSmoke(options, { appId, appSecret, tokenClient });
}

async function runTemplateSmoke(options, config) {
  const openId = normalizeSingleOpenId(options.openId ?? process.env.WECHAT_OA_TEST_OPENID);
  const templateType = normalizeTemplateType(options.templateType ?? process.env.WECHAT_OA_TEMPLATE_TYPE ?? "PAYMENT_PENDING");
  const typeConfig = SMOKE_TYPES[templateType];
  const templateId = options.templateId ?? requiredEnv(typeConfig.envKey);
  const portalBaseUrl = normalizeBaseUrl(options.portalBaseUrl ?? process.env.PORTAL_BASE_URL ?? "https://app.subauto.keybox.cloud");
  const url = options.url ?? process.env.WECHAT_OA_SMOKE_URL ?? `${portalBaseUrl}${typeConfig.route}`;
  const data = readTemplateData(templateType);
  const resultPath = resolve(options.resultPath ?? process.env.WECHAT_OA_SMOKE_RESULT_PATH ?? DEFAULT_RESULT_PATH);
  const prisma = createPrismaClient();

  try {
    const customer = await resolveSmokeCustomer(prisma, options);
    const account = await resolveSmokeAccount(prisma, customer, openId, options);
    const template = await resolveTemplate(prisma, typeConfig, templateId);
    const event = await prisma.notificationEvent.create({
      data: {
        aggregateType: "STAGE10H_WECHAT_OA_SMOKE",
        customerId: customer.id,
        eventStatus: "PROCESSING",
        eventType: typeConfig.eventType,
        payload: {
          templateIdMasked: maskTemplateId(templateId),
          templateType,
          url
        },
        attempts: 1
      }
    });

    let sendResult;
    let record;
    try {
      sendResult = await sendTemplateMessage({
        data,
        openId,
        templateId,
        tokenClient: config.tokenClient,
        url
      });
      const status = sendResult.success ? "SENT" : "FAILED";
      record = await createNotificationRecord(prisma, {
        account,
        customer,
        data,
        result: sendResult,
        status,
        template,
        templateCode: typeConfig.templateCode,
        typeConfig,
        url
      });
      await prisma.notificationEvent.update({
        data: {
          eventStatus: "PROCESSED",
          lastError: sendResult.success ? null : sendResult.errorMessage,
          notificationId: record.id,
          processedAt: new Date()
        },
        where: { id: event.id }
      });
    } catch (error) {
      await prisma.notificationEvent.update({
        data: {
          eventStatus: "FAILED",
          lastError: errorMessage(error),
          processedAt: new Date()
        },
        where: { id: event.id }
      });
      throw error;
    }

    const summary = {
      appIdMasked: maskAppId(config.appId),
      eventId: event.id,
      eventStatus: "PROCESSED",
      notificationNo: record.notificationNo,
      notificationStatus: record.notificationStatus,
      openIdMasked: maskOpenId(openId),
      providerMessageIdRecorded: Boolean(record.providerMessageId),
      providerMessageIdMasked: record.providerMessageId ? maskProviderMessageId(record.providerMessageId) : null,
      templateIdMasked: maskTemplateId(templateId),
      templateType,
      tokenRequestCount: config.tokenClient.requestCount,
      url
    };
    writeJson(resultPath, summary);
    console.log(`template smoke completed for appId=${summary.appIdMasked} openid=${summary.openIdMasked}.`);
    console.log(`notificationStatus=${summary.notificationStatus}; providerMessageIdRecorded=${summary.providerMessageIdRecorded ? "yes" : "no"}.`);
    console.log(`eventStatus=${summary.eventStatus}; result saved to ${maskPath(resultPath)}.`);
  } finally {
    await prisma.$disconnect();
  }
}

function createTokenClient(config) {
  let accessToken = null;
  let accessTokenExpiresAt = 0;
  const state = {
    requestCount: 0,
    async getAccessToken() {
      if (accessToken && accessTokenExpiresAt > Date.now()) {
        return accessToken;
      }

      state.requestCount += 1;
      const params = new URLSearchParams({
        appid: config.appId,
        grant_type: "client_credential",
        secret: config.appSecret
      });
      const response = await fetch(`${WECHAT_API_BASE_URL}/cgi-bin/token?${params.toString()}`);
      const body = await safeJson(response);
      const token = typeof body.access_token === "string" ? body.access_token : null;
      if (!response.ok || !token) {
        throw new Error(`WECHAT_ACCESS_TOKEN_FAILED:${body.errcode ?? response.status}`);
      }

      const expiresIn = Number(body.expires_in ?? 7000);
      const ttlSeconds = Number.isFinite(expiresIn) && expiresIn > 60 ? Math.min(expiresIn, 7000) : 7000;
      accessToken = token;
      accessTokenExpiresAt = Date.now() + Math.max(ttlSeconds - 60, 60) * 1000;
      return accessToken;
    },
    clear() {
      accessToken = null;
      accessTokenExpiresAt = 0;
    }
  };
  return state;
}

async function sendTemplateMessage(input, retried = false) {
  const accessToken = await input.tokenClient.getAccessToken();
  const response = await fetch(`${WECHAT_API_BASE_URL}/cgi-bin/message/template/send?access_token=${accessToken}`, {
    body: JSON.stringify({
      data: toWechatTemplateData(input.data),
      template_id: input.templateId,
      touser: input.openId,
      url: input.url
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST"
  });
  const body = await safeJson(response);
  const errcode = typeof body.errcode === "number" ? body.errcode : 0;
  if (!response.ok || errcode !== 0) {
    if (!retried && TOKEN_EXPIRED_ERROR_CODES.has(errcode)) {
      input.tokenClient.clear();
      return sendTemplateMessage(input, true);
    }
    return {
      errorMessage: `WECHAT_TEMPLATE_SEND_FAILED:${errcode || response.status}`,
      providerResponse: body,
      success: false
    };
  }

  return {
    providerMessageId: normalizeProviderMessageId(body.msgid),
    providerResponse: body,
    success: true
  };
}

async function createNotificationRecord(prisma, input) {
  const now = new Date();
  return withUniqueNotificationNo(() =>
    prisma.notificationRecord.create({
      data: {
        channel: "WECHAT_OFFICIAL_ACCOUNT",
        content: input.typeConfig.content,
        customerAccountId: input.account.id,
        customerId: input.customer.id,
        errorMessage: input.result.errorMessage,
        failedAt: input.status === "FAILED" ? now : undefined,
        notificationNo: createBusinessNo("NTF"),
        notificationStatus: input.status,
        notificationType: input.typeConfig.notificationType,
        payload: input.data,
        providerMessageId: input.result.providerMessageId,
        providerResponse: input.result.providerResponse,
        recipientOpenId: input.account.wechatOpenId,
        recipientPhone: input.account.phone,
        sentAt: input.status === "SENT" ? now : undefined,
        templateCode: input.templateCode,
        templateId: input.template?.id,
        title: input.typeConfig.title,
        url: input.url
      }
    })
  );
}

async function resolveSmokeCustomer(prisma, options) {
  const customerId = options.customerId ?? process.env.WECHAT_OA_TEST_CUSTOMER_ID;
  const customerNo = options.customerNo ?? process.env.WECHAT_OA_TEST_CUSTOMER_NO ?? DEFAULT_TEST_CUSTOMER_NO;
  if (customerId) {
    const customer = await prisma.customer.findFirst({ where: { deletedAt: null, id: customerId } });
    if (!customer) throw new Error("WECHAT_OA_TEST_CUSTOMER_ID was not found.");
    return customer;
  }

  const existing = await prisma.customer.findFirst({ where: { customerNo, deletedAt: null } });
  if (existing) return existing;

  if (process.env.WECHAT_OA_CREATE_TEST_CUSTOMER !== "1") {
    throw new Error(`Smoke customer ${customerNo} not found. Set WECHAT_OA_CREATE_TEST_CUSTOMER=1 to create it.`);
  }

  const phone = options.phone ?? process.env.WECHAT_OA_TEST_PHONE ?? DEFAULT_TEST_PHONE;
  return prisma.customer.create({
    data: {
      customerNo,
      mobile: phone,
      name: "Stage10H WeChat smoke customer",
      sourceChannel: "STAGE10H_WECHAT_OA_SMOKE",
      status: "ACTIVE"
    }
  });
}

async function resolveSmokeAccount(prisma, customer, openId, options) {
  const phone = options.phone ?? process.env.WECHAT_OA_TEST_PHONE ?? customer.mobile ?? DEFAULT_TEST_PHONE;
  const allowBind = process.env.WECHAT_OA_BIND_OPENID === "1" || process.env.WECHAT_OA_CREATE_TEST_CUSTOMER === "1";
  const account = await prisma.customerAccount.findFirst({
    orderBy: { updatedAt: "desc" },
    where: {
      accountStatus: "ACTIVE",
      customerId: customer.id,
      deletedAt: null
    }
  });

  if (!account) {
    if (!allowBind) {
      throw new Error("No active CustomerAccount found. Set WECHAT_OA_BIND_OPENID=1 to create one for the smoke customer.");
    }
    return prisma.customerAccount.create({
      data: {
        accountStatus: "ACTIVE",
        customerId: customer.id,
        phone,
        phoneVerifiedAt: new Date(),
        wechatOpenId: openId
      }
    });
  }

  if (account.wechatOpenId === openId) return account;
  if (!allowBind) {
    throw new Error(`CustomerAccount openid mismatch: current=${maskOpenId(account.wechatOpenId ?? "")} requested=${maskOpenId(openId)}.`);
  }

  return prisma.customerAccount.update({
    data: {
      wechatOpenId: openId
    },
    where: { id: account.id }
  });
}

async function resolveTemplate(prisma, typeConfig, templateId) {
  const template = await prisma.notificationTemplate.findFirst({
    where: {
      channel: "WECHAT_OFFICIAL_ACCOUNT",
      deletedAt: null,
      templateCode: typeConfig.templateCode,
      templateStatus: "ACTIVE"
    }
  });

  if (template && process.env.WECHAT_OA_SYNC_TEMPLATE_ID === "1" && template.providerTemplateId !== templateId) {
    return prisma.notificationTemplate.update({
      data: { providerTemplateId: templateId },
      where: { id: template.id }
    });
  }

  return template;
}

function createPrismaClient() {
  const databaseUrl = requiredEnv("DATABASE_URL");
  return new PrismaClient({
    adapter: new PrismaPg(normalizeLocalhostDatabaseUrl(databaseUrl))
  });
}

function parseArgs(args) {
  const options = {
    customerId: undefined,
    customerNo: undefined,
    envFiles: [],
    help: false,
    mode: undefined,
    openId: undefined,
    phone: undefined,
    portalBaseUrl: undefined,
    resultPath: undefined,
    templateId: undefined,
    templateType: undefined,
    url: undefined
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--customer-id":
        options.customerId = requireNextArg(args, index, arg);
        index += 1;
        break;
      case "--customer-no":
        options.customerNo = requireNextArg(args, index, arg);
        index += 1;
        break;
      case "--env-file":
        options.envFiles.push(requireNextArg(args, index, arg));
        index += 1;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--mode":
        options.mode = requireNextArg(args, index, arg);
        index += 1;
        break;
      case "--openid":
        options.openId = requireNextArg(args, index, arg);
        index += 1;
        break;
      case "--phone":
        options.phone = requireNextArg(args, index, arg);
        index += 1;
        break;
      case "--portal-base-url":
        options.portalBaseUrl = requireNextArg(args, index, arg);
        index += 1;
        break;
      case "--result-path":
        options.resultPath = requireNextArg(args, index, arg);
        index += 1;
        break;
      case "--template-id":
        options.templateId = requireNextArg(args, index, arg);
        index += 1;
        break;
      case "--template-type":
        options.templateType = requireNextArg(args, index, arg);
        index += 1;
        break;
      case "--url":
        options.url = requireNextArg(args, index, arg);
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
    const content = readFileSync(resolve(envFile), "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator <= 0) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = unquoteEnvValue(trimmed.slice(separator + 1).trim());
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

function unquoteEnvValue(value) {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function requiredEnv(key) {
  const value = process.env[key]?.trim();
  if (!value || value === "<CHANGE_ME>") {
    throw new Error(`${key} is required.`);
  }
  return value;
}

function normalizeMode(value) {
  const normalized = value.toLowerCase().replace(/-/g, "_");
  if (normalized === "token") return "token";
  if (normalized === "template" || normalized === "send") return "template";
  throw new Error("WECHAT_OA_SMOKE_MODE must be token or template.");
}

export function normalizeTemplateType(value) {
  const normalized = value.toUpperCase();
  if (!SMOKE_TYPES[normalized]) {
    throw new Error(`Unsupported template type: ${value}. Supported: ${Object.keys(SMOKE_TYPES).join(", ")}`);
  }
  return normalized;
}

function normalizeSingleOpenId(value) {
  const openId = value?.trim();
  if (!openId || openId === "<CHANGE_ME>") {
    throw new Error("WECHAT_OA_TEST_OPENID is required for template smoke.");
  }
  if (/[\s,;*]/u.test(openId)) {
    if (process.env.STAGE10H_ALLOW_BATCH_SEND === "1") {
      throw new Error("Batch mode is not implemented for this smoke script; provide exactly one openid.");
    }
    throw new Error("Only one test openid is allowed. Batch or wildcard sends are blocked by default.");
  }
  return openId;
}

function normalizeBaseUrl(value) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(trimmed)) {
    throw new Error("Portal base URL must start with http:// or https://.");
  }
  return trimmed;
}

function readTemplateData(templateType) {
  const raw = process.env.WECHAT_OA_TEMPLATE_DATA_JSON?.trim();
  if (raw) {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("WECHAT_OA_TEMPLATE_DATA_JSON must be a JSON object.");
    }
    return parsed;
  }

  return {
    first: `${templateType} controlled validation`,
    keyword1: "Stage 10H-B",
    keyword2: new Date().toISOString(),
    keyword3: "single-openid smoke",
    remark: "Please ignore this validation message.",
    status: "VALIDATION",
    time: new Date().toISOString(),
    title: `${templateType} smoke`
  };
}

function toWechatTemplateData(data) {
  const result = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    result[key] = {
      value: value === null || value === undefined ? "" : String(value)
    };
  }
  return result;
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function normalizeProviderMessageId(value) {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

async function withUniqueNotificationNo(operation, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isUniqueConstraintError(error) || attempt === maxAttempts) throw error;
    }
  }
  throw new Error("Notification number retry exhausted.");
}

function createBusinessNo(prefix, now = new Date()) {
  return `${prefix}${formatDateTime(now)}${createRandomCode()}`;
}

function createRandomCode(length = 4) {
  let code = "";
  for (let index = 0; index < length; index += 1) {
    code += RANDOM_ALPHABET[randomInt(RANDOM_ALPHABET.length)];
  }
  return code;
}

function formatDateTime(date) {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds())
  ].join("");
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function isUniqueConstraintError(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

function normalizeLocalhostDatabaseUrl(value) {
  const url = new URL(value);
  if (url.hostname === "localhost") {
    url.hostname = "127.0.0.1";
  }
  return url.toString();
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function maskAppId(value) {
  if (value.length <= 8) return "wx****";
  return `${value.slice(0, 2)}****${value.slice(-4)}`;
}

function maskOpenId(value) {
  if (!value) return "****";
  if (value.length <= 8) return `${value.slice(0, 2)}****`;
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function maskTemplateId(value) {
  if (value.length <= 8) return "****masked";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function maskProviderMessageId(value) {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function maskPath(value) {
  return value.replace(/\\/g, "/").replace(/^.*\/(\.tmp\/.*)$/u, "$1");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function printHelp() {
  console.log(`Usage:
  WECHAT_OA_SMOKE_MODE=token node scripts/wechat-official-account-smoke.mjs
  WECHAT_OA_SMOKE_MODE=template node scripts/wechat-official-account-smoke.mjs --template-type PAYMENT_PENDING

Options:
  --mode <token|template>       Smoke mode. Defaults to WECHAT_OA_SMOKE_MODE or token.
  --env-file <path>             Load env values from a local file. Values are never printed.
  --openid <openid>             Single test openid. Required for template mode.
  --template-type <type>        APPLICATION_PROGRESS, FINAL_PLAN_PENDING, CONTRACT_PENDING, PAYMENT_PENDING, HANDOVER_PENDING, SERVICE_CASE_UPDATE.
  --template-id <id>            Override the WECHAT_TEMPLATE_* env mapping.
  --customer-id <uuid>          Existing smoke customer ID.
  --customer-no <no>            Existing smoke customerNo. Defaults to ${DEFAULT_TEST_CUSTOMER_NO}.
  --phone <phone>               Phone for optional smoke CustomerAccount creation.
  --url <url>                   Template click-through URL.
  --portal-base-url <url>       Base URL used when --url is omitted.
  --result-path <path>          Save masked smoke result JSON. Defaults to ${DEFAULT_RESULT_PATH}.

Safety:
  Template mode accepts exactly one openid and never prints access_token, AppSecret, full openid, or full template ID.
  Set WECHAT_OA_BIND_OPENID=1 to bind/update the smoke customer's openid.
  Set WECHAT_OA_CREATE_TEST_CUSTOMER=1 to create the default smoke customer/account if missing.
  Set WECHAT_OA_SYNC_TEMPLATE_ID=1 to copy the selected WECHAT_TEMPLATE_* value into NotificationTemplate.providerTemplateId.
`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
