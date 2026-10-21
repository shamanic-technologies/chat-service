import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  JudgmentImageError,
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
  it("refuses a non-https URL before any fetch", async () => {
    await expect(fetchJudgmentImage("http://localhost:8080/x.png")).rejects.toThrow(/https/);
  });
});

describe("estimateImageTokens", () => {
  it("sits above both judges' measured counts for a 1568x882 screenshot (Jev 3,880, Luna 1,656)", () => {
    const est = estimateImageTokens({ width: 1568, height: 882 });
    expect(est).toBeGreaterThan(3880);
    expect(est).toBeLessThan(3880 * 2);
  });
});
