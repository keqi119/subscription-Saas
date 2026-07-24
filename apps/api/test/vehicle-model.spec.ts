import "reflect-metadata";

import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it } from "vitest";

import { PortalVehicleCatalogQueryDto } from "../src/portal/portal-catalog.dto";
import { OrderReportQueryDto, VehicleDetailQueryDto } from "../src/report/dto/report.dto";
import { CreateVehicleDto, UpdateVehicleDto } from "../src/vehicle/dto/vehicle.dto";
import { VehicleModelDefinitionsQueryDto } from "../src/vehicle-model-definition/dto/vehicle-model-definition.dto";

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

  it("accepts only 64-character canonical model codes in compatibility filters", async () => {
    const acceptedCode = "MODEL_".padEnd(64, "X");
    const invalidCodes = ["nio_et5", "X".repeat(65)];
    const queryTypes = [
      { QueryDto: VehicleModelDefinitionsQueryDto, property: "legacyVehicleModel" },
      { QueryDto: PortalVehicleCatalogQueryDto, property: "vehicleModel" },
      { QueryDto: OrderReportQueryDto, property: "vehicleModel" },
      { QueryDto: VehicleDetailQueryDto, property: "vehicleModel" }
    ];

    for (const { QueryDto, property } of queryTypes) {
      const acceptedErrors = await validate(plainToInstance(QueryDto, { [property]: acceptedCode }));
      expect(acceptedErrors.find((error) => error.property === property)).toBeUndefined();

      for (const vehicleModel of invalidCodes) {
        const errors = await validate(plainToInstance(QueryDto, { [property]: vehicleModel }));
        expect(errors.find((error) => error.property === property)).toBeDefined();
      }
    }
  });
});
