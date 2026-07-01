import { CollectionPriorityLevel, type RiskExposure } from "./risk.types";

export class CollectionPriorityModel {
  assign(input: { exposure: RiskExposure; exposureScore: number; riskScore: number }): CollectionPriorityLevel {
    if (input.exposure.maxOverdueDays >= 30 || input.exposureScore >= 85 || input.riskScore >= 85) {
      return CollectionPriorityLevel.D5;
    }

    if (input.exposure.maxOverdueDays >= 15 || input.exposureScore >= 70 || input.riskScore >= 75) {
      return CollectionPriorityLevel.D4;
    }

    if (input.exposure.maxOverdueDays > 0 || input.exposureScore >= 50 || input.riskScore >= 60) {
      return CollectionPriorityLevel.D3;
    }

    if (input.exposureScore >= 25 || input.riskScore >= 40) {
      return CollectionPriorityLevel.D2;
    }

    return CollectionPriorityLevel.D1;
  }
}
