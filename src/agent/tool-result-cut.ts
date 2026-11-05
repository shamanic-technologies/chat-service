// ---------------------------------------------------------------------------
// A tool answer too big for the turn is CUT, keeping its NEWEST part, and says
// it was cut (SOPHIE-TRUTH-1105, prod 2026-11-04 Beyond Logic: a conversation
// read came back cut from its start, oldest first, so the three answers we had
// sent Edmund Bartlett were the part dropped and Sophie told the client three
// times that nobody had answered him).
//
// The cut acts on the answer's biggest list: its items are ranked by the date
// they carry (the first date field found on most of them), the newest are kept
// in their served order, the oldest go. A list whose items carry no date keeps
// its first items as served (lists we serve undated are newest first). An
// answer with no list is cut to its first characters. Whatever happens, the
// answer says what was cut, so a missing item is never read as absent.
// ---------------------------------------------------------------------------

type Json = unknown;

/** Fields a served item dates itself with, in the order they are trusted. */
export const ITEM_DATE_FIELDS = [
  "timestamp", "occurredAt", "sentAt", "receivedAt", "createdAt", "updatedAt", "lastActivityAt", "date", "at",
] as const;

const isObj = (v: Json): v is Record<string, Json> => !!v && typeof v === "object" && !Array.isArray(v);
const size = (v: Json): number => JSON.stringify(v)?.length ?? 0;

/** The biggest array in the answer (top level or nested, up to 4 levels), with its path. */
function biggestList(v: Json, path: string[] = [], depth = 0): { path: string[]; list: Json[] } | null {
  let best: { path: string[]; list: Json[]; size: number } | null = null;
  const consider = (p: string[], list: Json[]) => {
    const s = size(list);
    if (list.length > 1 && (!best || s > best.size)) best = { path: p, list, size: s };
  };
  if (Array.isArray(v)) consider(path, v);
  if (depth < 4) {
    const children: Array<[string, Json]> = Array.isArray(v) ? [] : isObj(v) ? Object.entries(v) : [];
    for (const [k, child] of children) {
      const found = biggestList(child, [...path, k], depth + 1);
      if (found) consider(found.path, found.list);
    }
  }
  return best ? { path: (best as { path: string[] }).path, list: (best as { list: Json[] }).list } : null;
}

/** The date field most items carry, or null when fewer than half carry one. */
function dateFieldOf(list: Json[]): string | null {
  for (const f of ITEM_DATE_FIELDS) {
    const dated = list.filter((i) => isObj(i) && typeof i[f] === "string" && !Number.isNaN(Date.parse(i[f] as string))).length;
    if (dated * 2 >= list.length) return f;
  }
  return null;
}

function withList(v: Json, path: string[], list: Json[]): Json {
  if (path.length === 0) return list;
  const [head, ...rest] = path;
  return { ...(v as Record<string, Json>), [head]: withList((v as Record<string, Json>)[head], rest, list) };
}

export interface CutNotice {
  cut: true;
  /** Where the cut list sits in the answer ("messages", "data.leads"); "" = the answer itself. */
  list: string;
  kept: number;
  of: number;
  note: string;
}

/**
 * The answer as is when it fits `max` characters; else the answer with its biggest list cut
 * to the newest items that fit, plus a `cut` notice. Pure: the same answer always cuts the same way.
 */
export function cutKeepingNewest(v: Json, max: number): Json {
  if (size(v) <= max) return v;
  const found = biggestList(v);
  if (found) {
    const field = dateFieldOf(found.list);
    const order = found.list.map((item, i) => ({ item, i, t: field && isObj(item) ? Date.parse(String(item[field])) : NaN }));
    // Newest first when dated (undated items last); served order otherwise.
    const ranked = field ? [...order].sort((a, b) => (Number.isNaN(b.t) ? -1 : Number.isNaN(a.t) ? 1 : b.t - a.t)) : order;
    const keepOf = (k: number) => ranked.slice(0, k).sort((a, b) => a.i - b.i).map((x) => x.item);
    const shell = (k: number): Json => {
      const listName = found.path.join(".");
      const which = field ? `the ${k} newest (by ${field})` : `the first ${k}, as served`;
      const notice: CutNotice = {
        cut: true,
        list: listName,
        kept: k,
        of: found.list.length,
        note: `This answer was too long and was cut: ${listName || "the list"} keeps ${which} of ${found.list.length}; the other ${found.list.length - k} are not shown here. Never read an item missing here as absent: narrow the request (a filter, a limit, one id) to read it.`,
      };
      const cutAnswer = withList(v, found.path, keepOf(k));
      return Array.isArray(cutAnswer) ? { ...notice, items: cutAnswer } : { ...notice, ...(cutAnswer as Record<string, Json>) };
    };
    let lo = 0;
    let hi = found.list.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (size(shell(mid)) <= max) lo = mid;
      else hi = mid - 1;
    }
    const best = shell(lo);
    if (lo > 0 && size(best) <= max) return best;
  }
  const s = JSON.stringify(v);
  return {
    cut: true,
    list: "",
    kept: 0,
    of: 0,
    firstChars: s.slice(0, max),
    note: "This answer was too long and was cut to its first characters: the rest is not shown here. Never read something missing here as absent: narrow the request (a filter, a limit, one id) to read it.",
  };
}
