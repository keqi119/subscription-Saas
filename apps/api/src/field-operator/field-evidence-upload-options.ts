import { tmpdir } from "node:os";
import path from "node:path";

import { MAX_FIELD_EVIDENCE_UPLOAD_SIZE_BYTES } from "../handover-work-order/handover-work-order.constants";
import { createUtf8MultipartOptions } from "../upload/multipart-upload-options";

export const FIELD_EVIDENCE_REPLACEMENT_FIELD_SIZE_BYTES = 128;

interface FieldEvidenceUploadOptionsInput {
  destination?: string;
  productMaxSizeBytes?: number;
}

export function createFieldEvidenceUploadOptions(input: FieldEvidenceUploadOptionsInput = {}) {
  const productMaxSizeBytes = input.productMaxSizeBytes ?? MAX_FIELD_EVIDENCE_UPLOAD_SIZE_BYTES;

  return createUtf8MultipartOptions({
    dest: input.destination ?? path.join(tmpdir(), "subscription-saas-field-evidence"),
    limits: {
      fields: 1,
      fieldSize: FIELD_EVIDENCE_REPLACEMENT_FIELD_SIZE_BYTES,
      files: 1,
      fileSize: productMaxSizeBytes + 1,
      parts: 3
    }
  });
}
