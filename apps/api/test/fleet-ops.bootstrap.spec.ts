import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module";
import { FleetOpsFacade } from "../src/fleet-ops/fleet-ops.facade";
import { FleetOpsHealthService } from "../src/fleet-ops/fleet-ops.health.service";
import { PrismaService } from "../src/prisma/prisma.service";

describe("Fleet Ops bootstrap readiness", () => {
  it("compiles AppModule with FleetOpsModule mounted without constructor-time Prisma access", async () => {
    const prismaProbe = createNoConstructorAccessPrismaProbe();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule]
    })
      .overrideProvider(PrismaService)
      .useValue(prismaProbe.client)
      .compile();

    expect(moduleRef.get(FleetOpsFacade)).toBeInstanceOf(FleetOpsFacade);
    expect(moduleRef.get(FleetOpsHealthService)).toBeInstanceOf(FleetOpsHealthService);
    expect(prismaProbe.accessedProperties).toEqual([]);

    await moduleRef.close();
  });
});

function createNoConstructorAccessPrismaProbe() {
  const accessedProperties: string[] = [];
  const client = new Proxy(
    {},
    {
      get(_target, property) {
        if (["beforeApplicationShutdown", "onApplicationShutdown", "onModuleDestroy", "onModuleInit", "then"].includes(String(property))) {
          return undefined;
        }

        accessedProperties.push(String(property));
        throw new Error(`PrismaService property ${String(property)} was accessed during bootstrap.`);
      }
    }
  );

  return { accessedProperties, client };
}
