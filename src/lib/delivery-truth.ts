// ---------------------------------------------------------------------------
// Did the message leave? (CHAT-TRUTH-1101, prod 2026-11-01)
//
// A Copilot tool that asks campaign-service to send something (fire_followup,
// confirm_switch_on push_email) gets back a trigger event. Its `outcome: "ran"`
// means a RUN STARTED, not that an email left: the 2026-11-01 follow-up fired
// at 12:54 answered `ran` with `delivery: null`, the Copilot told a client "I've
// just emailed you, reply to that email", and nothing was ever sent. At 12:42
// the same fire was `skipped` (cohort_run_in_flight) and it still promised one.
//
// So the tool result states the message's state in one closed vocabulary the
// model cannot misread, derived from campaign-service's served fields only:
//   sent       — campaign-service's `delivery.state` is `delivered`
//   on_its_way — due, filed, or a run is writing it: nothing confirms it left
//   not_sent   — skipped, refused or failed: nothing went out
// `sent` is never inferred from `outcome`. An event shape this does not know
// reads `on_its_way`, never `sent`.
// ---------------------------------------------------------------------------

export type MessageState = "sent" | "on_its_way" | "not_sent";

export interface MessageVerdict {
  messageState: MessageState;
  sent: boolean;
  /** campaign-service's own reason, verbatim, when there is one. */
  why: string | null;
  meaning: string;
}

export interface ServedEvent {
  id?: string | null;
  status?: string | null;
  outcome?: string | null;
  skipReason?: string | null;
  lastError?: string | null;
  delivery?: { state?: string; refusals?: { code?: string; reason?: string }[] } | null;
}

const MEANING: Record<MessageState, string> = {
  sent: "The message left: the sender accepted it.",
  on_its_way:
    "Not sent yet. It is queued or being written; nothing confirms it left. Until a later read says sent, the person has received nothing: never say it was sent, and never tell them to reply to it.",
  not_sent: "Nothing was sent and nothing will go out for this request. The person has received nothing.",
};

function verdict(messageState: MessageState, why: string | null): MessageVerdict {
  return { messageState, sent: messageState === "sent", why, meaning: MEANING[messageState] };
}

/** The message's state from a campaign-service trigger event (the event object, not its envelope). */
export function messageVerdict(event: ServedEvent | null | undefined): MessageVerdict {
  if (!event) return verdict("on_its_way", "no event was returned");
  const d = event.delivery?.state;
  if (d === "delivered") return verdict("sent", null);
  if (event.outcome === "skipped" || event.outcome === "failed" || event.outcome === "refused" || d === "refused" || d === "failed" || d === "skipped") {
    const refusal = event.delivery?.refusals?.[0];
    return verdict("not_sent", event.skipReason ?? refusal?.reason ?? event.lastError ?? event.outcome ?? d ?? null);
  }
  if (event.status === "pending") return verdict("on_its_way", "due later");
  if (d === "unconfirmed") return verdict("on_its_way", "a run was recorded but never reported back");
  if (event.outcome === "ran") return verdict("on_its_way", "a run that writes and sends it has started");
  return verdict("on_its_way", event.status ? `event ${event.status}` : null);
}
