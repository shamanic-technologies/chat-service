// ---------------------------------------------------------------------------
// The company's financials for Distry as CEO (DISTRY-PRINCIPAL-1119, owner
// 2026-11-19: « He needs to access all financials of the company via tools,
// including the costs, revenue, margin of each client, either per list, or
// stats aggregated »).
//
// The figures are features-service's (`GET /internal/stats/client-financials`):
// per client and fleet totals, money net (what the client pays) first and
// before discount beside it. Nothing is computed here: the tool picks which
// rows the model reads (a sort and a limit) and keeps their fields compact.
// Staff conversations only (principal-tools.ts).
// ---------------------------------------------------------------------------

import type Anthropic from "@anthropic-ai/sdk";
import { READ_COMPANY_FINANCIALS_TOOL_NAME } from "./principal-tools.js";

export const READ_COMPANY_FINANCIALS_TOOL: Anthropic.Tool = {
  name: READ_COMPANY_FINANCIALS_TOOL_NAME,
  description:
    "The company's financials, as features-service serves them: per client, what they paid us (revenue), what serving them cost us (vendor spend and card fees), the margin and margin %, and the totals for the whole company. " +
    "Money is net (what the client pays after discount) with the amount before discount beside it. A client with no margin carries why (vendor cost unknown). " +
    "Read before deciding or advising anything about money, clients or where to put effort.",
  input_schema: {
    type: "object",
    properties: {
      sortBy: { type: "string", enum: ["revenue", "margin", "cost"], description: "Which clients come first (default revenue, highest first; margin = lowest first, to see who loses money)." },
      limit: { type: "integer", description: "How many clients (default 15, at most 40). The totals always cover every client." },
      orgId: { type: "string", description: "One client only (its org id)." },
    },
  },
};

export type FeaturesFetch = (path: string) => Promise<Response>;

export function featuresFetchFromEnv(env: NodeJS.ProcessEnv = process.env): FeaturesFetch {
  const base = (env.FEATURES_SERVICE_URL ?? "").replace(/\/$/, "");
  const key = env.FEATURES_SERVICE_API_KEY ?? "";
  if (!base || !key) throw new Error("FEATURES_SERVICE_URL / FEATURES_SERVICE_API_KEY not configured: the financials cannot be read");
  return (path) => fetch(`${base}${path}`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(120_000) });
}

type Row = Record<string, unknown>;
const money = (v: unknown): number | null => (v && typeof v === "object" && typeof (v as { net?: unknown }).net === "number" ? (v as { net: number }).net : null);
const costTotal = (r: Row): number | null => {
  const c = r.costUsd as { total?: unknown } | undefined;
  return c && typeof c.total === "number" ? c.total : null;
};

/** One client, compact: who, revenue, cost, margin (each with its basis). */
export function clientLine(r: Row): Row {
  return {
    orgId: r.orgId,
    client: r.orgName ?? null,
    customerStatus: r.customerStatus ?? null,
    ...(r.agency === true ? { agency: true } : {}),
    revenueUsd: r.revenueUsd ?? null,
    costUsd: r.costUsd ?? null,
    marginUsd: r.marginUsd ?? null,
    marginPct: r.marginPct ?? null,
    ...(r.marginUnavailableReason ? { marginUnavailableReason: r.marginUnavailableReason } : {}),
    cashPaidUsd: r.cashPaidUsd ?? null,
    creditGivenUsd: r.creditGivenUsd ?? null,
    balanceUsd: r.balanceUsd ?? null,
  };
}

export async function readCompanyFinancials(args: Record<string, unknown>, fetchImpl: FeaturesFetch): Promise<Record<string, unknown>> {
  const res = await fetchImpl("/internal/stats/client-financials");
  const text = await res.text();
  if (!res.ok) throw new Error(`[${READ_COMPANY_FINANCIALS_TOOL_NAME}] features-service ${res.status}: ${text.slice(0, 300)}`);
  const body = JSON.parse(text) as Record<string, unknown>;
  const rows = body.clients;
  if (!Array.isArray(rows) || !body.totals || typeof body.totals !== "object") {
    throw new Error(`[${READ_COMPANY_FINANCIALS_TOOL_NAME}] features-service answered no clients or totals: ${text.slice(0, 300)}`);
  }
  // What the figures stand on (period, basis, exclusions...): every top-level fact but the rows.
  const basis = Object.fromEntries(Object.entries(body).filter(([k]) => k !== "clients" && k !== "totals"));
  const orgId = typeof args.orgId === "string" && args.orgId.trim() ? args.orgId.trim() : null;
  if (orgId) {
    const one = (rows as Row[]).find((r) => r.orgId === orgId);
    return { ...basis, totals: body.totals, client: one ? clientLine(one) : null, ...(one ? {} : { note: `No client ${orgId} in the financials.` }) };
  }
  const sortBy = args.sortBy === "margin" || args.sortBy === "cost" ? args.sortBy : "revenue";
  const limit = Math.min(typeof args.limit === "number" && Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 15, 40);
  const key = (r: Row): number | null => (sortBy === "revenue" ? money(r.revenueUsd) : sortBy === "margin" ? money(r.marginUsd) : costTotal(r));
  const sorted = [...(rows as Row[])].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka === null && kb === null) return 0;
    if (ka === null) return 1;
    if (kb === null) return -1;
    return sortBy === "margin" ? ka - kb : kb - ka;
  });
  return {
    ...basis,
    totals: body.totals,
    sortedBy: sortBy === "margin" ? "margin, lowest first" : `${sortBy}, highest first`,
    clientsShown: Math.min(limit, sorted.length),
    clientsInTotals: rows.length,
    clients: sorted.slice(0, limit).map(clientLine),
  };
}
