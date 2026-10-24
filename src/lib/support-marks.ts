// Support marks (COST-SUPPORT-1024): spend that produces no outcome BY DESIGN is
// marked on its run at creation (runs-service `support` body field), so the
// production-cost ledger reports it apart, per support function, and never
// lets it ride an outcome. Names copied byte-equal from runs-service
// `SUPPORT_FUNCTIONS` (src/schemas.ts).
//
// The rule that decides: a run made ON BEHALF of a caller run (a parent) is
// never marked here. That caller may be producing an outcome (writing an email,
// judging a reply) and the spend belongs to it; only the caller knows.

export type SupportFunction =
  | "payment_fees"
  | "brand_setup"
  | "copilot"
  | "platform_llm"
  | "staff_experiment"
  | "product_feature"
  | "retired_product";

export interface RunSupport {
  kind: SupportFunction;
  reason: string;
}

export const PLATFORM_LLM_SUPPORT: RunSupport = {
  kind: "platform_llm",
  reason: "chat-service platform LLM / judgment / image / transcription call made for no caller run",
};

export const COPILOT_SUPPORT: RunSupport = {
  kind: "copilot",
  reason: "chat-service Copilot turn (web or WhatsApp): talks with the customer, produces no outcome",
};

/** A platform call is support only when no caller run stands behind it. */
export function platformCallSupport(parentRunId: string | undefined): RunSupport | undefined {
  return parentRunId ? undefined : PLATFORM_LLM_SUPPORT;
}

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
