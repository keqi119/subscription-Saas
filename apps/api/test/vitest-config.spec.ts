import { describe, expect, it } from "vitest";

import config from "../vitest.config";

type ProjectConfig = {
  test?: {
    exclude?: string[];
    fileParallelism?: boolean;
    include?: string[];
    name?: string;
    testTimeout?: number;
  };
};

describe("API Vitest project boundaries", () => {
  it("gives serialized database tests a realistic timeout budget", () => {
    const projects = (config.test?.projects ?? []) as ProjectConfig[];
    const databaseProject = projects.find((project) => project.test?.name === "database");

    expect(databaseProject?.test?.testTimeout).toBe(30_000);
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
});
