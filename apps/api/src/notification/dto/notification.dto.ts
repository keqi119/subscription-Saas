import { NotificationChannel, NotificationEventStatus, NotificationStatus, NotificationType } from "@prisma/client";
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from "class-validator";
import { Type } from "class-transformer";

export class NotificationPageQueryDto {
  @IsInt()
  @IsOptional()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @IsInt()
  @IsOptional()
  @Max(100)
  @Min(1)
  @Type(() => Number)
  pageSize?: number;
}

export class AdminNotificationRecordsQueryDto extends NotificationPageQueryDto {
  @IsEnum(NotificationChannel)
  @IsOptional()
  channel?: NotificationChannel;

  @IsEnum(NotificationStatus)
  @IsOptional()
  notificationStatus?: NotificationStatus;

  @IsEnum(NotificationType)
  @IsOptional()
  notificationType?: NotificationType;

  @IsUUID("4")
  @IsOptional()
  customerId?: string;
}

export class AdminNotificationEventsQueryDto extends NotificationPageQueryDto {
  @IsEnum(NotificationEventStatus)
  @IsOptional()
  eventStatus?: NotificationEventStatus;

  @IsUUID("4")
  @IsOptional()
  customerId?: string;
}

export class PortalNotificationsQueryDto extends NotificationPageQueryDto {
  @IsEnum(NotificationStatus)
  @IsOptional()
  notificationStatus?: NotificationStatus;
}
