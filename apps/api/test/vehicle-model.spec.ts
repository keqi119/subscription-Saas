import { ValidationPipe } from "@nestjs/common";
import "reflect-metadata";
import { describe, expect, it } from "vitest";

import {
  CreatePriceRuleDto,
  CreateQuoteDto,
  CreateVehiclePackageDto,
  UpdatePriceRuleDto,
  UpdateVehiclePackageDto
} from "../src/product/dto/product.dto";
import { CreateVehicleDto, UpdateVehicleDto } from "../src/vehicle/dto/vehicle.dto";

const MODEL_DEFINITION_ID = "260315b8-755b-4f85-b41d-71c0358dfb3b";

function validateProductionBody<T>(value: unknown, metatype: new () => T) {
  return new ValidationPipe({
    transform: true,
    whitelist: true
  }).transform(value, {
    metatype,
    type: "body"
  });
}

describe("canonical vehicle model write DTOs", () => {
  it.each([
    [
      CreateVehicleDto,
      {
        brand: "NIO",
        purchasePriceAmount: 25000000,
        vin: "TESTVIN00000000001"
      }
    ],
    [
      CreateVehiclePackageDto,
      {
        maxPeriodMonths: 36,
        minPeriodMonths: 12,
        packageName: "ET5 standard",
        productId: MODEL_DEFINITION_ID,
        productVersionId: MODEL_DEFINITION_ID
      }
    ],
    [
      CreatePriceRuleDto,
      {
        baseMileageKm: 1500,
        maxPeriodMonths: 36,
        minPeriodMonths: 12,
        overMileageFeeAmount: 100
      }
    ]
  ])("%s requires modelDefinitionId", async (Dto, payload) => {
    await expect(validateProductionBody(payload, Dto)).rejects.toThrow();
  });

  it.each([
    [
      CreateVehicleDto,
      {
        brand: "NIO",
        modelDefinitionId: MODEL_DEFINITION_ID,
        purchasePriceAmount: 25000000,
        vin: "TESTVIN00000000001"
      }
    ],
    [UpdateVehicleDto, { modelDefinitionId: MODEL_DEFINITION_ID }],
    [
      CreateVehiclePackageDto,
      {
        maxPeriodMonths: 36,
        minPeriodMonths: 12,
        modelDefinitionId: MODEL_DEFINITION_ID,
        packageName: "ET5 standard",
        productId: MODEL_DEFINITION_ID,
        productVersionId: MODEL_DEFINITION_ID
      }
    ],
    [UpdateVehiclePackageDto, { modelDefinitionId: MODEL_DEFINITION_ID }],
    [
      CreatePriceRuleDto,
      {
        baseMileageKm: 1500,
        maxPeriodMonths: 36,
        minPeriodMonths: 12,
        modelDefinitionId: MODEL_DEFINITION_ID,
        overMileageFeeAmount: 100
      }
    ],
    [UpdatePriceRuleDto, { modelDefinitionId: MODEL_DEFINITION_ID }],
    [
      CreateQuoteDto,
      {
        modelDefinitionId: MODEL_DEFINITION_ID,
        periodMonths: 12
      }
    ]
  ])("%s strips the retired vehicleModel input", async (Dto, payload) => {
    const dto = await validateProductionBody(
      { ...payload, vehicleModel: "ET5" },
      Dto
    );

    expect(dto).not.toHaveProperty("vehicleModel");
    expect(dto).toHaveProperty("modelDefinitionId", MODEL_DEFINITION_ID);
  });
});
