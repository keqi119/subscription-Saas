import type { AuthenticatedUser, MenuItemDefinition } from "@subscription-saas/shared";

export interface AuthMeResponse {
  menus: MenuItemDefinition[];
  user: AuthenticatedUser;
}
