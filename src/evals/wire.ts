// ---------------------------------------------------------------------------
// What the eval replay really put on the wire (SOPHIE-MODEL-BAKEOFF-1113).
//
// A setting stated in code can be absent from the request: DeepSeek's
// reasoning-off flag was never sent until 2026-11-12, so the 11-02 off-vs-on
// run compared identical wires. Every model request of a run is read here, at
// the fetch boundary, and the run stores the settings each request carried
// (model, thinking, effort, reasoning field, output cap, images, betas), so a
// result names the wire it ran on, never the flag that was meant.
// Request bodies are summarised, never stored (they carry the scenario).
// ---------------------------------------------------------------------------

/** The settings of one model request that decide how it thinks and what it reads. */
export interface WireSettings {
  host: string;
  model: unknown;
  thinking: unknown;
  outputConfig: unknown;
  /** OpenAI-compatible reasoning fields (`thinking` on DeepSeek is above; `reasoning_effort` here). */
  reasoningEffort: unknown;
  maxOutputTokens: unknown;
  contextManagement: boolean;
  betas: string | null;
}

export interface WireReport {
  requests: number;
  /** Distinct settings and how many requests carried each. */
  settings: Array<{ settings: WireSettings; requests: number }>;
  requestsWithImages: number;
  requestsWithToolsOff: number;
}

const MODEL_HOSTS = ["api.anthropic.com", "api.deepseek.com", "api.z.ai", "api.moonshot.ai", "api.openai.com", "generativelanguage.googleapis.com"];

function headerValue(headers: unknown, name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) return (headers.find(([k]) => String(k).toLowerCase() === name)?.[1] as string | undefined) ?? null;
  const entry = Object.entries(headers as Record<string, string>).find(([k]) => k.toLowerCase() === name);
  return entry ? String(entry[1]) : null;
}

function hasImage(body: Record<string, unknown>): boolean {
  const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.contents) ? body.contents : [];
  return JSON.stringify(messages).match(/"type":"(image|image_url)"|"inlineData"/) !== null;
}

/** One request's settings, read from its URL, headers and JSON body. */
export function readWireSettings(url: string, headers: unknown, body: Record<string, unknown>): WireSettings {
  return {
    host: new URL(url).host,
    model: body.model ?? null,
    thinking: body.thinking ?? (body.generationConfig as { thinkingConfig?: unknown } | undefined)?.thinkingConfig ?? null,
    outputConfig: body.output_config ?? null,
    reasoningEffort: body.reasoning_effort ?? (body.reasoning as { effort?: unknown } | undefined)?.effort ?? null,
    maxOutputTokens: body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens ?? null,
    contextManagement: body.context_management != null,
    betas: headerValue(headers, "anthropic-beta"),
  };
}

/** Record every model request made through fetch from now on. */
export function recordWire(): { report: () => WireReport } {
  const seen = new Map<string, { settings: WireSettings; requests: number }>();
  let requests = 0;
  let withImages = 0;
  let toolsOff = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (MODEL_HOSTS.some((h) => url.includes(h)) && typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if (body.messages || body.contents || body.input) {
          requests++;
          if (hasImage(body)) withImages++;
          const choice = body.tool_choice as { type?: string } | string | undefined;
          if (choice === "none" || (typeof choice === "object" && choice?.type === "none")) toolsOff++;
          const settings = readWireSettings(url, init.headers, body);
          const key = JSON.stringify(settings);
          const row = seen.get(key) ?? { settings, requests: 0 };
          row.requests++;
          seen.set(key, row);
        }
      } catch {
        // Not a JSON model request (an upload, a probe): nothing to read.
      }
    }
    return original(input as RequestInfo, init);
  }) as typeof fetch;
  return {
    report: () => ({ requests, settings: [...seen.values()].sort((a, b) => b.requests - a.requests), requestsWithImages: withImages, requestsWithToolsOff: toolsOff }),
  };
}
