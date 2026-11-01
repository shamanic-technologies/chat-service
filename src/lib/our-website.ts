// ---------------------------------------------------------------------------
// read_our_website (CHAT-TRUTH-1101, owner 2026-11-01): the Copilot reads our
// PUBLIC site the way a visitor would, so what it says about distribute.you
// (pricing, what the person pays for, this chat included, terms, privacy,
// what we do) comes from what we publish, never from its own guess.
//
// Prod 2026-11-01 (a new signup, ~120 messages): with no way to read our
// terms, the Copilot agreed the chat was "a scam" and "can't justify that
// gap", while the terms say every tool is billed at the vendor's list price
// with no markup and that chatting with our AI agent is billed the same way.
// Owner decision: no policy text in a prompt, no canned replies: a tool that
// reads the site index (llms.txt), then the pages it picks.
//
// Only https://distribute.you is ever fetched (the agent picks a PATH, never a
// host). Each page is cut into parts of PART_CHARS so no single result passes
// ~2k tokens (owner rule); the outline says which part holds which heading.
// Our own site, no vendor: nothing is metered, so no cost is declared.
// ---------------------------------------------------------------------------

export const OUR_SITE_ORIGIN = "https://distribute.you";
/** The site's index for AI agents: what we do, pricing, and every page. */
export const OUR_SITE_INDEX_PATH = "/llms.txt";
/** ~2k tokens of text per result. */
export const PART_CHARS = 8000;
const CACHE_MS = 10 * 60_000;
const MAX_PATH = 300;
const MAX_OUTLINE = 40;

export class OurWebsiteError extends Error {
  constructor(message: string) {
    super(`[read_our_website] ${message}`);
    this.name = "OurWebsiteError";
  }
}

export interface OurWebsiteDeps {
  fetchImpl: typeof fetch;
  now: () => number;
}

export const defaultOurWebsiteDeps: OurWebsiteDeps = {
  fetchImpl: (...args) => fetch(...args),
  now: () => Date.now(),
};

interface Page {
  text: string;
  headings: { heading: string; at: number }[];
}

const cache = new Map<string, { at: number; page: Page }>();

/** For tests: forget every cached page. */
export function clearOurWebsiteCache(): void {
  cache.clear();
}

/**
 * The path the agent asked for, on our origin only. Accepts "/terms",
 * "terms" or a full https://distribute.you URL; anything on another host is
 * refused, never fetched.
 */
export function ourSitePath(v: unknown): string {
  if (v === undefined || v === null || v === "") return OUR_SITE_INDEX_PATH;
  if (typeof v !== "string") throw new OurWebsiteError("page must be a path on distribute.you, e.g. \"/terms\".");
  const raw = v.trim();
  if (raw.length > MAX_PATH) throw new OurWebsiteError(`page is ${raw.length} chars, ${MAX_PATH} max.`);
  let url: URL;
  try {
    url = /^https?:\/\//i.test(raw) ? new URL(raw) : new URL(raw.startsWith("/") ? raw : `/${raw}`, OUR_SITE_ORIGIN);
  } catch {
    throw new OurWebsiteError(`"${raw}" is not a path on distribute.you.`);
  }
  if (url.protocol !== "https:" || (url.hostname !== "distribute.you" && url.hostname !== "www.distribute.you")) {
    throw new OurWebsiteError(`only pages of ${OUR_SITE_ORIGIN} can be read ("${raw}" is elsewhere).`);
  }
  return url.pathname.replace(/\/+$/, "") || "/";
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/**
 * An HTML page as the text a visitor reads: the `<main>` element when there
 * is one (no menus, no footer), scripts and styles dropped, one line per
 * block, headings kept as `## ` lines so the outline can point at them.
 */
export function htmlToPage(html: string): Page {
  const main = /<main[\s>][\s\S]*?<\/main>/i.exec(html)?.[0] ?? /<body[\s>][\s\S]*<\/body>/i.exec(html)?.[0] ?? html;
  const body = main
    .replace(/<(script|style|noscript|svg|template)[\s>][\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi, (_m, inner: string) => `\n\n## ${stripTags(inner)}\n\n`)
    .replace(/<\/(p|div|li|tr|section|article|br|ul|ol|table)>|<br\s*\/?>/gi, "\n");
  const text = decodeEntities(body.replace(/<[^>]+>/g, " "))
    .split("\n")
    .map((l) => l.replace(/[ \t\f\v\r]+/g, " ").trim())
    .filter((l, i, all) => l !== "" || (i > 0 && all[i - 1] !== ""))
    .join("\n")
    .trim();
  return { text, headings: headingsOf(text) };
}

function headingsOf(text: string): { heading: string; at: number }[] {
  const out: { heading: string; at: number }[] = [];
  const re = /^#{1,4} (.+)$/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ heading: m[1].trim(), at: m.index });
  return out;
}

async function loadPage(path: string, deps: OurWebsiteDeps): Promise<Page> {
  const hit = cache.get(path);
  if (hit && deps.now() - hit.at < CACHE_MS) return hit.page;
  const res = await deps.fetchImpl(`${OUR_SITE_ORIGIN}${path}`, {
    headers: { accept: "text/html,text/plain;q=0.9", "user-agent": "distribute.you-copilot" },
    signal: AbortSignal.timeout(20_000),
  });
  // A redirect may only land on our own site.
  const finalHost = res.url ? new URL(res.url).hostname : "distribute.you";
  if (finalHost !== "distribute.you" && finalHost !== "www.distribute.you") {
    throw new OurWebsiteError(`${path} redirected off our site (${finalHost}); not read.`);
  }
  if (res.status === 404) {
    throw new OurWebsiteError(`${path} does not exist on distribute.you. Read the index (no page) to see every page.`);
  }
  if (!res.ok) throw new OurWebsiteError(`${path} answered ${res.status}; try again in a moment.`);
  const raw = await res.text();
  const isHtml = (res.headers.get("content-type") ?? "").includes("html") || /^\s*<(!doctype|html)/i.test(raw);
  const page = isHtml ? htmlToPage(raw) : { text: raw.trim(), headings: headingsOf(raw.trim()) };
  if (page.text === "") throw new OurWebsiteError(`${path} has no readable text.`);
  cache.set(path, { at: deps.now(), page });
  return page;
}

function partArg(v: unknown): number {
  if (v === undefined || v === null || v === "") return 1;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) throw new OurWebsiteError("part must be a whole number from 1.");
  return n;
}

export async function readOurWebsite(args: Record<string, unknown>, deps: OurWebsiteDeps = defaultOurWebsiteDeps) {
  const path = ourSitePath(args.page);
  const part = partArg(args.part);
  const page = await loadPage(path, deps);
  const parts = Math.max(1, Math.ceil(page.text.length / PART_CHARS));
  if (part > parts) throw new OurWebsiteError(`${path} has ${parts} part${parts === 1 ? "" : "s"}; part ${part} does not exist.`);
  const start = (part - 1) * PART_CHARS;
  return {
    url: `${OUR_SITE_ORIGIN}${path}`,
    part,
    parts,
    ...(parts > 1 ? { outline: page.headings.slice(0, MAX_OUTLINE).map((h) => ({ heading: h.heading, part: Math.floor(h.at / PART_CHARS) + 1 })) } : {}),
    text: page.text.slice(start, start + PART_CHARS),
  };
}
