import { NotificationChannel, NotificationEventStatus, NotificationStatus, NotificationType } from "@prisma/client";
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from "class-validator";
import { Transform, Type } from "class-transformer";

export enum NotificationProcessingResolution {
  CONFIRMED_NOT_SENT = "CONFIRMED_NOT_SENT",
  CONFIRMED_SENT = "CONFIRMED_SENT"
}

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

export class ResolveProcessingNotificationDto {
  @MaxLength(500)
  @MinLength(2)
  @IsString()
  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  reason!: string;

  @IsEnum(NotificationProcessingResolution)
  resolution!: NotificationProcessingResolution;
}
