// ---------------------------------------------------------------------------
// Judgment images — fetch the caller's image once, fit it to every judge's
// limits, and hand the SAME pixels to whichever judge the caller named.
//
// One prepared image for every judge is deliberate: a caller benchmarking Jev
// against Luna on the same screenshot must be comparing the judges, not two
// different resizes of the picture.
//
// The limits are TypeSafe's (https://docs.typesafe.ai/images.md, read
// 2026-10-21), the strictest of the judges we reach: PNG or JPEG, each side
// 280..1568 px, 16 MiB per file, and "an image outside them is rejected, never
// resized to fit". So the resize is ours: the longest side goes down to 1568
// (a 1920x1080 homepage screenshot becomes 1568x882, header text still
// legible), a side under 280 is padded rather than stretched, and the output is
// PNG so small text is not smeared by JPEG artefacts. OpenAI Decisions takes
// the same file as a data URL.
// ---------------------------------------------------------------------------

import sharp, { type Metadata } from "sharp";

export const JUDGMENT_IMAGE_MAX_SIDE = 1568;
export const JUDGMENT_IMAGE_MIN_SIDE = 280;
/** Largest SOURCE file we download, before the resize. */
export const JUDGMENT_IMAGE_MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Largest prepared file. Clef refuses an image over 4 MiB; a 1568 px PNG of a
 * photo-heavy page can pass that, so such a file is re-encoded as a high-quality
 * JPEG for EVERY judge (one file for all, so a benchmark compares judges).
 */
export const JUDGMENT_IMAGE_MAX_PREPARED_BYTES = 4 * 1024 * 1024;

export interface PreparedJudgmentImage {
  /** PNG, unless the PNG was over 4 MiB (then a quality-92 JPEG). */
  format: "png" | "jpeg";
  base64: string;
  width: number;
  height: number;
  /** Size of the source as fetched, before preparation. */
  sourceWidth: number;
  sourceHeight: number;
}

/**
 * The image host did not answer after every retry (network failure, 429, 5xx).
 * Not the caller's fault and it usually clears: routes answer 502 with
 * `retryable: true`, never the 400 that tells the caller its image is bad.
 * Seen in prod 2026-10-21: the r2.dev public bucket dropped ~10% of 66
 * parallel downloads with a bare "fetch failed", all fine on the next try.
 */
export class JudgmentImageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgmentImageUnavailableError";
  }
}

/** Waits between download attempts; the host's failures clear in about a second. */
export const IMAGE_FETCH_RETRY_DELAYS_MS = [500, 1500, 3500];

/**
 * The caller's image could not be used. Always the CALLER's to fix (a dead
 * URL, a non-image, a file over the size cap), so routes answer 400 with this
 * message — never a 502 that suggests retrying.
 */
export class JudgmentImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgmentImageError";
  }
}

/**
 * Fit an image to the judges' limits. Pure: bytes in, prepared PNG out.
 * `rotate()` with no argument applies the EXIF orientation to the pixels — the
 * vendor strips EXIF without applying it, so a phone photo would arrive sideways.
 */
export async function prepareJudgmentImageBytes(bytes: Buffer): Promise<PreparedJudgmentImage> {
  let meta: Metadata;
  try {
    meta = await sharp(bytes).metadata();
  } catch (err) {
    throw new JudgmentImageError(
      `image is not a readable picture (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!meta.width || !meta.height) {
    throw new JudgmentImageError("image has no readable width/height");
  }

  let pipeline = sharp(bytes, { animated: false })
    .rotate()
    .resize({
      width: JUDGMENT_IMAGE_MAX_SIDE,
      height: JUDGMENT_IMAGE_MAX_SIDE,
      fit: "inside",
      withoutEnlargement: true,
    });

  // Size after the shrink, to know how much padding a thin side needs.
  const rotatedSwap = (meta.orientation ?? 1) >= 5;
  const w0 = rotatedSwap ? meta.height : meta.width;
  const h0 = rotatedSwap ? meta.width : meta.height;
  const scale = Math.min(1, JUDGMENT_IMAGE_MAX_SIDE / Math.max(w0, h0));
  const w1 = Math.max(1, Math.round(w0 * scale));
  const h1 = Math.max(1, Math.round(h0 * scale));
  const padX = Math.max(0, JUDGMENT_IMAGE_MIN_SIDE - w1);
  const padY = Math.max(0, JUDGMENT_IMAGE_MIN_SIDE - h1);
  if (padX > 0 || padY > 0) {
    // Pad, never stretch: upscaling a thin banner blurs the text the question is about.
    pipeline = pipeline.extend({
      left: Math.floor(padX / 2),
      right: Math.ceil(padX / 2),
      top: Math.floor(padY / 2),
      bottom: Math.ceil(padY / 2),
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    });
  }

  const flat = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } });
  let { data, info } = await flat.clone().png().toBuffer({ resolveWithObject: true });
  let format: PreparedJudgmentImage["format"] = "png";
  if (data.length > JUDGMENT_IMAGE_MAX_PREPARED_BYTES) {
    ({ data, info } = await flat.jpeg({ quality: 92 }).toBuffer({ resolveWithObject: true }));
    format = "jpeg";
  }

  return {
    format,
    base64: data.toString("base64"),
    width: info.width,
    height: info.height,
    sourceWidth: w0,
    sourceHeight: h0,
  };
}

/** Download the caller's image (https only) and prepare it. */
export async function fetchJudgmentImage(url: string): Promise<PreparedJudgmentImage> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new JudgmentImageError(`image.url is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new JudgmentImageError("image.url must be an https URL");
  }

  // Retry what clears (network failure, 429, 5xx); a 4xx other than 429 is
  // the caller's URL and is refused at once.
  let res: Response | null = null;
  let lastFailure = "";
  for (let attempt = 0; attempt <= IMAGE_FETCH_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(IMAGE_FETCH_RETRY_DELAYS_MS[attempt - 1]!);
    try {
      const r = await fetch(parsed, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (r.ok) {
        res = r;
        break;
      }
      if (r.status !== 429 && r.status < 500) {
        throw new JudgmentImageError(`image could not be fetched from ${url}: HTTP ${r.status}`);
      }
      lastFailure = `HTTP ${r.status}`;
    } catch (err) {
      if (err instanceof JudgmentImageError) throw err;
      lastFailure = err instanceof Error ? err.message : String(err);
    }
  }
  if (!res) {
    throw new JudgmentImageUnavailableError(
      `image host did not answer for ${url} after ${IMAGE_FETCH_RETRY_DELAYS_MS.length + 1} attempts (${lastFailure})`,
    );
  }
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > JUDGMENT_IMAGE_MAX_SOURCE_BYTES) {
    throw new JudgmentImageError(
      `image is ${declared} bytes, over the ${JUDGMENT_IMAGE_MAX_SOURCE_BYTES}-byte limit`,
    );
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > JUDGMENT_IMAGE_MAX_SOURCE_BYTES) {
    throw new JudgmentImageError(
      `image is ${bytes.length} bytes, over the ${JUDGMENT_IMAGE_MAX_SOURCE_BYTES}-byte limit`,
    );
  }
  return prepareJudgmentImageBytes(bytes);
}

/**
 * Pre-call HOLD size for the image's input tokens. Not a price: both judges
 * report the exact count afterwards and the hold is reconciled to it. Sized
 * from a live probe (2026-10-21, 1568x882 screenshot: Jev 3,880 tokens, Luna
 * 1,656) so the reservation sits above either, never far above.
 */
export function estimateImageTokens(image: Pick<PreparedJudgmentImage, "width" | "height">): number {
  return Math.ceil((image.width * image.height) / 300);
}
