import type { MulterOptions } from "@nestjs/platform-express/multer/interfaces/multer-options.interface";

import { normalizeUploadFilename } from "./upload-filename";

export function createUtf8MultipartOptions(options: MulterOptions = {}): MulterOptions {
  const existingFileFilter = options.fileFilter;

  return {
    ...options,
    defParamCharset: "utf8",
    fileFilter(request, file, callback) {
      file.originalname = normalizeUploadFilename(file.originalname);

      if (existingFileFilter) {
        existingFileFilter(request, file, callback);
        return;
      }

      callback(null, true);
    }
  };
}
