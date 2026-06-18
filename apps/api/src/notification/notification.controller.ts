import { Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import { CurrentPortalCustomer } from "../portal/portal-current-customer.decorator";
import { CustomerAuthGuard } from "../portal/portal-auth.guard";
import { CurrentCustomer } from "../portal/portal-auth.types";
import {
  AdminNotificationEventsQueryDto,
  AdminNotificationRecordsQueryDto,
  NotificationPageQueryDto,
  PortalNotificationsQueryDto
} from "./dto/notification.dto";
import { NotificationService } from "./notification.service";

@Controller("notifications")
@UseGuards(AuthGuard, PermissionsGuard)
export class NotificationAdminController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get("templates")
  @RequirePermissions(PermissionCode.NOTIFICATION_VIEW)
  listTemplates(@Query() query: NotificationPageQueryDto) {
    return this.notificationService.listTemplates(query);
  }

  @Get("records")
  @RequirePermissions(PermissionCode.NOTIFICATION_VIEW)
  listRecords(@Query() query: AdminNotificationRecordsQueryDto) {
    return this.notificationService.listRecords(query);
  }

  @Get("events")
  @RequirePermissions(PermissionCode.NOTIFICATION_VIEW)
  listEvents(@Query() query: AdminNotificationEventsQueryDto) {
    return this.notificationService.listEvents(query);
  }
}

@Controller("portal/notifications")
@UseGuards(CustomerAuthGuard)
export class PortalNotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get()
  listNotifications(
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Query() query: PortalNotificationsQueryDto
  ) {
    return this.notificationService.listPortalNotifications(currentCustomer, query);
  }

  @Get(":id")
  getNotification(
    @Param("id") id: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.notificationService.getPortalNotification(id, currentCustomer);
  }

  @Post("read-all")
  markAllRead(@CurrentPortalCustomer() currentCustomer: CurrentCustomer) {
    return this.notificationService.markAllPortalNotificationsRead(currentCustomer);
  }

  @Post(":id/read")
  markRead(
    @Param("id") id: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.notificationService.markPortalNotificationRead(id, currentCustomer);
  }
}
