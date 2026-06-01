import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";

import { AuthService } from "./auth.service";
import { RequestUser } from "./auth.types";

export interface AuthenticatedRequest extends Request {
  user: RequestUser;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: RequestUser }>();
    const token = extractToken(request);

    if (!token) {
      throw new UnauthorizedException("Missing access token.");
    }

    request.user = await this.authService.validateToken(token);
    return true;
  }
}

function extractToken(request: Request): string | undefined {
  const cookieToken = request.cookies?.["access_token"] as string | undefined;

  if (cookieToken) {
    return cookieToken;
  }

  const authorization = request.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    return undefined;
  }

  return authorization.slice("Bearer ".length);
}
