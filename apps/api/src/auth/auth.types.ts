import type { MenuItemDefinition } from "@subscription-saas/shared";

export interface RequestUser {
  id: string;
  menus: MenuItemDefinition[];
  name: string;
  permissions: string[];
  roles: string[];
  username: string;
}

export interface RequestContext {
  ipAddress?: string;
  userAgent?: string;
}

export interface AuthResult {
  menus: MenuItemDefinition[];
  token: string;
  user: Omit<RequestUser, "menus">;
}
