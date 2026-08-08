import {
  BadRequestException,
  Controller,
  INestApplication,
  Post,
  UploadedFiles,
  UseInterceptors
} from "@nestjs/common";
import { AnyFilesInterceptor } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { mkdir, rm } from "node:fs/promises";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FIELD_EVIDENCE_REPLACEMENT_FIELD_SIZE_BYTES,
  createFieldEvidenceUploadOptions
} from "../src/field-operator/field-evidence-upload-options";

const TEST_PRODUCT_LIMIT_BYTES = 8;
const TEST_UPLOAD_DIRECTORY = path.join(
  tmpdir(),
  "subscription-saas-field-evidence-multipart-test"
);
const TEST_UPLOAD_OPTIONS = createFieldEvidenceUploadOptions({
  destination: TEST_UPLOAD_DIRECTORY,
  productMaxSizeBytes: TEST_PRODUCT_LIMIT_BYTES
});
const TEST_PARTS_UPLOAD_OPTIONS = {
  ...TEST_UPLOAD_OPTIONS,
  limits: {
    ...TEST_UPLOAD_OPTIONS.limits,
    fields: 10,
    files: 10
  }
};

@Controller()
class MultipartBoundaryController {
  @Post("upload")
  @UseInterceptors(AnyFilesInterceptor(TEST_UPLOAD_OPTIONS))
  upload(
    @UploadedFiles() files: Array<{ originalname: string; path: string; size: number }> | undefined
  ) {
    const file = files?.[0];
    if (!file) {
      throw new BadRequestException("Expected one upload file.");
    }
    if (file.size > TEST_PRODUCT_LIMIT_BYTES) {
      throw new BadRequestException("Test product file limit exceeded.");
    }
    return { name: file.originalname, size: file.size };
  }

  @Post("parts")
  @UseInterceptors(AnyFilesInterceptor(TEST_PARTS_UPLOAD_OPTIONS))
  parts(@UploadedFiles() files: Array<{ size: number }> | undefined) {
    return { fileCount: files?.length ?? 0 };
  }
}

describe("field evidence multipart boundary", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    await mkdir(TEST_UPLOAD_DIRECTORY, { recursive: true });
    const moduleRef = await Test.createTestingModule({
      controllers: [MultipartBoundaryController]
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
    await rm(TEST_UPLOAD_DIRECTORY, { force: true, recursive: true });
  });

  it("accepts an exact product-limit file through Multer and Busboy", async () => {
    const response = await postMultipart(fileForm(TEST_PRODUCT_LIMIT_BYTES));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      name: "evidence.bin",
      size: TEST_PRODUCT_LIMIT_BYTES
    });
  });

  it("decodes an UTF-8 Chinese upload filename without mojibake", async () => {
    const form = new FormData();
    form.append("files", new Blob([Buffer.alloc(1)]), "车辆行驶证.pdf");

    const response = await postMultipart(form);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      name: "车辆行驶证.pdf"
    });
  });

  it("rejects product-limit plus one at the parser truncation threshold", async () => {
    const response = await postMultipart(fileForm(TEST_PRODUCT_LIMIT_BYTES + 1));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.not.toMatchObject({
      message: "Test product file limit exceeded."
    });
  });

  it("accepts one optional replacement field and one file", async () => {
    const form = fileForm(1);
    form.append("replaceEvidenceFileId", "123e4567-e89b-12d3-a456-426614174000");

    const response = await postMultipart(form);

    expect(response.status).toBe(201);
  });

  it("rejects oversized replacement fields at the multipart boundary", async () => {
    const form = fileForm(1);
    form.append(
      "replaceEvidenceFileId",
      "x".repeat(FIELD_EVIDENCE_REPLACEMENT_FIELD_SIZE_BYTES + 1)
    );

    const response = await postMultipart(form);

    expect(response.status).toBe(400);
  });

  it("rejects extra fields and extra file parts", async () => {
    const fieldFlood = fileForm(1);
    fieldFlood.append("replaceEvidenceFileId", "123e4567-e89b-12d3-a456-426614174000");
    fieldFlood.append("unexpected", "flood");
    const fieldFloodResponse = await postMultipart(fieldFlood);

    const fileFlood = fileForm(1);
    fileFlood.append("files", new Blob(["b"]), "second.bin");
    const fileFloodResponse = await postMultipart(fileFlood);

    expect(fieldFloodResponse.status).toBe(400);
    expect(fileFloodResponse.status).toBe(400);
  });

  it("allows two configured parts and rejects the third part", async () => {
    const allowed = fileForm(1);
    allowed.append("replaceEvidenceFileId", "123e4567-e89b-12d3-a456-426614174000");
    const allowedResponse = await postMultipart(allowed, "parts");

    const partFlood = fileForm(1);
    partFlood.append("replaceEvidenceFileId", "123e4567-e89b-12d3-a456-426614174000");
    partFlood.append("unexpected", "third-part");
    const partFloodResponse = await postMultipart(partFlood, "parts");

    expect(allowedResponse.status).toBe(201);
    expect(partFloodResponse.status).toBe(400);
  });

  function postMultipart(form: FormData, route = "upload") {
    return fetch(`${baseUrl}/${route}`, {
      body: form,
      method: "POST"
    });
  }
});

function fileForm(size: number) {
  const form = new FormData();
  form.append("files", new Blob(["x".repeat(size)]), "evidence.bin");
  return form;
}
