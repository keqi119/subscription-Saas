import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`RELEASE_CLIENT_GATE_INPUT_MISSING:${name}`);
  return value.replace(/\/$/u, "");
}

function digest(value: unknown) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

test("built portal calls the Manifest public API base through its embedded client", async ({
  page
}) => {
  const webBase = required("RELEASE_GATE_WEB_BASE");
  const publicApiBase = required("RELEASE_GATE_PUBLIC_API_BASE");
  const embeddedApiBase = required("RELEASE_GATE_EMBEDDED_API_BASE");
  const expectedWebOrigin = new URL(webBase).origin;
  const expectedCatalogUrl = new URL(
    "portal/catalog/model-definitions",
    `${publicApiBase}/`
  ).toString();
  const requests: string[] = [];
  const pageErrors: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const catalogResponsePromise = page.waitForResponse(
    (response) => response.url() === expectedCatalogUrl
  );
  const navigation = await page.goto(`${webBase}/portal/catalog`, {
    waitUntil: "domcontentloaded"
  });
  expect(navigation?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "订阅车辆" })).toBeVisible();
  const catalogResponse = await catalogResponsePromise;
  expect(catalogResponse.status()).toBe(200);
  expect(requests).toContain(expectedCatalogUrl);
  expect(embeddedApiBase).toBe(publicApiBase);
  expect(catalogResponse.headers()["access-control-allow-origin"]).toBe(expectedWebOrigin);
  expect(pageErrors).toEqual([]);

  const scriptUrls = await page
    .locator("script[src]")
    .evaluateAll((scripts) =>
      scripts.map((script) => (script as HTMLScriptElement).src).filter(Boolean)
    );
  const scriptBodies = await Promise.all(
    scriptUrls.map(async (url) => {
      const response = await page.request.get(url);
      expect(response.ok()).toBeTruthy();
      return response.text();
    })
  );
  expect(scriptBodies.some((body) => body.includes(embeddedApiBase))).toBeTruthy();

  const evidence = {
    schemaVersion: "web-public-api-evidence.v1",
    webOrigin: expectedWebOrigin,
    publicApiBase,
    embeddedApiBase,
    actualRequestUrl: expectedCatalogUrl,
    corsAllowOrigin: expectedWebOrigin,
    responseStatus: catalogResponse.status(),
    bundleContainsEmbeddedApiBase: true,
    scriptSetDigest: digest(scriptUrls.sort()),
    networkSetDigest: digest([...new Set(requests)].sort()),
    observedAt: new Date().toISOString()
  };
  const evidenceFile = process.env.RELEASE_GATE_WEB_EVIDENCE_FILE;
  if (evidenceFile) {
    await writeFile(evidenceFile, JSON.stringify(evidence), { flag: "wx" });
  }
});
