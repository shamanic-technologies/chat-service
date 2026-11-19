// ---------------------------------------------------------------------------
// The tools of a turn, keyed on WHO the person is, never on the channel
// (DISTRY-ONE-AI-1118, owner 2026-11-18: « Je veux une unique AI quel que soit
// le canal »).
//
// Before, the website gave a visitor 2 tools and WhatsApp gave a guest 2 others,
// with two pasted skills instead of the index: the same person got a different
// assistant per channel. Now:
//
//  - an ACCOUNT gets the config's tools, on every channel;
//  - a GUEST (no account of ours acts in the turn) gets the same short list on
//    every channel: the skills, cards, and the sign-in pair wherever a session
//    can become theirs. A guest turn runs under distribute.you's own identity,
//    so nothing that reads or acts on an ACCOUNT is in it (no follow-up, no
//    staff request).
//  - where the session can become theirs, a guest also gets the API tools an
//    account uses (increment B, owner plan 2026-11-19): their plan is built on
//    the unclaimed org opened for the conversation (lib/guest-plan.ts), and
//    every call is refused on the server outside the signup page's allowlist.
//
// What a channel adds is a DELIVERY fact only (the website's hand-off tool).
// The site reader joins after (person-facing.ts), for both.
// ---------------------------------------------------------------------------
import { SIGN_IN_TOOL_NAMES } from "../lib/channel-sign-in.js";
import { CATALOGUE_TOOL_NAMES } from "./catalogue-tools.js";

/** The website's delivery tool (web-visitor.ts owns its definition). */
export const WEB_CONTINUE_TOOL_NAME = "continue_on_channel";

/** What a guest may use among the config's tools: nothing here touches an account. */
export const GUEST_CONFIG_TOOLS: readonly string[] = ["read_skill", "present_choices"];

export interface PersonTurn {
  /** The config's tools (staff filter and account setup already applied). */
  configTools: readonly string[];
  /** No account of ours acts in this turn. */
  guest: boolean;
  /** The session can be re-keyed to an account here (a number or a website visitor is tied to it). */
  canSignIn: boolean;
  /** The turn answers in the chat of our website. */
  website: boolean;
}

export function sessionToolNamesFor(turn: PersonTurn): string[] {
  const signIn = turn.canSignIn ? SIGN_IN_TOOL_NAMES.filter((t) => !turn.configTools.includes(t)) : [];
  if (!turn.guest) return [...turn.configTools, ...signIn];
  // Their plan needs a session that can become theirs (the email proof hands its org over).
  const plan = turn.canSignIn ? CATALOGUE_TOOL_NAMES.filter((t) => turn.configTools.includes(t)) : [];
  return [
    ...GUEST_CONFIG_TOOLS.filter((t) => turn.configTools.includes(t)),
    ...plan,
    ...signIn,
    ...(turn.website ? [WEB_CONTINUE_TOOL_NAME] : []),
  ];
}
