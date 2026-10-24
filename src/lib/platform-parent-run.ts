import type { Request } from "express";
import { RunsServiceError } from "./runs-client.js";
import { z } from "zod";
import { SUPPORT_FUNCTIONS, type RunSupport } from "./support-marks.js";

/**
 * A platform call (`/internal/platform-complete`, `/internal/platform-judgments`)
 * may be made ON BEHALF of a caller's run: the caller sends that run's id in
 * `x-run-id`, and the platform run chat-service opens becomes its child, so the
 * spend rolls into the caller's subtree and reaches the outcome the caller
 * declares (COST-ACCOUNTING-1023). Who pays does not change: the run stays
 * platform-billed. No header = a root platform run, exactly as before.
 *
 * chat-service produces no outcome of its own here and never declares one.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ParentRunRead =
  | { ok: true; parentRunId: string | undefined }
  | { ok: false; status: 400; body: { error: string; retryable: false } };

export function readPlatformParentRunId(req: Request): ParentRunRead {
  const raw = req.headers["x-run-id"];
  if (raw === undefined) return { ok: true, parentRunId: undefined };
  if (typeof raw !== "string" || !UUID_RE.test(raw)) {
    return {
      ok: false,
      status: 400,
      body: { error: "x-run-id must be the UUID of the caller's run (or omitted)", retryable: false },
    };
  }
  return { ok: true, parentRunId: raw };
}

/**
 * The response for a platform run runs-service would not create. A 4xx while a
 * parent was named means runs-service refused THAT parent (unknown run): the
 * caller sent a wrong id, retrying will not help, so it is a 400 carrying
 * runs-service's words. Everything else stays the retryable 502 it always was.
 */
export function platformRunCreateFailure(
  err: unknown,
  parentRunId: string | undefined,
): { status: 400 | 502; body: Record<string, unknown> } {
  if (parentRunId && err instanceof RunsServiceError && err.status >= 400 && err.status < 500) {
    return {
      status: 400,
      body: {
        error: `runs-service refused x-run-id "${parentRunId}" as the parent run`,
        detail: err.body,
        retryable: false,
      },
    };
  }
  return {
    status: 502,
    body: { error: "Service temporarily unavailable (run tracking). Please try again." },
  };
}

export const PlatformCallerSupportSchema = z
  .object({
    kind: z.enum(SUPPORT_FUNCTIONS),
    reason: z.string().min(1).max(2000),
  })
  .strict();

export type PlatformCallerRead =
  | { ok: true; parentRunId: string | undefined; support: RunSupport | undefined; body: unknown }
  | { ok: false; status: 400; body: { error: string; detail?: unknown; retryable: false } };

/**
 * Every platform call states WHOSE work it is (COST-SUPPORT-1024): the caller's
 * run in `x-run-id` (the spend rides that run's outcome), or, for a call no run
 * stands behind, the support function it serves in the body `support` field
 * (reported apart, never on an outcome). Both at once is refused: work done
 * for a run is that run's, never support. `body` is the request body without
 * `support`, ready for the route's own schema.
 *
 * A call stating NEITHER is refused (400) before any spend: chat-service never
 * guesses whose work it is (owner 2026-10-24 « make sure ça n'arrive plus »).
 */
export function readPlatformCaller(req: Request, path: string): PlatformCallerRead {
  const parent = readPlatformParentRunId(req);
  if (!parent.ok) return parent;
  const raw = (req.body ?? {}) as Record<string, unknown>;
  const { support: rawSupport, ...body } = raw;
  if (rawSupport === undefined) {
    if (!parent.parentRunId) {
      return {
        ok: false,
        status: 400,
        body: {
          error: `${path}: say whose work this call is: x-run-id (your run doing the work) or body support {kind, reason} (a support function no run stands behind)`,
          retryable: false,
        },
      };
    }
    return { ok: true, parentRunId: parent.parentRunId, support: undefined, body };
  }
  const support = PlatformCallerSupportSchema.safeParse(rawSupport);
  if (!support.success) {
    return {
      ok: false,
      status: 400,
      body: { error: "support must be {kind, reason}, kind one of the support functions", detail: support.error.flatten(), retryable: false },
    };
  }
  if (parent.parentRunId) {
    return {
      ok: false,
      status: 400,
      body: { error: "Send x-run-id OR support, never both: a call made for a caller run is that run's work", retryable: false },
    };
  }
  return { ok: true, parentRunId: undefined, support: support.data, body };
}
