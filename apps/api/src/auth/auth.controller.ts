import { Body, Controller, Get, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";

import { AuthGuard, AuthenticatedRequest } from "./auth.guard";
import { AuthService } from "./auth.service";
import { LoginDto } from "./dto/login.dto";

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("login")
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    const result = await this.authService.login(dto, {
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });

    response.cookie("access_token", result.token, {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production"
    });

    return {
      menus: result.menus,
      user: result.user
    };
  }

  @Post("logout")
  @UseGuards(AuthGuard)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response
  ) {
    response.clearCookie("access_token");
    await this.authService.logout(request.user.id, {
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });
    return { success: true };
  }

  @Get("me")
  @UseGuards(AuthGuard)
  getMe(@Req() request: AuthenticatedRequest) {
    return {
      menus: request.user.menus,
      user: {
        id: request.user.id,
        name: request.user.name,
        permissions: request.user.permissions,
        roles: request.user.roles,
        username: request.user.username
      }
    };
  }
}
