#!/usr/bin/env node

const DEFAULT_PORTAL_BASE_URL = "http://localhost:3000";

const publicRoutes = [
  "/portal/login",
  "/portal/terms",
  "/portal/privacy",
  "/portal/catalog"
];

const protectedRoutes = [
  "/portal",
  "/portal/me",
  "/portal/applications",
  "/portal/applications/__smoke__",
  "/portal/contracts",
  "/portal/contracts/__smoke__",
  "/portal/contracts/__smoke__/sign",
  "/portal/payment-orders",
  "/portal/payment-orders/__smoke__",
  "/portal/bills",
  "/portal/bills/__smoke__",
  "/portal/orders",
  "/portal/orders/__smoke__",
  "/portal/deposit",
  "/portal/entitlements",
  "/portal/service-cases",
  "/portal/service-cases/new",
  "/portal/service-cases/__smoke__",
  "/portal/notifications"
];

const menuTargetRoutes = [
  "/portal/catalog",
  "/portal/applications",
  "/portal/orders",
  "/portal/bills",
  "/portal/entitlements",
  "/portal/service-cases/new?type=ACCIDENT_REPORT",
  "/portal/service-cases/new?type=RESCUE_REQUEST"
];

const portalBaseUrl = stripTrailingSlash(process.env.PORTAL_BASE_URL ?? process.env.PORTAL_SMOKE_BASE_URL ?? DEFAULT_PORTAL_BASE_URL);
const allowUnauth = process.env.PORTAL_SMOKE_ALLOW_UNAUTH !== "0";
const timeoutMs = Number(process.env.PORTAL_SMOKE_TIMEOUT_MS ?? "10000");
let failures = 0;

async function main() {
  console.log(`Portal route smoke started: ${portalBaseUrl}`);
  console.log(`PORTAL_SMOKE_ALLOW_UNAUTH=${allowUnauth ? "1" : "0"}`);

  for (const route of publicRoutes) {
    await checkRoute("public", route, { allowRedirectToLogin: false });
  }

  for (const route of protectedRoutes) {
    await checkRoute("protected", route, { allowRedirectToLogin: allowUnauth });
  }

  for (const route of menuTargetRoutes) {
    await checkRoute("menu-target", route, { allowRedirectToLogin: allowUnauth });
  }

  if (failures > 0) {
    console.error(`FAIL Portal route smoke: ${failures} route(s) failed.`);
    process.exit(1);
  }

  console.log("PASS Portal route smoke");
}

async function checkRoute(scope, route, options) {
  const url = new URL(route, `${portalBaseUrl}/`).toString();
  try {
    const response = await fetchWithTimeout(url);
    const finalUrl = response.url || url;
    const redirectedToLogin = finalUrl.includes("/portal/login");
    const okStatus = response.status >= 200 && response.status < 400;
    const allowedUnauthRedirect = options.allowRedirectToLogin && redirectedToLogin && okStatus;
    const passed = okStatus || allowedUnauthRedirect;

    if (!passed || response.status >= 500) {
      failures += 1;
      console.error(`FAIL ${scope} ${route}: status=${response.status} final=${finalUrl}`);
      return;
    }

    console.log(`PASS ${scope} ${route}: status=${response.status}${redirectedToLogin ? " login-redirect" : ""}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${scope} ${route}: ${errorMessage(error)}`);
  }
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      redirect: "follow",
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exit(1);
});
