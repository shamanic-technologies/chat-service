// ---------------------------------------------------------------------------
// Photos a person sent, handed to the model AS IMAGES (SOPHIE-WA-HUMAN-1106,
// owner 2026-11-06: « quid de mettre des images en input de son prompt ? »).
//
// No describe-then-text step: the pixels join the turn's user message and the
// model reads them like the words beside them. Sophie's model reads images
// natively (DeepSeek V4.1 Flash, probed live 2026-11-06: a "749" drawn in green
// pixels came back "The number 749 is green" 3/3, prompt 215 tokens), so her
// model did not move for this.
//
// Each photo is fitted once (longest side 1568 px, EXIF orientation applied,
// PNG unless too big) by the same preparation the judgment images use, so a
// phone photo never arrives sideways or at 12 MP.
// ---------------------------------------------------------------------------

import { estimateImageTokens, prepareJudgmentImageBytes } from "./judgment-image.js";

/** One photo, ready for the model's input. */
export interface TurnImage {
  mimeType: "image/png" | "image/jpeg";
  base64: string;
  width: number;
  height: number;
  /** When the person sent it (ISO), so the model can tell which message it belongs to. */
  at?: string | null;
  /** Their words sent with it, when any. */
  caption?: string | null;
}

/** At most this many photos join one turn (the newest ones): a turn answers a moment, not an album. */
export const TURN_IMAGES_MAX = 4;

/** Fit raw image bytes for the model. Throws `JudgmentImageError` when the bytes are not a picture. */
export async function prepareTurnImage(bytes: Buffer, meta: { at?: string | null; caption?: string | null } = {}): Promise<TurnImage> {
  const prepared = await prepareJudgmentImageBytes(bytes);
  return {
    mimeType: prepared.format === "png" ? "image/png" : "image/jpeg",
    base64: prepared.base64,
    width: prepared.width,
    height: prepared.height,
    ...(meta.at !== undefined ? { at: meta.at } : {}),
    ...(meta.caption !== undefined ? { caption: meta.caption } : {}),
  };
}

/** The data URL an OpenAI-compatible vendor reads (`image_url.url`). */
export function imageDataUrl(image: Pick<TurnImage, "mimeType" | "base64">): string {
  return `data:${image.mimeType};base64,${image.base64}`;
}

/** The text line that introduces the photos inside the user message (what they are, from whom, when). */
export function imagesIntro(images: readonly TurnImage[]): string {
  const lines = images.map((img, i) => {
    const when = img.at ? ` sent ${img.at}` : "";
    const caption = img.caption?.trim() ? ` with the words: "${img.caption.trim()}"` : " with no words";
    return `Photo ${i + 1}${when}${caption}.`;
  });
  return `(The person sent ${images.length === 1 ? "this photo" : `these ${images.length} photos`}; you see ${images.length === 1 ? "it" : "them"} below.)\n${lines.join("\n")}`;
}

const DATA_URL = /data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+/g;

/**
 * Pre-call HOLD size of a request carrying images: the text as characters / 4
 * (the /chat rule) with every inlined image counted by its pixels, never by its
 * base64 length (a 1568 px photo is ~2 MB of base64, ~500k "tokens" read as text,
 * while the vendor bills a few hundred to a few thousand).
 */
export function estimateRequestTokensWithImages(payload: unknown, images: readonly Pick<TurnImage, "width" | "height">[]): number {
  const text = JSON.stringify(payload).replace(DATA_URL, "");
  const imageTokens = images.reduce((sum, img) => sum + estimateImageTokens(img), 0);
  return Math.max(Math.ceil(text.length / 4), 500) + imageTokens;
}
