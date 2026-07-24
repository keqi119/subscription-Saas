import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  DownloadObjectResult,
  StorageProvider,
  StoredObject,
  UploadFileObjectInput,
  UploadObjectInput
} from "./storage.types";

@Injectable()
export class LocalStorageProvider implements StorageProvider {
  constructor(private readonly configService: ConfigService) {}

  async putObject(input: UploadObjectInput): Promise<StoredObject> {
    const absolutePath = this.resolvePath(input.key);

    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, input.buffer);

    return {
      contentType: input.contentType,
      driver: "local",
      key: input.key,
      originalName: input.originalName,
      size: input.buffer.length
    };
  }

  async putFile(input: UploadFileObjectInput): Promise<StoredObject> {
    const absolutePath = this.resolvePath(input.key);

    await mkdir(path.dirname(absolutePath), { recursive: true });
    await copyFile(input.filePath, absolutePath);

    return {
      contentType: input.contentType,
      driver: "local",
      key: input.key,
      originalName: input.originalName,
      size: input.sizeBytes
    };
  }

  async getObject(key: string): Promise<DownloadObjectResult> {
    const absolutePath = this.resolvePath(key);

    try {
      const fileStat = await stat(absolutePath);
      return {
        contentLength: fileStat.size,
        stream: createReadStream(absolutePath)
      };
    } catch {
      throw new NotFoundException("文件不存在或已不可访问。");
    }
  }

  async deleteObject(key: string): Promise<void> {
    const absolutePath = this.resolvePath(key);

    try {
      await unlink(absolutePath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolvePath(key));
      return true;
    } catch {
      return false;
    }
  }

  private resolvePath(key: string) {
    if (!key || key.includes("\0")) {
      throw new BadRequestException("文件路径无效。");
    }

    const baseDir = this.getBaseDir();
    const absolutePath = path.resolve(baseDir, key);

    if (absolutePath !== baseDir && !absolutePath.startsWith(`${baseDir}${path.sep}`)) {
      throw new BadRequestException("文件路径无效。");
    }

    return absolutePath;
  }

  private getBaseDir() {
    return path.resolve(
      process.cwd(),
      this.configService.get<string>("UPLOAD_LOCAL_DIR") ??
        this.configService.get<string>("LOCAL_FILE_STORAGE_DIR") ??
        "./uploads"
    );
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
