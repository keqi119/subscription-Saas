export function hasRequiredPermissions(userPermissions: string[], requiredPermissions: string[]) {
  if (requiredPermissions.length === 0) {
    return true;
  }

  const permissionSet = new Set(userPermissions);
  return requiredPermissions.every((permission) => permissionSet.has(permission));
}
