import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import { unlink } from "node:fs/promises";
import { from, type Observable } from "rxjs";
import { concatMap, dematerialize, map, materialize } from "rxjs/operators";

interface DiskBackedUpload {
  path?: string;
}

export class FieldEvidenceTempFileCleanupInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context
      .switchToHttp()
      .getRequest<{ file?: DiskBackedUpload; files?: DiskBackedUpload[] }>();
    let cleanupPromise: Promise<void> | null = null;
    const cleanup = () => {
      cleanupPromise ??= cleanupTempFiles([
        ...(request.file ? [request.file] : []),
        ...(request.files ?? [])
      ]);
      return cleanupPromise;
    };

    return next.handle().pipe(
      materialize(),
      concatMap((notification) => from(cleanup()).pipe(map(() => notification))),
      dematerialize()
    );
  }
}

async function cleanupTempFiles(files: DiskBackedUpload[]) {
  await Promise.allSettled(
    files
      .map((file) => file.path)
      .filter((filePath): filePath is string => Boolean(filePath))
      .map((filePath) => unlink(filePath))
  );
}
