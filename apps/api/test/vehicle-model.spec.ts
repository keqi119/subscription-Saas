import "reflect-metadata";

import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it } from "vitest";

import { CreateVehicleDto, UpdateVehicleDto } from "../src/vehicle/dto/vehicle.dto";

const compatibilityModelCodes = ["ET5T", "EC6", "ES8", "ET9", "ES9", "MODEL_X_2027"] as const;

describe("vehicle model string compatibility", () => {
  it("accepts compatible and future model codes in create and update DTOs", async () => {
    for (const vehicleModel of compatibilityModelCodes) {
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
