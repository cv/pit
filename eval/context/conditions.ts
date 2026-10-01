/** Context-management conditions compared by the evaluation (#205). */
export interface Condition {
  label: string;
  /** Load Pit from this checkout; otherwise the model gets Pi's built-in tools. */
  pit: boolean;
  /** Add the feed's compact_context tool, which runs the compaction `session.compact()` runs. */
  compactTool: boolean;
  /** List the draft pit-context skill in the system prompt. */
  skill: boolean;
  /** Add the feed's extra absolute-token pressure notices. */
  extraNotices: boolean;
}

export const CONDITIONS = {
  A: {
    label: "Pi auto-compaction only",
    pit: false,
    compactTool: false,
    skill: false,
    extraNotices: false,
  },
  B: {
    label: "A plus model-requested compaction",
    pit: false,
    compactTool: true,
    skill: false,
    extraNotices: false,
  },
  C: {
    label: "Pit context tools, v0.23.0 guidance and notices",
    pit: true,
    compactTool: false,
    skill: false,
    extraNotices: false,
  },
  D: {
    label: "C plus the draft pit-context skill",
    pit: true,
    compactTool: false,
    skill: true,
    extraNotices: false,
  },
  E: {
    label: "C plus an earlier absolute-token notice",
    pit: true,
    compactTool: false,
    skill: false,
    extraNotices: true,
  },
} as const satisfies Record<string, Condition>;

export type ConditionId = keyof typeof CONDITIONS;

export const CONDITION_IDS = Object.keys(CONDITIONS) as ConditionId[];

export function isConditionId(value: string): value is ConditionId {
  return Object.hasOwn(CONDITIONS, value);
}
