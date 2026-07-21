import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";

import { FieldOperatorAuthService } from "./field-operator-auth.service";
import { CurrentFieldOperator } from "./field-operator-auth.types";

export interface FieldOperatorAuthenticatedRequest extends Request {
  currentFieldOperator?: CurrentFieldOperator;
}

@Injectable()
export class FieldOperatorAuthGuard implements CanActivate {
  constructor(private readonly fieldOperatorAuthService: FieldOperatorAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FieldOperatorAuthenticatedRequest>();
    const token = extractFieldToken(request, this.fieldOperatorAuthService.getCookieName());

    if (!token) {
      throw new UnauthorizedException("Missing field operator session.");
    }

    request.currentFieldOperator = await this.fieldOperatorAuthService.validateToken(token);
    return true;
  }
}

function extractFieldToken(request: Request, cookieName: string) {
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
