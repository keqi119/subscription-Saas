import { VehicleHandoverOperatorType } from "@prisma/client";

export interface FieldOperatorRequestContext {
  ipAddress?: string;
  userAgent?: string | string[];
}

export interface CurrentFieldOperator {
  operatorType: VehicleHandoverOperatorType | null;
  phone: string;
  sessionId: string;
}
