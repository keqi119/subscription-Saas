const apiBaseUrl = process.env.SMOKE_API_BASE_URL ?? process.env.API_BASE_URL ?? "http://localhost:3001/api";
const webBaseUrl = process.env.SMOKE_WEB_BASE_URL;
const username = process.env.SMOKE_ADMIN_USERNAME ?? process.env.SMOKE_USERNAME ?? "admin";
const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.SMOKE_PASSWORD ?? "Admin@123456";

const endpoints = [
  "/health",
  "/auth/me",
  "/applications",
  "/products",
  "/quotes",
  "/vehicle-valuation-reviews?page=1&pageSize=1",
  "/reports/dashboard-summary",
  "/reports/asset-profitability/summary",
  "/users",
  "/roles",
  "/audit-logs"
];

const webRoutes = [
  "/",
  "/applications",
  "/vehicles",
  "/orders",
  "/reports",
  "/reports/asset-profitability",
  "/residual-market",
  "/vehicle-valuation-reviews"
];

async function main() {
  const loginResponse = await fetch(`${apiBaseUrl}/auth/login`, {
    body: JSON.stringify({ password, username }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });

  if (!loginResponse.ok) {
    throw new Error(`Login failed: ${loginResponse.status} ${await loginResponse.text()}`);
  }

  const cookie = loginResponse.headers.get("set-cookie");
  if (!cookie) {
    throw new Error("Login did not return an auth cookie.");
  }

  for (const endpoint of endpoints) {
    await assertGet(endpoint, cookie);
  }

  for (let index = 0; index < 10; index += 1) {
    await Promise.all([
      assertGet("/applications", cookie),
      assertGet("/products", cookie),
      assertGet("/users", cookie)
    ]);
  }

  if (webBaseUrl) {
    for (const route of webRoutes) {
      await assertWebRoute(route);
    }
  }

  console.log(`API smoke passed against ${apiBaseUrl}`);
}

async function assertGet(endpoint, cookie) {
  const response = await fetch(`${apiBaseUrl}${endpoint}`, {
    headers: { cookie }
  });

  if (!response.ok) {
    throw new Error(`GET ${endpoint} failed: ${response.status} ${await response.text()}`);
  }
}

async function assertWebRoute(route) {
  const response = await fetch(`${webBaseUrl}${route}`, {
    redirect: "manual"
  });

  if (response.status < 200 || response.status >= 400) {
    throw new Error(`WEB ${route} failed: ${response.status} ${await response.text()}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
