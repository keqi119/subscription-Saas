import { createParamDecorator, ExecutionContext } from "@nestjs/common";

import { CurrentFieldOperator } from "./field-operator-auth.types";

export const CurrentFieldOperatorSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): CurrentFieldOperator => {
    return context.switchToHttp().getRequest<{ currentFieldOperator: CurrentFieldOperator }>().currentFieldOperator;
  }
);
