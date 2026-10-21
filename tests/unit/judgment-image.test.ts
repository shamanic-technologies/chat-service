import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  JudgmentImageError,
  JudgmentImageUnavailableError,
  JUDGMENT_IMAGE_MAX_SIDE,
  JUDGMENT_IMAGE_MIN_SIDE,
  estimateImageTokens,
  fetchJudgmentImage,
  prepareJudgmentImageBytes,
} from "../../src/lib/judgment-image.js";

async function png(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png()
    .toBuffer();
}

describe("prepareJudgmentImageBytes — fits every judge's limits", () => {
  it("shrinks a 1920x1080 homepage screenshot to 1568 wide, aspect kept", async () => {
    const out = await prepareJudgmentImageBytes(await png(1920, 1080));
    expect(out).toMatchObject({ format: "png", width: 1568, height: 882, sourceWidth: 1920, sourceHeight: 1080 });
    const meta = await sharp(Buffer.from(out.base64, "base64")).metadata();
    expect(meta.format).toBe("png");
    expect([meta.width, meta.height]).toEqual([1568, 882]);
  });

  it("leaves an image already inside the limits at its size (never upscales)", async () => {
    const out = await prepareJudgmentImageBytes(await png(1280, 800));
    expect([out.width, out.height]).toEqual([1280, 800]);
  });

  it("pads (never stretches) a side under the minimum", async () => {
    const out = await prepareJudgmentImageBytes(await png(3000, 100));
    expect(out.width).toBe(JUDGMENT_IMAGE_MAX_SIDE);
    expect(out.height).toBe(JUDGMENT_IMAGE_MIN_SIDE);
    const tiny = await prepareJudgmentImageBytes(await png(100, 120));
    expect([tiny.width, tiny.height]).toEqual([JUDGMENT_IMAGE_MIN_SIDE, JUDGMENT_IMAGE_MIN_SIDE]);
  });

  it("a PNG over 4 MiB (Clef's limit) becomes a JPEG, for every judge", async () => {
    const { randomBytes } = await import("crypto");
    const noise = randomBytes(1568 * 1568 * 3);
    const big = await sharp(noise, { raw: { width: 1568, height: 1568, channels: 3 } }).png().toBuffer();
    const out = await prepareJudgmentImageBytes(big);
    expect(out.format).toBe("jpeg");
    expect(Buffer.byteLength(out.base64, "base64")).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it("re-encodes a JPEG as PNG", async () => {
    const jpg = await sharp({ create: { width: 600, height: 400, channels: 3, background: "#fff" } }).jpeg().toBuffer();
    const out = await prepareJudgmentImageBytes(jpg);
    expect((await sharp(Buffer.from(out.base64, "base64")).metadata()).format).toBe("png");
  });

  it("refuses bytes that are not a picture with a named error", async () => {
    await expect(prepareJudgmentImageBytes(Buffer.from("<html>not an image</html>"))).rejects.toBeInstanceOf(
      JudgmentImageError,
    );
  });
});

describe("fetchJudgmentImage", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const ok = async () => ({ ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => await png(600, 400) });

  it("refuses a non-https URL before any fetch", async () => {
    await expect(fetchJudgmentImage("http://localhost:8080/x.png")).rejects.toThrow(/https/);
  });

  // Prod 2026-10-21: the r2.dev bucket dropped ~10% of parallel downloads with a bare
  // "fetch failed" and served them fine a second later. Those were answered 400 "bad image".
  it("retries a dropped download and a 429/5xx, then succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ ok: false, status: 429, headers: new Headers() })
      .mockResolvedValueOnce({ ok: false, status: 503, headers: new Headers() })
      .mockImplementationOnce(ok);
    vi.stubGlobal("fetch", fetchMock);
    const p = fetchJudgmentImage("https://pub.test.r2.dev/a.png");
    await vi.runAllTimersAsync();
    await expect(p).resolves.toMatchObject({ width: 600, height: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("a host that never answers is a retryable unavailability, not a bad image", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const p = fetchJudgmentImage("https://pub.test.r2.dev/a.png");
    const settled = p.catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await settled;
    expect(err).toBeInstanceOf(JudgmentImageUnavailableError);
    expect(err).not.toBeInstanceOf(JudgmentImageError);
  });

  it("a 404 is the caller's URL: refused at once, no retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, headers: new Headers() });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchJudgmentImage("https://pub.test.r2.dev/a.png")).rejects.toBeInstanceOf(JudgmentImageError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("estimateImageTokens", () => {
  it("sits above both judges' measured counts for a 1568x882 screenshot (Jev 3,880, Luna 1,656)", () => {
    const est = estimateImageTokens({ width: 1568, height: 882 });
    expect(est).toBeGreaterThan(3880);
    expect(est).toBeLessThan(3880 * 2);
  });
});
