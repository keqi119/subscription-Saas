import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { AuthenticatedRequest } from "./auth.guard";
import { REQUIRED_ANY_PERMISSIONS_KEY, REQUIRED_PERMISSIONS_KEY } from "./auth.decorators";
import { hasAnyRequiredPermission, hasRequiredPermissions } from "./permissions";

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions =
      this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass()
      ]) ?? [];
    const anyRequiredPermissions =
      this.reflector.getAllAndOverride<string[]>(REQUIRED_ANY_PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass()
      ]) ?? [];

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (
      !hasRequiredPermissions(request.user.permissions, requiredPermissions) ||
      !hasAnyRequiredPermission(request.user.permissions, anyRequiredPermissions)
    ) {
      throw new ForbiddenException("Permission denied.");
    }

    return true;
  }
}
