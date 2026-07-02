import { CollectionPriorityLevel, type RiskExposure } from "./risk.types";

export class CollectionPriorityModel {
  assign(input: { exposure: RiskExposure; exposureScore: number; riskScore: number }): CollectionPriorityLevel {
    return this.assignByOverdueDays(input.exposure.maxOverdueDays);
  }

  assignByOverdueDays(overdueDays: number): CollectionPriorityLevel {
    if (overdueDays <= 0) {
      return CollectionPriorityLevel.NONE;
    }

    if (overdueDays <= 3) {
      return CollectionPriorityLevel.D1;
    }

    if (overdueDays <= 7) {
      return CollectionPriorityLevel.D2;
    }

    if (overdueDays <= 15) {
      return CollectionPriorityLevel.D3;
    }

    if (overdueDays <= 30) {
      return CollectionPriorityLevel.D4;
    }

    return CollectionPriorityLevel.D5;
  }
}
