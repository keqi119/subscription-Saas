import { Module } from "@nestjs/common";

import { LocalStorageProvider } from "./local-storage.provider";
import {
  defaultOssClientFactory,
  OSS_CLIENT_FACTORY,
  OssStorageProvider
} from "./oss-storage.provider";
import { StorageService } from "./storage.service";

@Module({
  exports: [StorageService],
  providers: [
    LocalStorageProvider,
    OssStorageProvider,
    StorageService,
    {
      provide: OSS_CLIENT_FACTORY,
      useValue: defaultOssClientFactory
    }
  ]
})
export class StorageModule {}
