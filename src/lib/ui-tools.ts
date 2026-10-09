import type Anthropic from "@anthropic-ai/sdk";
import {
  ChoicesRecordSchema,
  OpenPageRecordSchema,
  type ChoicesRecord,
  type OpenPageRecord,
} from "../schemas.js";

// ---------------------------------------------------------------------------
// Rich-UI tools — the model drives the CLIENT's interface instead of a backend.
//
//   • present_choices — large clickable cards (label, one line, optional icon /
//     logo / big number / tiny chart). Ends the turn, exactly like
//     request_user_input: the clicked card's `value` comes back as the next
//     user message. Streamed as an SSE `choices` event and stored on the
//     assistant message so a reload re-renders it.
//   • open_page — asks the client to open a dashboard page in its side panel.
//     The CLIENT owns the page list and the URL mapping (it states the page ids
//     in the config's system prompt); this service only validates the shape.
//     Does not end the turn. SSE `open_page` event, stored on the message.
//
// Neither tool talks to another service, spends anything, or reaches a vendor.
// The arguments are validated with the same Zod schemas that document the SSE
// events (src/schemas.ts) — a malformed call throws, and the agentic loop
// hands the model a structured error so it can fix and retry (formatToolError).
// ---------------------------------------------------------------------------

export const PRESENT_CHOICES_TOOL_NAME = "present_choices";
export const OPEN_PAGE_TOOL_NAME = "open_page";

/**
 * Tools whose effect IS a dedicated client event, so the generic
 * `tool_call` / `tool_result` SSE pair is not streamed for them (the client
 * would render a tool card on top of the cards / panel it already shows).
 */
export const CLIENT_UI_TOOL_NAMES: ReadonlySet<string> = new Set([
  "request_user_input",
  PRESENT_CHOICES_TOOL_NAME,
  OPEN_PAGE_TOOL_NAME,
]);

/** What the model learns once its cards are on screen (replayed in history). */
export const CHOICES_PRESENTED_RESULT = {
  presented: true,
  note: "The cards are on screen and your turn is over. The user's pick (or their own words) arrives as their next message.",
} as const;

/**
 * Parse the model's present_choices arguments into the stored/streamed record.
 * A card without `value` sends its `label`; `allowFreeText` is true unless the
 * model said false. Throws (ZodError message) on anything else malformed.
 */
export function parseChoicesArgs(args: Record<string, unknown>): ChoicesRecord {
  const rawChoices = args.choices;
  const withValues = Array.isArray(rawChoices)
    ? rawChoices.map((c) =>
        c && typeof c === "object" && !("value" in c && (c as { value?: unknown }).value)
          ? { ...(c as Record<string, unknown>), value: (c as { label?: unknown }).label }
          : c,
      )
    : rawChoices;
  const parsed = ChoicesRecordSchema.safeParse({
    ...(args.question !== undefined ? { question: args.question } : {}),
    choices: withValues,
    allowFreeText: args.allowFreeText !== false,
  });
  if (!parsed.success) {
    throw new Error(`[present_choices] invalid arguments: ${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data;
}

/** Parse the model's open_page arguments. Throws on a malformed call. */
export function parseOpenPageArgs(args: Record<string, unknown>): OpenPageRecord {
  const parsed = OpenPageRecordSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`[open_page] invalid arguments: ${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data;
}

const VISUAL_PROPERTY = {
  type: "object",
  description:
    "Optional visual on the card. Pick ONE type and fill its fields: " +
    "icon → `icon` (a short icon name such as 'mail', 'rocket', 'users', 'chart', 'pause', 'play', 'wallet', 'reply'); " +
    "image → `imageUrl` (a logo or picture URL, https); " +
    "number → `value` + optional `unit` (a big figure EXACTLY as a tool returned it — never compute, round or estimate a figure yourself); " +
    "chart → `series` (2-60 numbers, oldest first, as a tool returned them) + optional `unit`.",
  properties: {
    type: { type: "string", enum: ["icon", "image", "number", "chart"] },
    icon: { type: "string", description: "Icon name (type=icon)." },
    imageUrl: { type: "string", description: "Logo/image URL (type=image)." },
    value: { type: "string", description: "The figure as served, e.g. '12' or '$48.20' (type=number)." },
    unit: { type: "string", description: "Unit beside the figure or series, e.g. 'replies', '$/day'." },
    series: { type: "array", items: { type: "number" }, description: "Sparkline values (type=chart)." },
  },
  required: ["type"],
};

export const PRESENT_CHOICES_TOOL: Anthropic.Tool = {
  name: PRESENT_CHOICES_TOOL_NAME,
  description:
    "Show the user 2 to 6 large clickable cards to pick their next step, instead of asking in plain text. " +
    "Prefer this whenever the user has a decision to make or you are suggesting what to do next. " +
    "Each card: a short `label`, an optional one-line `description`, an optional `visual`, and the `value` sent back when clicked " +
    "(write it as the sentence the user would type, e.g. 'Show me the 3 interested leads'; defaults to the label). " +
    "Any figure on a card must come from a tool result in this conversation, quoted as served. " +
    "Call it LAST, once: it ENDS your turn and the user's pick arrives as their next message. " +
    "Write at most one short sentence of text before it; never repeat the cards as text or as '- [Label]' lines.",
  input_schema: {
    type: "object" as const,
    properties: {
      question: { type: "string", description: "Optional short heading above the cards." },
      choices: {
        type: "array",
        minItems: 2,
        maxItems: 6,
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "Main line, max 80 characters." },
            description: { type: "string", description: "Optional one line, max 160 characters." },
            value: { type: "string", description: "Message sent when clicked. Defaults to the label." },
            visual: VISUAL_PROPERTY,
          },
          required: ["label"],
        },
      },
      allowFreeText: {
        type: "boolean",
        description: "Keep the free-text box available beside the cards. Defaults to true.",
      },
    },
    required: ["choices"],
  },
};

export const OPEN_PAGE_TOOL: Anthropic.Tool = {
  name: OPEN_PAGE_TOOL_NAME,
  description:
    "Open a dashboard page in the panel beside the chat, to show the user what you are talking about. " +
    "`page` is one of the page identifiers listed in your instructions — never a URL, never an invented id. " +
    "Pass the ids the page needs (brandId, offerId, campaignId, audienceId, leadId), taken from tool results. " +
    "Does not end your turn: keep answering after it. Open at most one page per answer.",
  input_schema: {
    type: "object" as const,
    properties: {
      page: { type: "string", description: "Page identifier from your instructions." },
      brandId: { type: "string", description: "Brand id, when the page is about a brand." },
      offerId: { type: "string", description: "Offer id, when the page is about an offer." },
      campaignId: { type: "string", description: "Campaign id, when the page is about a campaign." },
      audienceId: { type: "string", description: "Audience id, when the page is about an audience." },
      leadId: { type: "string", description: "Lead id, when the page is about one person." },
      title: { type: "string", description: "Optional short caption, max 80 characters." },
    },
    required: ["page"],
  },
};
