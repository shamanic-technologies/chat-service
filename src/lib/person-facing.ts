// ---------------------------------------------------------------------------
// What a chat that speaks to a person for distribute.you knows about itself
// (CHAT-TRUTH-1101, prod 2026-11-01). Such a chat is one whose config reads our
// skills (`read_skill`): the web Copilot, WhatsApp, a lead turn on our brand.
//
// - It reads our public site (`read_our_website`), even when its config was
//   registered before the tool existed: the config owner (the dashboard) lists
//   the account tools, the site reader comes with speaking for us.
// - It knows which model it runs on. Prod 2026-11-01: asked "which AI are
//   you?", it answered "I can't tell you which AI model runs underneath";
//   model names are public and we encourage saying them (owner). A FACT from
//   the served model, never a policy text.
// ---------------------------------------------------------------------------

export const READ_OUR_WEBSITE_TOOL_NAME = "read_our_website";

/** The turn's tools, plus the site reader when this chat speaks for us (never twice). */
export function withOurWebsite(toolNames: readonly string[], speaksForUs: boolean): string[] {
  if (!speaksForUs || toolNames.includes(READ_OUR_WEBSITE_TOOL_NAME)) return [...toolNames];
  return [...toolNames, READ_OUR_WEBSITE_TOOL_NAME];
}

/** One fact appended to the system prompt: the model this turn runs on, by its public name. */
export function aboutYouBlock(modelDisplayName: string): string {
  return `\n\n---\n## You\nYou are an AI agent running on ${modelDisplayName}. That name is public: give it when someone asks which AI or model you are.`;
}
