#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const WECHAT_API_BASE_URL = "https://api.weixin.qq.com";
const DEFAULT_PORTAL_BASE_URL = "https://app.subauto.keybox.cloud";
const DEFAULT_APPLY_RESULT_PATH = ".tmp/stage10h-wechat-menu-apply-result.json";

export async function runMenuCli(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    printHelp();
    return;
  }

  loadEnvFiles(options.envFiles);
  const portalBaseUrl = normalizeBaseUrl(options.portalBaseUrl ?? process.env.PORTAL_BASE_URL ?? DEFAULT_PORTAL_BASE_URL);
  const menu = buildMenu(portalBaseUrl);

  console.log("WeChat Official Account menu payload:");
  console.log(JSON.stringify(menu, null, 2));

  if (!options.apply) {
    console.log("dry-run only. No WeChat API call was made.");
    return;
  }

  if (process.env.WECHAT_MENU_APPLY !== "1") {
    throw new Error("WECHAT_MENU_APPLY=1 is required before applying the real WeChat menu.");
  }

  const appId = requiredEnv("WECHAT_OFFICIAL_ACCOUNT_APP_ID");
  const appSecret = requiredEnv("WECHAT_OFFICIAL_ACCOUNT_APP_SECRET");
  const accessToken = await requestAccessToken(appId, appSecret);
  const result = await createMenu(accessToken, menu);
  const resultPath = resolve(options.resultPath ?? process.env.WECHAT_MENU_RESULT_PATH ?? DEFAULT_APPLY_RESULT_PATH);
  writeJson(resultPath, {
    appliedAt: new Date().toISOString(),
    appIdMasked: maskAppId(appId),
    portalBaseUrl,
    result
  });

  if (result.errcode !== 0) {
    throw new Error(`WECHAT_MENU_APPLY_FAILED:${result.errcode ?? "UNKNOWN"}`);
  }

  console.log(`menu apply succeeded for appId=${maskAppId(appId)}.`);
  console.log(`result saved to ${maskPath(resultPath)}.`);
  console.log("WeChat client menu refresh can be delayed by client-side cache.");
}

function buildMenu(portalBaseUrl) {
  return {
    button: [
      {
        name: "\u8ba2\u9605\u7528\u8f66",
        sub_button: [
          {
            name: "\u6d4f\u89c8\u8f66\u8f86",
            type: "view",
            url: `${portalBaseUrl}/portal/catalog`
          },
          {
            name: "\u6211\u7684\u7533\u8bf7",
            type: "view",
            url: `${portalBaseUrl}/portal/applications`
          }
        ]
      },
      {
        name: "\u6211\u7684\u670d\u52a1",
        sub_button: [
          {
            name: "\u6211\u7684\u8ba2\u5355",
            type: "view",
            url: `${portalBaseUrl}/portal/orders`
          },
          {
            name: "\u6211\u7684\u8d26\u5355",
            type: "view",
            url: `${portalBaseUrl}/portal/bills`
          },
          {
            name: "\u6211\u7684\u6743\u76ca",
            type: "view",
            url: `${portalBaseUrl}/portal/entitlements`
          }
        ]
      },
      {
        name: "\u5e2e\u52a9",
        sub_button: [
          {
            name: "\u4e8b\u6545\u62a5\u6848",
            type: "view",
            url: `${portalBaseUrl}/portal/service-cases/new?type=ACCIDENT_REPORT`
          },
          {
            name: "\u6551\u63f4\u7533\u8bf7",
            type: "view",
            url: `${portalBaseUrl}/portal/service-cases/new?type=RESCUE_REQUEST`
          }
        ]
      }
    ]
  };
}

function parseArgs(args) {
  const options = {
    apply: false,
    envFiles: [],
    help: false,
    portalBaseUrl: undefined,
    resultPath: undefined
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--apply":
        options.apply = true;
        break;
      case "--dry-run":
        options.apply = false;
        break;
      case "--env-file":
        options.envFiles.push(requireNextArg(args, index, arg));
        index += 1;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--portal-base-url":
        options.portalBaseUrl = requireNextArg(args, index, arg);
        index += 1;
        break;
      case "--result-path":
        options.resultPath = requireNextArg(args, index, arg);
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

async function requestAccessToken(appId, appSecret) {
  const params = new URLSearchParams({
    appid: appId,
    grant_type: "client_credential",
    secret: appSecret
  });
  const response = await fetch(`${WECHAT_API_BASE_URL}/cgi-bin/token?${params.toString()}`);
  const body = await safeJson(response);
  if (!response.ok || typeof body.access_token !== "string") {
    throw new Error(`WECHAT_ACCESS_TOKEN_FAILED:${body.errcode ?? response.status}`);
  }
  console.log(`access_token fetched for appId=${maskAppId(appId)}; token value was not printed.`);
  return body.access_token;
}

async function createMenu(accessToken, menu) {
  const response = await fetch(`${WECHAT_API_BASE_URL}/cgi-bin/menu/create?access_token=${accessToken}`, {
    body: JSON.stringify(menu),
    headers: { "Content-Type": "application/json" },
    method: "POST"
  });
  const body = await safeJson(response);
  if (!response.ok) {
    return { errcode: response.status, errmsg: body.errmsg ?? "HTTP_ERROR" };
  }
  return body;
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function normalizeBaseUrl(value) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(trimmed)) {
    throw new Error("Portal base URL must start with http:// or https://.");
  }
  return trimmed;
}

function maskAppId(value) {
  if (value.length <= 8) return "wx****";
  return `${value.slice(0, 2)}****${value.slice(-4)}`;
}

function maskPath(value) {
  return value.replace(/\\/g, "/").replace(/^.*\/(\.tmp\/.*)$/u, "$1");
}

function printHelp() {
  console.log(`Usage:
  node scripts/wechat-menu.mjs [--dry-run]
  WECHAT_MENU_APPLY=1 node scripts/wechat-menu.mjs --apply

Options:
  --apply                 Apply menu to the real WeChat Official Account. Requires WECHAT_MENU_APPLY=1.
  --dry-run               Print menu JSON only. This is the default.
  --env-file <path>       Load env values from a local file. Values are never printed.
  --portal-base-url <url> Override PORTAL_BASE_URL for the menu links.
  --result-path <path>    Save apply response JSON. Defaults to ${DEFAULT_APPLY_RESULT_PATH}.
`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMenuCli().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
