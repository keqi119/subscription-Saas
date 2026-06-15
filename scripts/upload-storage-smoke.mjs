import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const apiBaseUrl = normalizeApiBaseUrl(
  process.env.SMOKE_API_BASE_URL ?? process.env.API_BASE_URL ?? "http://localhost:3001/api"
);
const username = process.env.SMOKE_ADMIN_USERNAME ?? process.env.SMOKE_USERNAME ?? "admin";
const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.SMOKE_PASSWORD ?? "Admin@123456";
const materialType = process.env.SMOKE_UPLOAD_MATERIAL_TYPE ?? "ID_CARD";
const expectedStorageDriver = process.env.SMOKE_EXPECT_STORAGE_DRIVER;
const resultFile = path.resolve(
  args.resultFile ?? process.env.SMOKE_UPLOAD_RESULT_FILE ?? path.join(".tmp", "upload-storage-smoke.json")
);

let failures = 0;

async function main() {
  await runCheck("GET /health", async () => {
    const health = await assertJsonGet("/health");
    if (expectedStorageDriver && health.storage !== expectedStorageDriver) {
      throw new Error(`Expected storage ${expectedStorageDriver}, got ${health.storage ?? "<missing>"}`);
    }
    return { status: 200 };
  });

  const { cookie } = await runCheck("POST /auth/login", login);
  if (args.downloadOnly) {
    const saved = JSON.parse(await readFile(resultFile, "utf8"));
    await runCheck("GET previous material preview", () =>
      downloadMaterial(saved.applicationId, saved.fileRecordId, saved.expectedContent, cookie)
    );
    finish();
    return;
  }

  const scenario = await loadScenario();

  if (!scenario?.applicationId) {
    throw new Error("Scenario file must include applicationId.");
  }

  const payload = `Stage 9G-B upload smoke ${new Date().toISOString()}\napplicationId=${scenario.applicationId}\n`;
  const upload = await runCheck("POST /applications/:id/materials", () =>
    uploadMaterial(scenario.applicationId, payload, cookie)
  );
  const fileRecordId = upload.fileRecordId;

  if (!fileRecordId) {
    throw new Error("Upload response did not include fileRecordId.");
  }

  await runCheck("GET material preview", () =>
    downloadMaterial(scenario.applicationId, fileRecordId, payload, cookie)
  );

  await writeResult({
    applicationId: scenario.applicationId,
    createdAt: new Date().toISOString(),
    expectedContent: payload,
    fileRecordId,
    materialType
  });

  assertNoPublicOssUrl("upload response", JSON.stringify(upload.raw));
  finish();
  console.log(`Uploaded material fileRecordId=${fileRecordId}`);
}

function finish() {
  if (failures > 0) {
    console.error(`FAIL upload storage smoke against ${apiBaseUrl}: ${failures} check(s) failed.`);
    process.exit(1);
  }

  console.log(`PASS upload storage smoke against ${apiBaseUrl}`);
}

async function login() {
  const response = await fetch(`${apiBaseUrl}/auth/login`, {
    body: JSON.stringify({ password, username }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${await response.text()}`);
  }

  const cookie = response.headers.get("set-cookie");
  if (!cookie) {
    throw new Error("Login did not return an auth cookie.");
  }

  return {
    cookie,
    status: response.status
  };
}

async function uploadMaterial(applicationId, content, cookie) {
  const form = new FormData();
  form.append("materialType", materialType);
  form.append("reviewRemark", "Stage 9G-B upload storage smoke");
  form.append(
    "file",
    new Blob([content], { type: "text/plain" }),
    `stage9g-upload-smoke-${Date.now()}.txt`
  );

  const response = await fetch(`${apiBaseUrl}/applications/${applicationId}/materials`, {
    body: form,
    headers: { cookie },
    method: "POST"
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${text}`);
  }

  assertNoPublicOssUrl("upload response body", text);

  const json = JSON.parse(text);
  const file = json.files?.[0];
  return {
    fileRecordId: file?.fileRecordId ?? file?.id,
    raw: json,
    status: response.status
  };
}

async function downloadMaterial(applicationId, fileRecordId, expectedContent, cookie) {
  const response = await fetch(
    `${apiBaseUrl}/applications/${applicationId}/material-files/${fileRecordId}/preview`,
    {
      headers: { cookie }
    }
  );
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${text}`);
  }

  if (text !== expectedContent) {
    throw new Error("Downloaded material content did not match uploaded content.");
  }

  assertNoPublicOssUrl("download response headers", JSON.stringify(Object.fromEntries(response.headers.entries())));
  assertNoPublicOssUrl("download response body", text);

  return { status: response.status };
}

async function assertJsonGet(endpoint) {
  const response = await fetch(`${apiBaseUrl}${endpoint}`);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${await response.text()}`);
  }

  return response.json();
}

async function runCheck(name, fn) {
  try {
    const result = await fn();
    const status = result?.status ? ` (${result.status})` : "";
    console.log(`PASS ${name}${status}`);
    return result;
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error.message}`);
    throw error;
  }
}

async function loadScenario() {
  const scenarioFile = getScenarioFilePath();
  if (!(await fileExists(scenarioFile))) {
    throw new Error(`Scenario file does not exist: ${scenarioFile}`);
  }

  const scenario = JSON.parse(await readFile(scenarioFile, "utf8"));
  console.log(`Loaded scenario file: ${scenarioFile}`);
  return scenario;
}

function getScenarioFilePath() {
  const file =
    args.scenarioFile ?? process.env.SMOKE_SCENARIO_FILE ?? path.join(".tmp", "scenarios", "mainline.json");
  return path.resolve(file);
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function assertNoPublicOssUrl(label, value) {
  if (/https?:\/\/[^"'\s]*(oss|aliyuncs|aliyun)[^"'\s]*/i.test(value)) {
    throw new Error(`${label} appears to expose an OSS public URL.`);
  }
}

function parseArgs(argv) {
  const parsed = {
    downloadOnly: false,
    resultFile: null,
    scenarioFile: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--scenario-file") {
      parsed.scenarioFile = argv[index + 1];
      index += 1;
    } else if (value === "--result-file") {
      parsed.resultFile = argv[index + 1];
      index += 1;
    } else if (value === "--download-only") {
      parsed.downloadOnly = true;
    }
  }

  return parsed;
}

async function writeResult(result) {
  await mkdir(path.dirname(resultFile), { recursive: true });
  await writeFile(resultFile, JSON.stringify(result, null, 2));
  console.log(`Wrote upload smoke result: ${resultFile}`);
}

function normalizeApiBaseUrl(value) {
  const stripped = stripTrailingSlash(value);
  if (stripped.endsWith("/api")) {
    return stripped;
  }
  return `${stripped}/api`;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

main().catch((error) => {
  console.error(`FAIL upload storage smoke: ${error.message}`);
  process.exit(1);
});
