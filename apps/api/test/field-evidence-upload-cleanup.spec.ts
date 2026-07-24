import { BadRequestException } from "@nestjs/common";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { lastValueFrom, of, throwError } from "rxjs";
import { describe, expect, it } from "vitest";

import { FieldEvidenceTempFileCleanupInterceptor } from "../src/field-operator/field-evidence-temp-file-cleanup.interceptor";

describe("FieldEvidenceTempFileCleanupInterceptor", () => {
  it("removes disk-backed uploads after a successful request", async () => {
    const filePath = await createTempUpload();
    const interceptor = new FieldEvidenceTempFileCleanupInterceptor();

    await expect(
      lastValueFrom(interceptor.intercept(contextWithFile(filePath), { handle: () => of({ ok: true }) }))
    ).resolves.toEqual({ ok: true });
    await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes disk-backed uploads when validation or the handler rejects", async () => {
    const filePath = await createTempUpload();
    const interceptor = new FieldEvidenceTempFileCleanupInterceptor();

    await expect(
      lastValueFrom(
        interceptor.intercept(contextWithFile(filePath), {
          handle: () => throwError(() => new BadRequestException("invalid upload metadata"))
        })
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createTempUpload() {
  const directory = await mkdtemp(path.join(tmpdir(), "field-evidence-cleanup-"));
  const filePath = path.join(directory, "upload.tmp");
  await writeFile(filePath, "test");
  return filePath;
}

function contextWithFile(filePath: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        files: [{ path: filePath }]
      })
    })
  } as never;
}
