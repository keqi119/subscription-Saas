import "reflect-metadata";

import { VehicleModel } from "@prisma/client";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it } from "vitest";

import { CreateVehicleDto, UpdateVehicleDto } from "../src/vehicle/dto/vehicle.dto";

const addedVehicleModels = [
  VehicleModel.ET5T,
  VehicleModel.EC6,
  VehicleModel.ES8,
  VehicleModel.ET9,
  VehicleModel.ES9
] as const;

describe("VehicleModel enum drift closure", () => {
  it("exposes the manually added vehicle model codes from Prisma Client", () => {
    expect(Object.values(VehicleModel)).toEqual(expect.arrayContaining([...addedVehicleModels]));
  });

  it("accepts the added vehicle model codes in create and update DTOs", async () => {
    for (const vehicleModel of addedVehicleModels) {
      const createDto = plainToInstance(CreateVehicleDto, {
        brand: "NIO",
        purchasePriceAmount: 25000000,
        vehicleModel,
        vin: `TESTVIN${vehicleModel}0001`
      });
      const updateDto = plainToInstance(UpdateVehicleDto, { vehicleModel });

      const createErrors = await validate(createDto);
      const updateErrors = await validate(updateDto);

      expect(createErrors.find((error) => error.property === "vehicleModel")).toBeUndefined();
      expect(updateErrors.find((error) => error.property === "vehicleModel")).toBeUndefined();
    }
  });
});
