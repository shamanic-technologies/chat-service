// Support marks (COST-SUPPORT-1024): spend that produces no outcome BY DESIGN is
// marked on its run at creation (runs-service `support` body field), so the
// production-cost ledger reports it apart, per support function, and never
// lets it ride an outcome. Names copied byte-equal from runs-service
// `SUPPORT_FUNCTIONS` (src/schemas.ts).
//
// A platform call is marked only when its CALLER declares the function
// (`readPlatformCaller`): chat-service never guesses, a run made for a caller
// run is that caller's work (it may be writing an email, judging a reply).

export const SUPPORT_FUNCTIONS = [
  "payment_fees",
  "brand_setup",
  "copilot",
  "platform_llm",
  "staff_experiment",
  "product_feature",
  "retired_product",
] as const;

export type SupportFunction = (typeof SUPPORT_FUNCTIONS)[number];

export interface RunSupport {
  kind: SupportFunction;
  reason: string;
}

export const COPILOT_SUPPORT: RunSupport = {
  kind: "copilot",
  reason: "chat-service Copilot turn (web or WhatsApp): talks with the customer, produces no outcome",
};

/**
 * A `/chat` turn is support when it is the Copilot speaking with the customer.
 * A proactive turn is asked by a campaign step (its run may declare an outcome),
 * so it rides that step; any other config is left to its caller.
 */
export function chatTurnSupport(args: {
  configKey: string | null | undefined;
  copilotConfigKey: string;
  proactiveTurnId: string | undefined;
}): RunSupport | undefined {
  if (args.proactiveTurnId) return undefined;
  return args.configKey === args.copilotConfigKey ? COPILOT_SUPPORT : undefined;
}
