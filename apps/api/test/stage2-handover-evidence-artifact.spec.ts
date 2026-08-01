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
    const { runner, service } = createVideoArtifactHarness();

    const prepared = await service.prepareUpload(walkaroundVideoInput());

    try {
      expect(prepared.metadata).toMatchObject({
        detectedCodec: "h264",
        detectedMimeType: "video/quicktime",
        videoBitRateBps: 8_000_000,
        videoDurationMs: 20_500,
        videoFrameRate: 29.97002997002997,
        videoHeightPx: 1080,
        videoQualityStatus: "PASSED",
        videoWidthPx: 1920
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

  it.each([
    { height: 720, width: 1280 },
    { height: 1280, width: 720 }
  ])("accepts a walkaround video at the 720p short-edge boundary: $width x $height", async ({ height, width }) => {
    const { service } = createVideoArtifactHarness({ height, width });
    const prepared = await service.prepareUpload(walkaroundVideoInput());

    try {
      expect(prepared.metadata).toMatchObject({
        videoHeightPx: height,
        videoQualityStatus: "PASSED",
        videoWidthPx: width
      });
    } finally {
      await prepared.cleanup();
    }
  });

  it("rejects a 480x360 walkaround before creating keyframes", async () => {
    const { runner, service } = createVideoArtifactHarness({ height: 360, width: 480 });

    await expect(service.prepareUpload(walkaroundVideoInput())).rejects.toThrow(
      "车辆环绕视频清晰度不足，检测到 480×360，请使用系统相机以 720p 或更高画质重新录制后上传。"
    );
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("rejects a walkaround whose dimensions cannot be identified", async () => {
    const { runner, service } = createVideoArtifactHarness({ height: null, width: null });

    await expect(service.prepareUpload(walkaroundVideoInput())).rejects.toThrow(
      "车辆环绕视频清晰度不足，无法识别视频分辨率，请使用系统相机以 720p 或更高画质重新录制后上传。"
    );
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("records low resolution for non-walkaround video without enforcing the gate", async () => {
    const { service } = createVideoArtifactHarness({ height: 360, width: 480 });
    const prepared = await service.prepareUpload({
      ...walkaroundVideoInput(),
      evidenceType: "WHEEL_CLOSEUP_FRONT_LEFT"
    });

    try {
      expect(prepared.metadata).toMatchObject({
        videoHeightPx: 360,
        videoQualityStatus: null,
        videoWidthPx: 480
      });
    } finally {
      await prepared.cleanup();
    }
  });

  it("allows legacy repair to process an existing low-resolution walkaround", async () => {
    const { service } = createVideoArtifactHarness({ height: 360, width: 480 });
    const prepared = await service.prepareUpload({
      ...walkaroundVideoInput(),
      qualityPolicy: "LEGACY_REPAIR"
    });

    try {
      expect(prepared.metadata).toMatchObject({
        videoHeightPx: 360,
        videoQualityStatus: null,
        videoWidthPx: 480
      });
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

function walkaroundVideoInput() {
  return {
    evidenceType: "WALKAROUND_VIDEO",
    file: {
      buffer: Buffer.from("source-video"),
      mimetype: "video/quicktime",
      originalname: "walkaround.mov",
      size: 12
    },
    mediaType: "VIDEO" as const
  };
}

function createVideoArtifactHarness({
  height = 1080,
  width = 1920
}: {
  height?: number | null;
  width?: number | null;
} = {}) {
  let frameIndex = 0;
  const stream: Record<string, unknown> = {
    avg_frame_rate: "30000/1001",
    bit_rate: "8000000",
    codec_name: "h264",
    codec_type: "video",
    r_frame_rate: "30/1"
  };
  if (height !== null) {
    stream.height = height;
  }
  if (width !== null) {
    stream.width = width;
  }
  const runner = vi.fn(async (command: string, args: string[]) => {
    if (command.includes("ffprobe")) {
      return {
        stderr: "",
        stdout: JSON.stringify({
          format: {
            bit_rate: "9000000",
            duration: "20.5",
            format_name: "mov,mp4"
          },
          streams: [stream]
        })
      };
    }
    frameIndex += 1;
    await writeFakeJpeg(args.at(-1)!, frameIndex);
    return { stderr: "", stdout: "" };
  });
  return {
    runner,
    service: new DeliveryHandoverEvidenceArtifactService(undefined, runner)
  };
}

async function writeFakeJpeg(filePath: string, marker = 1) {
  await writeFile(filePath, fakeJpeg(marker));
}
