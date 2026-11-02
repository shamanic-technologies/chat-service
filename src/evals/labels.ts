// ---------------------------------------------------------------------------
// Hand-checked labels on replayed replies (SOPHIE-TRUE-1102 round 3).
//
// Calibration proves the judge on two replies per scenario (a known-bad
// production reply, a hand-written good one). Round 2 showed it is not enough:
// 17 of 42 replies the judge called untrue stated only supported figures. A
// label set says, reply by reply, whether each criterion truly holds, checked
// against everything the model read; `--rejudge` grades the stored replies
// again and reports how often the judge agrees, without re-running the agent
// (whose own variance would hide the judge's).
// ---------------------------------------------------------------------------

import { z } from "zod";

export const LabelSchema = z
  .object({
    scenario: z.string().min(1),
    replay: z.number().int().nonnegative(),
    true: z.boolean(),
    /** The unsupported sentence when `true` is false. */
    unsupported: z.string().optional(),
    /** Where the support or the contradiction is. */
    evidence: z.string().optional(),
  })
  .passthrough();
export type Label = z.infer<typeof LabelSchema>;

export const LabelFileSchema = z.object({
  /** The replay run the labels were checked on (its `at`). */
  run: z.string().min(1),
  labels: z.array(LabelSchema).min(1),
});

export interface JudgedRow {
  scenario: string;
  replay: number;
  judgedTrue: boolean;
}

export interface Agreement {
  labelled: number;
  agree: number;
  rate: number;
  /** Judge said untrue, label says true: a good reply graded down. */
  falseAlarms: Array<{ scenario: string; replay: number }>;
  /** Judge said true, label says untrue: an invention let through. */
  missed: Array<{ scenario: string; replay: number }>;
}

/** How often the judge's "true" matches the labels, and where it does not. */
export function trueAgreement(rows: readonly JudgedRow[], labels: readonly Label[]): Agreement {
  const byKey = new Map(labels.map((l) => [`${l.scenario}#${l.replay}`, l]));
  const falseAlarms: Agreement["falseAlarms"] = [];
  const missed: Agreement["missed"] = [];
  let labelled = 0;
  for (const r of rows) {
    const label = byKey.get(`${r.scenario}#${r.replay}`);
    if (!label) continue;
    labelled++;
    if (label.true && !r.judgedTrue) falseAlarms.push({ scenario: r.scenario, replay: r.replay });
    if (!label.true && r.judgedTrue) missed.push({ scenario: r.scenario, replay: r.replay });
  }
  if (labelled === 0) throw new Error("[evals] no judged reply carries a label: wrong run or wrong label file");
  const agree = labelled - falseAlarms.length - missed.length;
  return { labelled, agree, rate: agree / labelled, falseAlarms, missed };
}
