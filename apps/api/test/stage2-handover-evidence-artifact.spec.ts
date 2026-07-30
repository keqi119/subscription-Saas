import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";

import {
  calculateDeliveryEvidenceSourceSha256,
  DeliveryHandoverEvidenceArtifactService,
  framePercentagesForEvidence,
  isDeliveryEvidenceArtifactProcessingError
} from "../src/delivery-handover/delivery-handover-evidence-artifact.service";

describe("Stage 2 handover evidence artifact preparation", () => {
  it("streams the original bytes into the persisted SHA-256 format", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "stage2-artifact-hash-"));
    const sourcePath = path.join(directory, "source.bin");
    await writeFile(sourcePath, "abc");

    try {
      await expect(calculateDeliveryEvidenceSourceSha256(sourcePath))
        .resolves.toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("uses four ordered positions for walkaround video and two for other videos", () => {
    expect(framePercentagesForEvidence("WALKAROUND_VIDEO")).toEqual([0.1, 0.35, 0.6, 0.85]);
    expect(framePercentagesForEvidence("WHEEL_CLOSEUP_FRONT_LEFT")).toEqual([0.25, 0.75]);
  });

  it("creates a bounded photo preview without shell command construction", async () => {
    const runner = vi.fn(async (command: string, args: string[]) => {
      expect(command).toContain("ffmpeg");
      expect(args).toContain("-nostdin");
      expect(args).toContain("-frames:v");
      await writeFakeJpeg(args.at(-1)!);
      return { stderr: "", stdout: "" };
    });
    const service = new DeliveryHandoverEvidenceArtifactService(undefined, runner);

    const prepared = await service.prepareUpload({
      evidenceType: "VEHICLE_FRONT",
      file: {
        buffer: sourceJpeg(),
        mimetype: "image/png",
        originalname: "front.jpg",
        size: 12
      },
      mediaType: "PHOTO"
    });

    try {
      expect(prepared.metadata).toMatchObject({
        artifactVersion: 1,
        detectedMimeType: "image/jpeg",
        processingStatus: "READY",
        sourceSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        sourceSizeBytes: 12,
        videoDurationMs: null
      });
      expect(prepared.derivatives).toHaveLength(1);
      expect(await readFile(prepared.derivatives[0]!.filePath)).toEqual(fakeJpeg());
    } finally {
      await prepared.cleanup();
    }
  });

  it("detects HEIC from source bytes instead of trusting the declared photo MIME", async () => {
    const runner = vi.fn(async (_command: string, args: string[]) => {
      await writeFakeJpeg(args.at(-1)!);
      return { stderr: "", stdout: "" };
    });
    const service = new DeliveryHandoverEvidenceArtifactService(undefined, runner);

    const prepared = await service.prepareUpload({
      evidenceType: "VEHICLE_FRONT",
      file: {
        buffer: sourceHeic(),
        mimetype: "image/jpeg",
        originalname: "front.heic",
        size: 32
      },
      mediaType: "PHOTO"
    });

    try {
      expect(prepared.metadata.detectedMimeType).toBe("image/heic");
    } finally {
      await prepared.cleanup();
    }
  });

  it("probes video duration and creates four distinct walkaround keyframes", async () => {
    let frameIndex = 0;
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command.includes("ffprobe")) {
        return {
          stderr: "",
          stdout: JSON.stringify({
            format: { duration: "20.5", format_name: "mov,mp4" },
            streams: [{ codec_name: "h264", codec_type: "video" }]
          })
        };
      }
      frameIndex += 1;
      await writeFakeJpeg(args.at(-1)!, frameIndex);
      return { stderr: "", stdout: "" };
    });
    const service = new DeliveryHandoverEvidenceArtifactService(undefined, runner);

    const prepared = await service.prepareUpload({
      evidenceType: "WALKAROUND_VIDEO",
      file: {
        buffer: Buffer.from("source-video"),
        mimetype: "video/quicktime",
        originalname: "walkaround.mov",
        size: 12
      },
      mediaType: "VIDEO"
    });

    try {
      expect(prepared.metadata).toMatchObject({
        detectedCodec: "h264",
        detectedMimeType: "video/quicktime",
        videoDurationMs: 20_500
      });
      expect(prepared.derivatives).toHaveLength(4);
      expect(new Set(prepared.derivatives.map((item) => item.originalName)).size).toBe(4);
      expect(runner).toHaveBeenCalledTimes(5);
      expect(runner.mock.calls.slice(1).map(([, args]) => args[args.indexOf("-ss") + 1])).toEqual([
        "2.050",
        "7.175",
        "12.300",
        "17.425"
      ]);
    } finally {
      await prepared.cleanup();
    }
  });

  it("fails closed and removes its temporary directory when ffmpeg produces no output", async () => {
    let outputPath = "";
    const runner = vi.fn(async (_command: string, args: string[]) => {
      outputPath = args.at(-1)!;
      return { stderr: "", stdout: "" };
    });
    const service = new DeliveryHandoverEvidenceArtifactService(undefined, runner);

    await expect(service.prepareUpload({
      evidenceType: "VEHICLE_FRONT",
      file: {
        buffer: sourceJpeg(),
        mimetype: "image/jpeg",
        originalname: "front.jpg",
        size: 12
      },
      mediaType: "PHOTO"
    })).rejects.toThrow("STAGE2_EVIDENCE_ARTIFACT_PROCESSING_FAILED");

    expect(outputPath).not.toBe("");
    expect(existsSync(path.dirname(outputPath))).toBe(false);
  });

  it("classifies normalized media processing errors without exposing internals", async () => {
    const service = new DeliveryHandoverEvidenceArtifactService(undefined, async () => {
      throw new Error("spawn ffmpeg ENOENT");
    });
    const error = await service.prepareUpload(photoInput()).catch((value) => value);

    expect(isDeliveryEvidenceArtifactProcessingError(error)).toBe(true);
  });

  it("bounds cross-request media processing concurrency and queue depth", async () => {
    const releases: Array<() => void> = [];
    const runner = vi.fn(async (_command: string, args: string[]) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      await writeFakeJpeg(args.at(-1)!);
      return { stderr: "", stdout: "" };
    });
    const service = new DeliveryHandoverEvidenceArtifactService(new ConfigService({
      STAGE2_MEDIA_PROCESS_CONCURRENCY: "1",
      STAGE2_MEDIA_PROCESS_QUEUE_LIMIT: "1"
    }), runner);
    const input = {
      evidenceType: "VEHICLE_FRONT",
      file: {
        buffer: sourceJpeg(),
        mimetype: "image/jpeg",
        originalname: "front.jpg",
        size: 12
      },
      mediaType: "PHOTO" as const
    };

    const first = service.prepareUpload(input);
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    const second = service.prepareUpload(input);
    await expect(service.prepareUpload(input)).rejects.toThrow("media processing queue is full");

    releases.shift()?.();
    const firstPrepared = await first;
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    const secondPrepared = await second;
    await Promise.all([firstPrepared.cleanup(), secondPrepared.cleanup()]);
  });
});

function fakeJpeg(marker = 1) {
  return Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, marker, 0xff, 0xd9]);
}

function sourceJpeg() {
  return Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 1, 2, 3, 4, 5, 0xff, 0xd9]);
}

function sourceHeic() {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(32, 0);
  bytes.write("ftyp", 4, "ascii");
  bytes.write("heic", 8, "ascii");
  bytes.write("mif1", 16, "ascii");
  return bytes;
}

function photoInput() {
  return {
    evidenceType: "VEHICLE_FRONT",
    file: {
      buffer: sourceJpeg(),
      mimetype: "image/jpeg",
      originalname: "front.jpg",
      size: 12
    },
    mediaType: "PHOTO" as const
  };
}

async function writeFakeJpeg(filePath: string, marker = 1) {
  await writeFile(filePath, fakeJpeg(marker));
}
