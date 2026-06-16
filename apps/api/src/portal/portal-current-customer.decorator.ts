import { createParamDecorator, ExecutionContext } from "@nestjs/common";

import { CurrentCustomer, PortalAuthenticatedRequest } from "./portal-auth.types";

export const CurrentPortalCustomer = createParamDecorator(
  (_data: unknown, context: ExecutionContext): CurrentCustomer => {
    const request = context.switchToHttp().getRequest<PortalAuthenticatedRequest>();
    return request.currentCustomer;
  }
);
