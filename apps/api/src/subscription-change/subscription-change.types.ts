import { Prisma } from "@prisma/client";

export interface ContractSegmentTerms {
  segmentId: string;
  startDate: Date;
  endDate: Date;
  monthlyFeeAmount: bigint;
  mileageLimitKm: number;
  overMileageFeeAmount: bigint;
  planSnapshot: Prisma.JsonValue;
}
