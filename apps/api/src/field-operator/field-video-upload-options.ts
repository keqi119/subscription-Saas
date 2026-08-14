import { tmpdir } from "node:os";
import path from "node:path";

import { createUtf8MultipartOptions } from "../upload/multipart-upload-options";
import { FIELD_VIDEO_CHUNK_SIZE_BYTES } from "./field-video-upload.constants";

interface FieldVideoPartUploadOptionsInput {
  destination?: string;
  partSizeBytes?: number;
}

export function createFieldVideoPartUploadOptions(input: FieldVideoPartUploadOptionsInput = {}) {
  const partSizeBytes = input.partSizeBytes ?? FIELD_VIDEO_CHUNK_SIZE_BYTES;

  return createUtf8MultipartOptions({
    dest: input.destination ?? path.join(tmpdir(), "subscription-saas-field-video-parts"),
    limits: {
      fields: 0,
      files: 1,
      fileSize: partSizeBytes + 1,
      parts: 2
    }
  });
}
