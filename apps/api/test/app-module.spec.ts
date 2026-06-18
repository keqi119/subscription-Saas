import { Test, TestingModule } from "@nestjs/testing";
import { afterAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module";

describe("AppModule", () => {
  let moduleRef: TestingModule | undefined;

  afterAll(async () => {
    await moduleRef?.close();
  });

  it("compiles the production module graph", async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule]
    }).compile();

    expect(moduleRef).toBeDefined();
  });
});
