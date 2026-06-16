import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";

import { PortalAuthService } from "./portal-auth.service";
import { CurrentCustomer } from "./portal-auth.types";

export interface RequestWithPortalCustomer extends Request {
  currentCustomer?: CurrentCustomer;
}

@Injectable()
export class CustomerAuthGuard implements CanActivate {
  constructor(private readonly portalAuthService: PortalAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithPortalCustomer>();
    const token = extractCustomerToken(request, this.portalAuthService.getCookieName());

    if (!token) {
      throw new UnauthorizedException("未登录客户，请先登录。");
    }

    request.currentCustomer = await this.portalAuthService.validateToken(token);
    return true;
  }
}

function extractCustomerToken(request: Request, cookieName: string) {
  const cookieToken = request.cookies?.[cookieName] as string | undefined;

  if (cookieToken) {
    return cookieToken;
  }

  const authorization = request.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    return undefined;
  }

  return authorization.slice("Bearer ".length);
}
