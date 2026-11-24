// ---------------------------------------------------------------------------
// Which providers have a platform key: one in-memory fact (OPEN-LLM-FREE-1124)
//
// A provider can be served by this code before anyone registered its platform
// key in key-service (Cerebras and Groq shipped that way). Two readers must not
// pick such a provider:
//   - the fallback orders (`fallbackOrderFor`, Distry's `rankFallbacks`): a
//     model with no key can serve nothing;
//   - `servedLlmsFor` (GET /internal/local-llm/served-llms): workflow-service
//     must never draw a script whose LLM chat-service cannot call.
//
// Generic: no provider is named here. Read from key-service's own list every
// REFRESH_MS; never read = every provider is assumed present (nothing changes
// for a live provider at boot); a failed read keeps the last answer.
// ---------------------------------------------------------------------------

import { listPlatformKeyProviders } from "./key-client.js";

export const PLATFORM_KEY_REFRESH_MS = 5 * 60_000;

/** Providers with a platform key at the last successful read; null = never read. */
let present: ReadonlySet<string> | null = null;

/** True only when the last successful read showed NO platform key for this provider. */
export function providerHasNoPlatformKey(provider: string): boolean {
  return present !== null && !present.has(provider);
}

/** Install the fact (the key-service read, or a test fixture); null = never read. */
export function setPlatformKeyProviders(providers: readonly string[] | null): void {
  present = providers === null ? null : new Set(providers);
}

/** Read the list from key-service. A failed read keeps the previous answer, loudly. */
export async function refreshPlatformKeyPresence(read: () => Promise<string[]> = listPlatformKeyProviders): Promise<void> {
  try {
    setPlatformKeyProviders(await read());
  } catch (err) {
    console.error(
      `[chat-service] [platform-keys] the platform key list is unreadable (${present ? "keeping the last read" : "every provider assumed to have a key"}):`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Why a provider cannot serve for lack of a platform key, in words; null while it has one (or is unknown). */
export function missingPlatformKeySentence(provider: string, label: string): string | null {
  if (!providerHasNoPlatformKey(provider)) return null;
  return `${label} has no platform key registered in key-service yet: no call can run on it.`;
}
