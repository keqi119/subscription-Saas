import { describe, expect, it } from "vitest";

import databaseTestManifest from "../../../release/contracts/database-test-manifest.v1.json";
import config from "../vitest.config";

type ProjectConfig = {
  test?: {
    exclude?: string[];
    fileParallelism?: boolean;
    hookTimeout?: number;
    include?: string[];
    name?: string;
    testTimeout?: number;
  };
};

describe("API Vitest project boundaries", () => {
  it("uses every manifested Vitest file exactly once in both project boundaries", () => {
    const projects = (config.test?.projects ?? []) as ProjectConfig[];
    const databaseProject = projects.find((project) => project.test?.name === "database");
    const unitProject = projects.find((project) => project.test?.name === "unit");
    const expected = databaseTestManifest.suites
      .filter((suite) => suite.runner === "vitest")
      .flatMap((suite) => suite.files)
      .map((file) => file.replace(/^apps\/api\//, ""))
      .sort();

    expect(databaseProject?.test?.include).toEqual(expected);
    expect(unitProject?.test?.exclude).toEqual(expected);
    expect(new Set(databaseProject?.test?.include).size).toBe(expected.length);
    expect(new Set(unitProject?.test?.exclude).size).toBe(expected.length);
  });

  it("gives serialized database tests a realistic timeout budget", () => {
    const projects = (config.test?.projects ?? []) as ProjectConfig[];
    const databaseProject = projects.find((project) => project.test?.name === "database");

    expect(databaseProject?.test?.testTimeout).toBe(30_000);
    expect(databaseProject?.test?.hookTimeout).toBe(30_000);
  });

  it("runs the journey repository integration suite in the serial database project", () => {
    const projects = (config.test?.projects ?? []) as ProjectConfig[];
    const databaseProject = projects.find((project) => project.test?.name === "database");
    const unitProject = projects.find((project) => project.test?.name === "unit");
    const integrationSuite = "test/subscription-journey.repository.integration.spec.ts";

    expect(databaseProject?.test?.include).toContain(integrationSuite);
    expect(databaseProject?.test?.fileParallelism).toBe(false);
    expect(unitProject?.test?.exclude).toContain(integrationSuite);
  });

  it("runs the asset operations repository integration suite only in the serial database project", () => {
    const projects = (config.test?.projects ?? []) as ProjectConfig[];
    const databaseProject = projects.find((project) => project.test?.name === "database");
    const unitProject = projects.find((project) => project.test?.name === "unit");
    const integrationSuite = "test/asset-operations.repository.integration.spec.ts";

    expect(databaseProject?.test?.include).toContain(integrationSuite);
    expect(databaseProject?.test?.fileParallelism).toBe(false);
    expect(unitProject?.test?.exclude).toContain(integrationSuite);
  });

  it("runs the asset accounting repository integration suite only in the serial database project", () => {
    const projects = (config.test?.projects ?? []) as ProjectConfig[];
    const databaseProject = projects.find((project) => project.test?.name === "database");
    const unitProject = projects.find((project) => project.test?.name === "unit");
    const integrationSuite = "test/asset-accounting.repository.integration.spec.ts";

    expect(databaseProject?.test?.include).toContain(integrationSuite);
    expect(databaseProject?.test?.fileParallelism).toBe(false);
    expect(unitProject?.test?.exclude).toContain(integrationSuite);
  });

  it("runs the subscription closure repository integration suite only in the serial database project", () => {
    const projects = (config.test?.projects ?? []) as ProjectConfig[];
    const databaseProject = projects.find((project) => project.test?.name === "database");
    const unitProject = projects.find((project) => project.test?.name === "unit");
    const integrationSuite = "test/subscription-closure.repository.integration.spec.ts";

    expect(databaseProject?.test?.include).toContain(integrationSuite);
    expect(databaseProject?.test?.fileParallelism).toBe(false);
    expect(unitProject?.test?.exclude).toContain(integrationSuite);
  });

  it("runs the ACTIVE-order contract-change E2E suite in the serial database project", () => {
    const projects = (config.test?.projects ?? []) as ProjectConfig[];
    const databaseProject = projects.find((project) => project.test?.name === "database");
    const unitProject = projects.find((project) => project.test?.name === "unit");
    const integrationSuite = "test/subscription-change-active-order.e2e-spec.ts";

    expect(databaseProject?.test?.include).toContain(integrationSuite);
    expect(databaseProject?.test?.fileParallelism).toBe(false);
    expect(unitProject?.test?.exclude).toContain(integrationSuite);
  });
});
