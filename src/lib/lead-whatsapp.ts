/**
 * SOPHIE ON WHATSAPP, LIKE A PERSON (SOPHIE-WA-HUMAN-1106). Owner 2026-11-04,
 * « complètement à côté de la plaque »; 2026-11-06: « pas moyen que Sophie voie à
 * quel message je reply ? », « quid de mettre des images en input de son prompt ? ».
 *
 * A WhatsApp Lead event turn reads what the writer's text thread cannot carry
 * from the Lead event's own record (crm-service's occurrence `item`, handed
 * over by the workflow as `occurrenceItem`: `thread[]` and the burst
 * `messages[]`, each with its event id, quote and photo):
 *  - the person's latest WhatsApp messages AS WHATSAPP SHOWS THEM: each with the
 *    message it quotes (their « Reply ») and whether it is a photo, each named by
 *    a short label (`m1`…) the model can quote back (`replyTo`); the label maps
 *    to the message's event id, which the send takes as `replyToEventId`;
 *  - the photos they sent since our last message, handed to the model as images
 *    (turn-images.ts), never described to text first;
 *  - « typing… » in their WhatsApp from the start of the turn until the answer is
 *    sent (crm ends it on the send) or the turn decides to write nothing now.
 *
 * Every call is made as the turn's CALLER (the writing brand's org and the
 * writer's run): the conversation is the brand's, whatever account the turn
 * runs under. Nothing here is a per-person rule.
 */
import { prepareTurnImage, TURN_IMAGES_MAX, type TurnImage } from "./turn-images.js";

/** Who reads: the lead turn's caller (the writing brand's org, the writer's run). */
export interface CrmCaller {
  orgId: string;
  userId: string;
  runId: string;
}

/** The message a WhatsApp message quotes (crm `QuotedMessage`). */
export interface WhatsappQuote {
  eventId: string;
  direction: "inbound" | "outbound" | null;
  at: string | null;
  text: string | null;
}

/** One WhatsApp message of the conversation, as crm's timeline serves it. */
export interface WhatsappLine {
  eventId: string;
  at: string;
  direction: "inbound" | "outbound";
  text: string;
  quote: WhatsappQuote | null;
  /** The message IS a photo (its caption, when any, is in `text`). */
  photo: { caption: string | null } | null;
}

/** How many of the latest WhatsApp messages the turn lists with their labels. */
export const WHATSAPP_LINES_SHOWN = 12;
/** A line's words are cut here in the list (the writer's thread holds them whole). */
const LINE_TEXT_MAX = 600;

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not configured`);
  return v;
}

function crmHeaders(caller: CrmCaller, brandId: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": env("CRM_SERVICE_API_KEY"),
    "x-org-id": caller.orgId,
    "x-user-id": caller.userId,
    "x-run-id": caller.runId,
    "x-brand-id": brandId,
  };
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** PURE: crm timeline items → the WhatsApp messages (oldest first), each with its id, quote and photo. */
export function whatsappLinesOf(items: unknown[]): WhatsappLine[] {
  const lines: WhatsappLine[] = [];
  for (const raw of items) {
    const it = (raw ?? {}) as Record<string, unknown>;
    if (it.source !== "matrix" || it.kind !== "message") continue;
    if (it.channel !== undefined && it.channel !== "whatsapp") continue;
    const ref = (it.ref ?? {}) as Record<string, unknown>;
    const eventId = str(ref.eventId);
    const at = str(it.at);
    const direction = it.direction === "inbound" || it.direction === "outbound" ? it.direction : null;
    const text = typeof it.text === "string" ? it.text : "";
    if (!eventId || !at || !direction || !text.trim()) continue;
    const q = it.quote && typeof it.quote === "object" ? (it.quote as Record<string, unknown>) : null;
    const quote: WhatsappQuote | null =
      q && str(q.eventId)
        ? {
            eventId: str(q.eventId)!,
            direction: q.direction === "inbound" || q.direction === "outbound" ? q.direction : null,
            at: str(q.at),
            text: str(q.text),
          }
        : null;
    const p = it.photo && typeof it.photo === "object" ? (it.photo as Record<string, unknown>) : null;
    lines.push({ eventId, at, direction, text, quote, photo: p ? { caption: str(p.caption) } : null });
  }
  return lines.sort((a, b) => a.at.localeCompare(b.at));
}

/** PURE: the person's messages since our last one (what this turn answers), oldest first. */
export function theirLatest(lines: readonly WhatsappLine[]): WhatsappLine[] {
  const out: WhatsappLine[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].direction === "outbound") break;
    out.unshift(lines[i]);
  }
  return out;
}

/** What a turn knows of the WhatsApp conversation beside the writer's thread. */
export interface WhatsappMoment {
  /** The latest messages, oldest first, each with its label (`m1`… newest last). */
  shown: Array<WhatsappLine & { label: string }>;
  /** Label → event id: what `replyTo` names and the send quotes. */
  labels: Map<string, string>;
  /** Photos of their latest messages, ready for the model. */
  images: TurnImage[];
  /** Photos we could not read (their event ids), said to the model. */
  unreadablePhotos: string[];
}

function clock(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

/** PURE: labels the latest lines `m1`…`mN` (newest = highest). */
export function labelLines(lines: readonly WhatsappLine[], max = WHATSAPP_LINES_SHOWN): WhatsappMoment["shown"] {
  return lines.slice(-max).map((l, i) => ({ ...l, label: `m${i + 1}` }));
}

/**
 * PURE: the block the model reads: their latest WhatsApp messages as WhatsApp
 * shows them (who, when, what each quotes, photos), each with its label, and how
 * to quote one back when the answer is about it.
 */
export function whatsappMomentBlock(moment: Pick<WhatsappMoment, "shown" | "images" | "unreadablePhotos">, replyField: string): string {
  if (moment.shown.length === 0) return "";
  const byEvent = new Map(moment.shown.map((l) => [l.eventId, l.label]));
  const lines = moment.shown.map((l) => {
    const who = l.direction === "inbound" ? "them" : "us";
    let quote = "";
    if (l.quote) {
      const qWho = l.quote.direction === "inbound" ? "them" : l.quote.direction === "outbound" ? "us" : "a message";
      const qLabel = byEvent.get(l.quote.eventId);
      const qWhen = l.quote.at ? ` ${clock(l.quote.at)}` : "";
      const qText = l.quote.text ? `: "${oneLine(l.quote.text, 300)}"` : " (not in our records)";
      quote = ` [replying to ${qLabel ? `${qLabel}, ` : ""}${qWho}${qWhen}${qText}]`;
    }
    return `${l.label} | ${clock(l.at)} | ${who}${quote}: ${oneLine(l.text, LINE_TEXT_MAX)}`;
  });
  const parts = [
    "### Their WhatsApp conversation with this number, as WhatsApp shows it (latest messages, oldest first)",
    "Each message has a label (m1, m2...). [replying to ...] = they (or we) answered that precise message with WhatsApp \"Reply\": their words are about it.",
    ...lines,
  ];
  if (moment.images.length > 0) parts.push(`Their photo${moment.images.length > 1 ? "s" : ""} since our last message ${moment.images.length > 1 ? "are" : "is"} attached to this turn as image${moment.images.length > 1 ? "s" : ""}: look at ${moment.images.length > 1 ? "them" : "it"}.`);
  if (moment.unreadablePhotos.length > 0) parts.push(`${moment.unreadablePhotos.length} photo(s) they sent could not be loaded: if it matters, say you could not open it and ask them to send it again.`);
  parts.push(
    `You can answer as a WhatsApp "Reply" too: put the label of the message your answer is about in \`${replyField}\`, and they see that message quoted above yours. ` +
      "Use it whenever it helps them follow: you answer one message among several, an older one, a photo, or the message they quoted. Leave it empty when you simply answer their single last message or write nothing now.",
  );
  return parts.join("\n");
}

/**
 * PURE: the WhatsApp messages of a Lead event's record (crm `item`): the
 * thread before the burst, then the burst (their latest messages), oldest
 * first. Not a WhatsApp event (no `thread` / `messages` with event ids) = none.
 * A timeline read was tried first and dropped: a person's timeline mixes every
 * source (Kevin's: 18,218 items, the latest 60 all API calls, 13 s a read).
 */
export function whatsappLinesFromItem(item: Record<string, unknown> | null | undefined): WhatsappLine[] {
  if (!item || typeof item !== "object") return [];
  const thread = Array.isArray(item.thread) ? item.thread : [];
  const burst = Array.isArray(item.messages) ? item.messages : [];
  const asItem = (raw: unknown, direction: unknown) => {
    const m = (raw ?? {}) as Record<string, unknown>;
    if (m.kind !== undefined && m.kind !== "message") return null;
    return { source: "matrix", kind: "message", at: m.at, direction, text: m.text, ref: { eventId: m.eventId }, quote: m.quote, photo: m.photo };
  };
  return whatsappLinesOf([
    ...thread.map((t) => asItem(t, (t as Record<string, unknown>)?.direction)),
    ...burst.map((m) => asItem(m, "inbound")),
  ].filter(Boolean) as unknown[]);
}

/** crm-service: the bytes of a photo message (base64), for the brand whose line received it. */
export async function readWhatsappPhoto(
  args: { caller: CrmCaller; brandId: string; eventId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ base64: string; mimeType: string; sentAt: string | null; caption: string | null }> {
  const q = new URLSearchParams({ brandId: args.brandId, eventId: args.eventId });
  const res = await fetchImpl(`${env("CRM_SERVICE_URL")}/orgs/matrix/media?${q}`, {
    headers: crmHeaders(args.caller, args.brandId),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`crm-service GET /orgs/matrix/media ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text) as Record<string, unknown>;
  if (typeof json.base64 !== "string" || !json.base64) throw new Error(`crm-service GET /orgs/matrix/media answered no base64: ${text.slice(0, 200)}`);
  return { base64: json.base64, mimeType: String(json.mimeType ?? "image/jpeg"), sentAt: str(json.sentAt), caption: str(json.caption) };
}

/** crm-service: show (`start`) or end (`stop`) « typing… » in the person's WhatsApp, from the line that would answer. */
export async function setWhatsappTyping(
  args: { caller: CrmCaller; brandId: string; phone: string; state: "start" | "stop" },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(`${env("CRM_SERVICE_URL")}/orgs/whatsapp/typing`, {
    method: "POST",
    headers: crmHeaders(args.caller, args.brandId),
    body: JSON.stringify({ brandId: args.brandId, phone: args.phone, state: args.state }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`crm-service POST /orgs/whatsapp/typing (${args.state}) ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
}

export interface WhatsappMomentDeps {
  readPhoto: typeof readWhatsappPhoto;
}

/**
 * Everything the turn reads of the WhatsApp conversation: the labelled latest
 * messages and the photos of their messages since our last one (newest
 * TURN_IMAGES_MAX). A photo that cannot be read is named, never silently dropped.
 */
export async function readWhatsappMoment(
  args: { caller: CrmCaller; brandId: string; item: Record<string, unknown> | null | undefined },
  deps: WhatsappMomentDeps = { readPhoto: readWhatsappPhoto },
): Promise<WhatsappMoment> {
  const lines = whatsappLinesFromItem(args.item);
  const shown = labelLines(lines);
  const labels = new Map(shown.map((l) => [l.label, l.eventId]));
  const photos = theirLatest(lines).filter((l) => l.photo).slice(-TURN_IMAGES_MAX);
  const images: TurnImage[] = [];
  const unreadablePhotos: string[] = [];
  for (const p of photos) {
    try {
      const photo = await deps.readPhoto({ caller: args.caller, brandId: args.brandId, eventId: p.eventId });
      images.push(await prepareTurnImage(Buffer.from(photo.base64, "base64"), { at: p.at, caption: p.photo?.caption ?? photo.caption }));
    } catch (err) {
      console.error(`[chat-service] lead turn: photo ${p.eventId} could not be read: ${err instanceof Error ? err.message : String(err)}`);
      unreadablePhotos.push(p.eventId);
    }
  }
  return { shown, labels, images, unreadablePhotos };
}

/**
 * The moments of the lead turns this process is running, by lead turn id
 * (set by processLeadTurn before its /chat call, read by /chat, cleared after),
 * like the turn's caller (lead-contact.ts).
 */
const moments = new Map<string, WhatsappMoment>();

export function registerLeadTurnMoment(leadTurnId: string, moment: WhatsappMoment): void {
  moments.set(leadTurnId, moment);
}

export function leadTurnMoment(leadTurnId: string): WhatsappMoment | null {
  return moments.get(leadTurnId) ?? null;
}

export function forgetLeadTurnMoment(leadTurnId: string): void {
  moments.delete(leadTurnId);
}

/** The answer field a WhatsApp lead turn names the quoted message in (a label, mapped to `replyToEventId`). */
export const REPLY_TO_FIELD = "replyTo";
/** The field the caller reads: the event id of the message the answer quotes (crm `POST /orgs/whatsapp/messages` `replyToEventId`). */
export const REPLY_TO_EVENT_ID_FIELD = "replyToEventId";

/**
 * PURE: the answer as the caller receives it: the label the model wrote in
 * `replyTo` becomes `replyToEventId` (the message's event id); an empty or
 * unknown label quotes nothing.
 */
export function withReplyToEventId(answer: Record<string, unknown>, labels: ReadonlyMap<string, string>): Record<string, unknown> {
  const { [REPLY_TO_FIELD]: label, ...rest } = answer;
  const key = typeof label === "string" ? label.trim().toLowerCase() : "";
  const eventId = key ? labels.get(key) ?? null : null;
  if (key && !eventId) console.warn(`[chat-service] lead turn: replyTo "${key}" names no message of the turn: sent without a quote`);
  return { ...rest, [REPLY_TO_EVENT_ID_FIELD]: eventId };
}
