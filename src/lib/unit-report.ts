/**
 * SCRIPT-VALUE-RATING-1113-SOPHIE (owner 2026-11-13): a client telling Sophie
 * that something we made for them is not good reaches the Rating, whatever the
 * surface (« s'ils donnent le même feedback à Sophie quel que soit le canal »).
 *
 * `report_not_good` records ONE report of ONE Unit through the public gateway
 * route every surface uses (`POST /v1/features/unit-reports`, features-service
 * `POST /orgs/unit-reports`), as the person (their org and user are stored).
 * The Unit is named as the runs ledger names it: outcome key, subject service,
 * subject id, and `unitAt` when one subject holds several Units over time (a
 * lead holds every message written for them). `kind`: `edited` (the client
 * changed what we wrote, or had Sophie change it) or `reported` (they say it is
 * not good and it cannot be edited any more, a sent message).
 *
 * A reported Unit is worth nothing for the script that made it. Nothing is
 * blocked, rewritten or re-sent, so nothing asks the person's yes: the model
 * decides from their words (no keyword rule, no check on its answer). There is
 * no positive vote: silence says nothing.
 *
 * The same route answers `run_operation` too (an outside AI's path); this tool
 * exists because the gateway documents the body as free-form, so the fields
 * and the game are stated here, where Sophie reads them on every turn.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { failedCallAnswer } from "../agent/catalogue-tools.js";
import { apiServiceFetch, type ApiCallParams } from "./api-client.js";

export const REPORT_NOT_GOOD_TOOL_NAME = "report_not_good";

/** The gateway operation the tool calls (also named beside it in the skills). */
export const UNIT_REPORT_OPERATION = "POST /v1/features/unit-reports";
const UNIT_REPORT_PATH = "/v1/features/unit-reports";

export const UNIT_REPORT_KINDS = ["edited", "reported"] as const;
export type UnitReportKind = (typeof UNIT_REPORT_KINDS)[number];

/** Where the report was said, as the store's free-text `source` reads it. */
export type ReportSurface = "web" | "whatsapp" | "telegram" | "email";
const SURFACE_WORDS: Readonly<Record<ReportSurface, string>> = { web: "web chat", whatsapp: "WhatsApp", telegram: "Telegram", email: "email" };
export const reportSource = (surface: ReportSurface): string => `Sophie (${SURFACE_WORDS[surface]})`;

export const REPORT_NOT_GOOD_TOOL: Anthropic.Tool = {
  name: REPORT_NOT_GOOD_TOOL_NAME,
  description:
    "Record that a piece of work we made for the client is not good: a message we wrote to one of their leads, a text we drafted for their offer. " +
    "Use it whenever the client says, in any words, that something we made for them is wrong, off or not what they want, and whenever you change something we wrote because they asked (kind edited). " +
    "What it does: one report on that one piece. Several writers compete to do each job for them and the ones whose work clients keep are picked more, so the writer that made this piece is picked less and what we write next for them gets better. " +
    "What it does not do: it sends nothing to anyone, changes nothing the client sees, and rewrites or re-sends nothing; the piece stays as it is. So report in the same turn, with no question before it, and what you tell them stays true to that: we learn from it for what we write next. A change they also want is its own act. " +
    "There is no positive vote and silence means nothing: report only a piece they criticised or had changed. " +
    "Name the piece from a record you read this turn (the not-good skill says how). A message we wrote to a person: outcomeKey message_written, subjectService lead-service, subjectId the leadId on the person's row (GET /v1/leads?brandId=&q= their name), unitAt the date that message went out (occurredAt in their timeline: GET /v1/leads/{id}/timeline?brandId=, read by the row's id). A refusal comes back with its status and meaning.",
  input_schema: {
    type: "object" as const,
    properties: {
      outcomeKey: { type: "string", description: "What the piece is, as our ledger names it: message_written (a message we wrote to a person), offer_fields_drafted (the offer's texts we drafted)." },
      subjectService: { type: "string", description: "The service holding the piece's subject: lead-service for a message, brand-service for an offer's drafted texts." },
      subjectId: { type: "string", description: "The subject's id, as read this turn: the person's leadId (not their row id) for a message, the offerId for an offer's drafted texts." },
      kind: { type: "string", enum: [...UNIT_REPORT_KINDS], description: "reported = they say it is not good (a sent message cannot be edited). edited = what we wrote was changed at their request." },
      note: { type: "string", description: "What they said is wrong with it, in their own words." },
      unitAt: { type: "string", description: "When the piece they point at was made, as its record dates it (ISO date-time): the date a message went out. One person holds several messages, the date names the one they mean. Omit for a subject holding one piece." },
    },
    required: ["outcomeKey", "subjectService", "subjectId", "kind"],
  },
};

export interface UnitReportBody {
  outcomeKey: string;
  subjectService: string;
  subjectId: string;
  kind: UnitReportKind;
  source: string;
  note?: string;
  unitAt?: string;
}

function text(name: string, v: unknown, max: number, required: boolean): string | undefined {
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) {
    if (required) throw new Error(`[${REPORT_NOT_GOOD_TOOL_NAME}] ${name} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new Error(`[${REPORT_NOT_GOOD_TOOL_NAME}] ${name} must be a string`);
  const t = v.trim();
  if (t.length > max) throw new Error(`[${REPORT_NOT_GOOD_TOOL_NAME}] ${name} is longer than ${max} characters`);
  return t;
}

/** PURE: the gateway body for the model's arguments. The source is the surface's, never the model's. */
export function buildUnitReportBody(args: Record<string, unknown>, surface: ReportSurface): UnitReportBody {
  const kind = text("kind", args.kind, 20, true)!;
  if (!(UNIT_REPORT_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`[${REPORT_NOT_GOOD_TOOL_NAME}] kind is "edited" or "reported": there is no other report (no positive vote)`);
  }
  const unitAt = text("unitAt", args.unitAt, 64, false);
  if (unitAt !== undefined && Number.isNaN(Date.parse(unitAt))) {
    throw new Error(`[${REPORT_NOT_GOOD_TOOL_NAME}] unitAt must be the piece's own date as its record gives it (ISO date-time)`);
  }
  const note = text("note", args.note, 2000, false);
  return {
    outcomeKey: text("outcomeKey", args.outcomeKey, 200, true)!,
    subjectService: text("subjectService", args.subjectService, 200, true)!,
    subjectId: text("subjectId", args.subjectId, 200, true)!,
    kind: kind as UnitReportKind,
    source: reportSource(surface),
    ...(note ? { note } : {}),
    ...(unitAt ? { unitAt: new Date(unitAt).toISOString() } : {}),
  };
}

/** What a stored report means, said to the model beside it: the truth it may tell the person. */
export const REPORT_EFFECT =
  "Recorded. Nothing was sent to anyone, nothing the client sees changed, nothing is rewritten or re-sent: the piece stays as it is. It counts when we pick who writes next for them.";

/** PURE: the stored report as the model reads it (the ids it named and the proof it was stored). */
export function storedReportForModel(stored: unknown): Record<string, unknown> {
  const s = stored && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
  const keep = ["id", "outcomeKey", "subjectService", "subjectId", "kind", "unitAt", "reportedAt"] as const;
  return { reported: true, report: Object.fromEntries(keep.filter((k) => s[k] !== undefined).map((k) => [k, s[k]])), effect: REPORT_EFFECT };
}

/** Record one report as the person. A refusal answers as every gateway refusal does (status + meaning). */
export async function reportNotGood(args: Record<string, unknown>, params: ApiCallParams, surface: ReportSurface): Promise<unknown> {
  const body = buildUnitReportBody(args, surface);
  const res = await apiServiceFetch(UNIT_REPORT_PATH, "POST", params, body);
  const raw = await res.text();
  let data: unknown = raw;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    // a non-JSON answer is returned as text
  }
  if (!res.ok) return failedCallAnswer(res.status, data);
  return storedReportForModel(data);
}
