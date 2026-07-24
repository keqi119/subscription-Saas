import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..", "..");

describe("Deployment operations safety", () => {
  it("pins staging and production Compose project names", () => {
    for (const file of [
      "docker-compose.staging.example.yml",
      "docker-compose.staging.images.example.yml"
    ]) {
      expect(read(file)).toMatch(/^name: subauto-staging$/m);
    }

    for (const file of [
      "docker-compose.prod.example.yml",
      "docker-compose.production.images.example.yml"
    ]) {
      expect(read(file)).toMatch(/^name: subauto-production$/m);
    }
  });

  it("keeps staging host ports isolated from production", () => {
    const compose = read("docker-compose.staging.images.example.yml");
    const environment = read(".env.staging.images.example");
    const nginx = read("nginx/staging-subauto.example.conf");

    expect(compose).toContain("${API_HOST_PORT:-3101}:3001");
    expect(compose).toContain("${WEB_HOST_PORT:-3100}:3000");
    expect(environment).toContain("API_HOST_PORT=3101");
    expect(environment).toContain("WEB_HOST_PORT=3100");
    expect(nginx).toContain("proxy_pass http://127.0.0.1:3100;");
    expect(nginx).toContain("proxy_pass http://127.0.0.1:3101;");
    expect(nginx).not.toContain("proxy_pass http://127.0.0.1:3001;");
  });

  it("disables inherited proxy caching for staging Web and API", () => {
    const nginx = read("nginx/staging-subauto.example.conf");
    const cacheDirectives = nginx.match(/^\s*proxy_cache off;$/gm) ?? [];

    expect(cacheDirectives).toHaveLength(2);
  });

  it("uses an explicit staging project name in image deployment commands", () => {
    const runbook = read("docs/staging-deployment-runbook.md");
    const imageCommands =
      runbook.match(
        /^docker compose .*docker-compose\.staging\.images\.example\.yml.*$/gm
      ) ?? [];

    expect(imageCommands.length).toBeGreaterThan(0);
    for (const command of imageCommands) {
      expect(command).toContain("-p subauto-staging");
    }
  });
});

function read(file: string) {
  return readFileSync(join(repoRoot, file), "utf8");
}
