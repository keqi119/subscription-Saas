import { Body, Controller, Get, Param, Patch, Post, Put, Req, UseGuards } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { RequirePermissions } from "../auth/auth.decorators";
import { PermissionsGuard } from "../auth/permissions.guard";
import { AssignIdsDto } from "./dto/assign-ids.dto";
import { CreateRoleDto } from "./dto/create-role.dto";
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateRoleDto } from "./dto/update-role.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { SystemService } from "./system.service";

@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class SystemController {
  constructor(private readonly systemService: SystemService) {}

  @Get("users")
  @RequirePermissions(PermissionCode.USER_VIEW)
  listUsers() {
    return this.systemService.listUsers();
  }

  @Post("users")
  @RequirePermissions(PermissionCode.USER_MANAGE)
  createUser(@Body() dto: CreateUserDto, @Req() request: AuthenticatedRequest) {
    return this.systemService.createUser(dto, request.user.id, requestContext(request));
  }

  @Patch("users/:id")
  @RequirePermissions(PermissionCode.USER_MANAGE)
  updateUser(
    @Param("id") id: string,
    @Body() dto: UpdateUserDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.systemService.updateUser(id, dto, request.user.id, requestContext(request));
  }

  @Get("roles")
  @RequirePermissions(PermissionCode.ROLE_VIEW)
  listRoles() {
    return this.systemService.listRoles();
  }

  @Post("roles")
  @RequirePermissions(PermissionCode.ROLE_MANAGE)
  createRole(@Body() dto: CreateRoleDto, @Req() request: AuthenticatedRequest) {
    return this.systemService.createRole(dto, request.user.id, requestContext(request));
  }

  @Patch("roles/:id")
  @RequirePermissions(PermissionCode.ROLE_MANAGE)
  updateRole(
    @Param("id") id: string,
    @Body() dto: UpdateRoleDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.systemService.updateRole(id, dto, request.user.id, requestContext(request));
  }

  @Put("roles/:id/permissions")
  @RequirePermissions(PermissionCode.ROLE_MANAGE)
  assignRolePermissions(
    @Param("id") id: string,
    @Body() dto: AssignIdsDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.systemService.assignRolePermissions(id, dto.ids, request.user.id, requestContext(request));
  }

  @Put("roles/:id/menus")
  @RequirePermissions(PermissionCode.ROLE_MANAGE)
  assignRoleMenus(
    @Param("id") id: string,
    @Body() dto: AssignIdsDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.systemService.assignRoleMenus(id, dto.ids, request.user.id, requestContext(request));
  }

  @Get("permissions")
  @RequirePermissions(PermissionCode.PERMISSION_VIEW)
  listPermissions() {
    return this.systemService.listPermissions();
  }

  @Get("menus")
  @RequirePermissions(PermissionCode.MENU_VIEW)
  listMenus() {
    return this.systemService.listMenus();
  }

  @Get("audit-logs")
  @RequirePermissions(PermissionCode.AUDIT_LOG_VIEW)
  listAuditLogs() {
    return this.systemService.listAuditLogs();
  }
}

function requestContext(request: AuthenticatedRequest) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}
