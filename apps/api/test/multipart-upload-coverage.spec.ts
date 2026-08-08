import type { Request } from "express";
import type { MulterOptions } from "@nestjs/platform-express/multer/interfaces/multer-options.interface";
import { describe, expect, it, vi } from "vitest";

import { createUtf8MultipartOptions } from "../src/upload/multipart-upload-options";

type MultipartFile = Parameters<NonNullable<MulterOptions["fileFilter"]>>[1];

describe("createUtf8MultipartOptions", () => {
  it("preserves limits while forcing UTF-8 multipart parameter decoding", () => {
    const options = createUtf8MultipartOptions({
      limits: { fileSize: 20 * 1024 * 1024 }
    });

    expect(options.defParamCharset).toBe("utf8");
    expect(options.limits).toEqual({ fileSize: 20 * 1024 * 1024 });
  });

  it("normalizes the filename before invoking an existing file filter", () => {
    const existingFilter = vi.fn(
      (
        _request: Request,
        _file: MultipartFile,
        callback: (error: Error | null, acceptFile: boolean) => void
      ) => callback(null, true)
    );
    const options = createUtf8MultipartOptions({ fileFilter: existingFilter });
    const callback = vi.fn();
    const file = {
      originalname: "C:\\fakepath\\车辆行驶证.pdf\u0000"
    } as MultipartFile;

    options.fileFilter?.({} as Request, file, callback);

    expect(file.originalname).toBe("车辆行驶证.pdf");
    expect(existingFilter).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(null, true);
  });
});
