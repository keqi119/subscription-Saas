export enum RoleCode {
  SA = "SA",
  OP = "OP",
  RC = "RC",
  FI = "FI",
  AS = "AS",
  CS = "CS",
  GM = "GM",
  ADMIN = "ADMIN"
}

export const ROLE_LABELS: Record<RoleCode, string> = {
  [RoleCode.SA]: "销售顾问",
  [RoleCode.OP]: "运营管理",
  [RoleCode.RC]: "风控专员",
  [RoleCode.FI]: "财务专员",
  [RoleCode.AS]: "资产运营",
  [RoleCode.CS]: "客服运营",
  [RoleCode.GM]: "总经理/运营总监",
  [RoleCode.ADMIN]: "系统管理员"
};
