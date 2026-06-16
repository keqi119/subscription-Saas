import { Matches } from "class-validator";

export const PORTAL_PHONE_PATTERN = /^1[3-9]\d{9}$/;
export const PORTAL_CODE_PATTERN = /^\d{6}$/;

export class RequestPortalCodeDto {
  @Matches(PORTAL_PHONE_PATTERN, { message: "请输入正确的手机号。" })
  phone!: string;
}

export class PortalLoginDto {
  @Matches(PORTAL_PHONE_PATTERN, { message: "请输入正确的手机号。" })
  phone!: string;

  @Matches(PORTAL_CODE_PATTERN, { message: "请输入 6 位数字验证码。" })
  code!: string;
}
