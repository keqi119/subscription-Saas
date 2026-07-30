import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const STAGE2_EVIDENCE_ARTIFACT_PROCESSING_FAILED =
  "STAGE2_EVIDENCE_ARTIFACT_PROCESSING_FAILED";

const PHOTO_MAX_BYTES = 400 * 1024;
const VIDEO_FRAME_MAX_BYTES = 200 * 1024;
const DEFAULT_PROCESS_TIMEOUT_MS = 120_000;
const DEFAULT_PROCESS_CONCURRENCY = 2;
const DEFAULT_PROCESS_QUEUE_LIMIT = 8;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const JPEG_PROFILES = [
  { longEdge: 1600, quality: 5 },
  { longEdge: 1280, quality: 7 },
  { longEdge: 960, quality: 9 }
] as const;

export type DeliveryEvidenceArtifactMediaType = "PHOTO" | "VIDEO";

export interface DeliveryEvidenceArtifactUploadFile {
  buffer?: Buffer;
  mimetype?: string;
  originalname: string;
  path?: string;
  size: number;
}

export interface DeliveryEvidenceArtifactMetadata {
  artifactVersion: 1;
  detectedCodec: string | null;
  detectedMimeType: string;
  processedAt: string;
  processingStatus: "READY";
  sourceSha256: string;
  sourceSizeBytes: number;
  videoDurationMs: number | null;
}

export interface PreparedDeliveryEvidenceDerivative {
  contentType: "image/jpeg";
  filePath: string;
  kind: "PHOTO_PREVIEW" | "VIDEO_FRAME";
  originalName: string;
  sizeBytes: number;
}

export interface PreparedDeliveryEvidenceArtifacts {
  cleanup: () => Promise<void>;
  derivatives: PreparedDeliveryEvidenceDerivative[];
  metadata: DeliveryEvidenceArtifactMetadata;
}

export interface PrepareDeliveryEvidenceUploadInput {
  evidenceType: string;
  file: DeliveryEvidenceArtifactUploadFile;
  mediaType: DeliveryEvidenceArtifactMediaType;
}

export type DeliveryEvidenceCommandRunner = (
  command: string,
  args: string[],
  timeoutMs?: number
) => Promise<{ stderr: string; stdout: string }>;

@Injectable()
export class DeliveryHandoverEvidenceArtifactService {
  private readonly processingGate = new MediaProcessingGate();

  constructor(
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly commandRunner?: DeliveryEvidenceCommandRunner
  ) {}

  async prepareUpload(
    input: PrepareDeliveryEvidenceUploadInput
  ): Promise<PreparedDeliveryEvidenceArtifacts> {
    const concurrency = positiveIntegerConfig(
      this.configService,
      "STAGE2_MEDIA_PROCESS_CONCURRENCY",
      DEFAULT_PROCESS_CONCURRENCY
    );
    const queueLimit = positiveIntegerConfig(
      this.configService,
      "STAGE2_MEDIA_PROCESS_QUEUE_LIMIT",
      DEFAULT_PROCESS_QUEUE_LIMIT
    );
    return this.processingGate.run(
      concurrency,
      queueLimit,
      () => this.prepareUploadInternal(input)
    );
  }

  private async prepareUploadInternal(
    input: PrepareDeliveryEvidenceUploadInput
  ): Promise<PreparedDeliveryEvidenceArtifacts> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "stage2-evidence-artifact-"));
    let completed = false;
    try {
      const sourcePath = await materializeSource(input.file, directory);
      const sourceStat = await stat(sourcePath);
      if (!sourceStat.isFile() || sourceStat.size <= 0) {
        fail("source file is empty");
      }
      const sourceSha256 = await calculateDeliveryEvidenceSourceSha256(sourcePath);
      const declaredMimeType = normalizeMimeType(input.file.mimetype, input.mediaType);
      const prepared = input.mediaType === "PHOTO"
        ? await this.preparePhoto(
            sourcePath,
            directory,
            input.file.originalname,
            declaredMimeType
          )
        : await this.prepareVideo(
            sourcePath,
            directory,
            input.file.originalname,
            input.evidenceType,
            declaredMimeType
          );
      completed = true;
      let cleaned = false;

      return {
        cleanup: async () => {
          if (cleaned) {
            return;
          }
          cleaned = true;
          await rm(directory, { force: true, recursive: true });
        },
        derivatives: prepared.derivatives,
        metadata: {
          artifactVersion: 1,
          detectedCodec: "detectedCodec" in prepared ? prepared.detectedCodec : null,
          detectedMimeType: prepared.detectedMimeType,
          processedAt: new Date().toISOString(),
          processingStatus: "READY",
          sourceSha256,
          sourceSizeBytes: sourceStat.size,
          videoDurationMs: prepared.videoDurationMs
        }
      };
    } catch (error) {
      throw normalizeProcessingError(error);
    } finally {
      if (!completed) {
        await rm(directory, { force: true, recursive: true });
      }
    }
  }

  private async preparePhoto(
    sourcePath: string,
    directory: string,
    originalName: string,
    declaredMimeType: string
  ) {
    const outputPath = path.join(directory, "photo-preview.jpg");
    const detectedMimeType = await detectPhotoMimeType(
      sourcePath,
      originalName,
      declaredMimeType
    );
    const sizeBytes = await this.encodeBoundedJpeg(sourcePath, outputPath, PHOTO_MAX_BYTES);
    return {
      detectedMimeType,
      derivatives: [
        {
          contentType: "image/jpeg" as const,
          filePath: outputPath,
          kind: "PHOTO_PREVIEW" as const,
          originalName: `${safeBaseName(originalName)}-preview.jpg`,
          sizeBytes
        }
      ],
      videoDurationMs: null
    };
  }

  private async prepareVideo(
    sourcePath: string,
    directory: string,
    originalName: string,
    evidenceType: string,
    declaredMimeType: string
  ) {
    const probe = await this.run(
      this.configService?.get<string>("FFPROBE_PATH")?.trim() || "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name,codec_type:format=duration,format_name",
        "-of",
        "json",
        sourcePath
      ]
    );
    const parsed = parseProbeOutput(probe.stdout, originalName, declaredMimeType);
    const percentages = framePercentagesForEvidence(evidenceType);
    const derivatives: PreparedDeliveryEvidenceDerivative[] = [];

    for (const [index, percentage] of percentages.entries()) {
      const outputPath = path.join(directory, `video-frame-${String(index + 1).padStart(2, "0")}.jpg`);
      const seconds = (parsed.durationMs / 1000 * percentage).toFixed(3);
      const sizeBytes = await this.encodeBoundedJpeg(
        sourcePath,
        outputPath,
        VIDEO_FRAME_MAX_BYTES,
        seconds
      );
      derivatives.push({
        contentType: "image/jpeg",
        filePath: outputPath,
        kind: "VIDEO_FRAME",
        originalName: `${safeBaseName(originalName)}-frame-${String(index + 1).padStart(2, "0")}.jpg`,
        sizeBytes
      });
    }
    await assertDistinctVideoFrames(derivatives);

    return {
      derivatives,
      detectedCodec: parsed.detectedCodec,
      detectedMimeType: parsed.detectedMimeType,
      videoDurationMs: parsed.durationMs
    };
  }

  private async encodeBoundedJpeg(
    sourcePath: string,
    outputPath: string,
    maxBytes: number,
    seekSeconds?: string
  ) {
    for (const profile of JPEG_PROFILES) {
      await rm(outputPath, { force: true });
      const args = [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        ...(seekSeconds ? ["-ss", seekSeconds] : []),
        "-i",
        sourcePath,
        "-map_metadata",
        "-1",
        "-frames:v",
        "1",
        "-vf",
        `scale=${profile.longEdge}:${profile.longEdge}:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuvj420p`,
        "-q:v",
        String(profile.quality),
        outputPath
      ];
      await this.run(
        this.configService?.get<string>("FFMPEG_PATH")?.trim() || "ffmpeg",
        args
      );
      const outputSize = await validateJpegOutput(outputPath);
      if (outputSize <= maxBytes) {
        return outputSize;
      }
    }
    return fail(`JPEG derivative exceeds ${maxBytes} bytes`);
  }

  private run(command: string, args: string[]) {
    const configuredTimeout = Number(this.configService?.get<string>("STAGE2_MEDIA_PROCESS_TIMEOUT_MS"));
    const timeoutMs = Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : DEFAULT_PROCESS_TIMEOUT_MS;
    return (this.commandRunner ?? runDeliveryEvidenceCommand)(command, args, timeoutMs);
  }
}

export async function calculateDeliveryEvidenceSourceSha256(filePath: string) {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return `sha256:${hash.digest("hex")}`;
}

export function framePercentagesForEvidence(evidenceType: string) {
  return evidenceType === "WALKAROUND_VIDEO"
    ? [0.1, 0.35, 0.6, 0.85]
    : [0.25, 0.75];
}

async function materializeSource(file: DeliveryEvidenceArtifactUploadFile, directory: string) {
  if (file.path) {
    return file.path;
  }
  if (!file.buffer?.length) {
    return fail("source bytes are missing");
  }
  const sourcePath = path.join(directory, `source${safeExtension(file.originalname)}`);
  await writeFile(sourcePath, file.buffer);
  return sourcePath;
}

async function validateJpegOutput(filePath: string) {
  let fileStat;
  let bytes: Buffer;
  try {
    fileStat = await stat(filePath);
    bytes = await readFile(filePath);
  } catch {
    return fail("media processor did not create a JPEG derivative");
  }
  if (
    !fileStat.isFile() ||
    fileStat.size < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes.at(-2) !== 0xff ||
    bytes.at(-1) !== 0xd9
  ) {
    return fail("media processor created an invalid JPEG derivative");
  }
  return fileStat.size;
}

async function assertDistinctVideoFrames(derivatives: PreparedDeliveryEvidenceDerivative[]) {
  const hashes = await Promise.all(derivatives.map(async (derivative) =>
    createHash("sha256").update(await readFile(derivative.filePath)).digest("hex")
  ));
  if (new Set(hashes).size !== hashes.length) {
    return fail("video keyframes are not visually distinct");
  }
}

function parseProbeOutput(stdout: string, originalName: string, declaredMimeType: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return fail("ffprobe returned invalid JSON");
  }
  const record = asRecord(parsed);
  const format = asRecord(record?.format);
  const streams = Array.isArray(record?.streams) ? record.streams.filter(isPlainObject) : [];
  const videoStream = streams.find((stream) => stream.codec_type === "video");
  const durationSeconds = Number(format?.duration);
  if (!videoStream || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return fail("video duration or stream metadata is missing");
  }
  const formatName = typeof format?.format_name === "string" ? format.format_name : "";
  const detectedCodec = typeof videoStream.codec_name === "string" && videoStream.codec_name.trim()
    ? videoStream.codec_name.trim().toLowerCase()
    : null;
  if (!detectedCodec) {
    return fail("video codec metadata is missing");
  }
  const detectedMimeType = detectVideoMimeType(formatName, originalName, declaredMimeType);
  return {
    detectedCodec,
    detectedMimeType,
    durationMs: Math.round(durationSeconds * 1000)
  };
}

async function detectPhotoMimeType(
  sourcePath: string,
  originalName: string,
  declaredMimeType: string
) {
  const handle = await open(sourcePath, "r");
  try {
    const header = Buffer.alloc(32);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const bytes = header.subarray(0, bytesRead);
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return "image/jpeg";
    }
    if (
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
      return "image/png";
    }
    if (
      bytes.length >= 12 &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP"
    ) {
      return "image/webp";
    }
    if (bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp") {
      const brands = [];
      for (let offset = 8; offset + 4 <= bytes.length; offset += 4) {
        brands.push(bytes.toString("ascii", offset, offset + 4).toLowerCase());
      }
      if (brands.some((brand) => ["heic", "heix", "hevc", "hevx", "heim", "heis"].includes(brand))) {
        return "image/heic";
      }
      if (brands.some((brand) => ["heif", "mif1", "msf1"].includes(brand))) {
        return path.extname(originalName).toLowerCase() === ".heic" || declaredMimeType === "image/heic"
          ? "image/heic"
          : "image/heif";
      }
    }
  } finally {
    await handle.close();
  }
  return fail("unsupported or unrecognized photo content");
}

function detectVideoMimeType(
  formatName: string,
  originalName: string,
  declaredMimeType: string
) {
  const extension = path.extname(originalName).toLowerCase();
  if (formatName.includes("webm")) {
    return "video/webm";
  }
  if (formatName.includes("matroska")) {
    return fail("unsupported Matroska video container");
  }
  if (formatName.includes("mp4") || formatName.includes("mov")) {
    if (extension === ".mov" || declaredMimeType === "video/quicktime") {
      return "video/quicktime";
    }
    if (extension === ".m4v" || declaredMimeType === "video/x-m4v") {
      return "video/x-m4v";
    }
    return "video/mp4";
  }
  return fail(`unsupported video container: ${formatName || "unknown"}`);
}

function runDeliveryEvidenceCommand(
  command: string,
  args: string[],
  timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS
) {
  return new Promise<{ stderr: string; stdout: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const rejectOnce = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };
    const timer = setTimeout(() => {
      rejectOnce(new Error("media processor timed out"));
    }, timeoutMs);
    const appendOutput = (target: Buffer[], chunk: Buffer) => {
      const buffer = Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        rejectOnce(new Error("media processor output exceeded limit"));
        return;
      }
      target.push(buffer);
    };
    child.stdout.on("data", (chunk: Buffer) => appendOutput(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => appendOutput(stderr, chunk));
    child.on("error", (error) => {
      rejectOnce(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const output = {
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8")
      };
      if (code !== 0) {
        reject(new Error(`media processor exited with code ${code}: ${output.stderr}`));
        return;
      }
      resolve(output);
    });
  });
}

class MediaProcessingGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  async run<T>(concurrency: number, queueLimit: number, task: () => Promise<T>): Promise<T> {
    if (this.active >= concurrency) {
      if (this.waiting.length >= queueLimit) {
        return fail("media processing queue is full");
      }
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

function positiveIntegerConfig(
  configService: ConfigService | undefined,
  key: string,
  fallback: number
) {
  const value = Number(configService?.get<string>(key));
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function normalizeMimeType(value: string | undefined, mediaType: DeliveryEvidenceArtifactMediaType) {
  const normalized = value?.split(";")[0]?.trim().toLowerCase();
  return normalized || (mediaType === "PHOTO" ? "image/unknown" : "video/unknown");
}

function safeBaseName(originalName: string) {
  return path.parse(originalName).name.replace(/[^\w.-]+/g, "_").slice(0, 80) || "evidence";
}

function safeExtension(originalName: string) {
  const extension = path.extname(originalName).replace(/[^\w.]+/g, "").slice(0, 12);
  return extension && extension !== "." ? extension : ".bin";
}

export function isDeliveryEvidenceArtifactProcessingError(error: unknown): boolean {
  return error instanceof Error
    && error.message.startsWith(STAGE2_EVIDENCE_ARTIFACT_PROCESSING_FAILED);
}

function normalizeProcessingError(error: unknown) {
  if (isDeliveryEvidenceArtifactProcessingError(error)) {
    return error;
  }
  const message = error instanceof Error ? error.message : "unknown media processing failure";
  return new Error(`${STAGE2_EVIDENCE_ARTIFACT_PROCESSING_FAILED}: ${message}`);
}

function fail(message: string): never {
  throw new Error(`${STAGE2_EVIDENCE_ARTIFACT_PROCESSING_FAILED}: ${message}`);
}

function asRecord(value: unknown) {
  return isPlainObject(value) ? value : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
