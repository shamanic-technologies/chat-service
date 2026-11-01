import type Anthropic from "@anthropic-ai/sdk";

/**
 * The messages of one Anthropic /chat turn, laid out so the prompt cache holds
 * (CHAT-COST-1101, prod 2026-11-01: ~60 Copilot replies billed ~$11 to a new
 * client, cache writes above cache reads).
 *
 * The cache is a PREFIX match: tools, then system, then messages. What changes
 * every turn (the page the user is on, their recent actions, a Lead event's
 * writer context) used to sit in the system prompt, so every turn rewrote the
 * whole prefix: 97 tool definitions, the skills and the history. It now rides
 * AFTER the user's message as a mid-conversation system message, still an
 * operator instruction for this turn only, and the system prompt stays the same
 * across turns and sessions of a config.
 *
 * The user's message carries its own cache breakpoint: the next turn rebuilds
 * the same history from the database (this turn's context message is not
 * stored), so the cache entry it reads must end on this message, before the
 * context. The system breakpoint and the automatic tail breakpoint make three
 * of the four the API allows.
 */
export function buildAnthropicTurnMessages(
  history: Anthropic.MessageParam[],
  userMessage: string,
  turnContext: string,
  cache: boolean,
): Anthropic.MessageParam[] {
  const user: Anthropic.MessageParam = cache
    ? { role: "user", content: [{ type: "text", text: userMessage, cache_control: { type: "ephemeral" } }] }
    : { role: "user", content: userMessage };
  const context = turnContext.trim();
  if (!context) return [...history, user];
  // `system` inside messages is the API's mid-conversation system message
  // (Sonnet 5.5, Opus 5.5, Fable 5.1); the SDK's MessageParam type lists it.
  const system = { role: "system", content: context } as unknown as Anthropic.MessageParam;
  return [...history, user, system];
}

/** The last message of the turn written by the user side (the user's message or tool results), never the context. */
export function lastUserMessage(messages: Anthropic.MessageParam[]): Anthropic.MessageParam | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return messages[i];
  return undefined;
}
