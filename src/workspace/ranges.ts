/** A hashed line range, as range reads and edits with context return it. */
export interface LineRange {
  start: number;
  end: number;
  content: string;
}

/** What returned ranges may still use; a batch of edits shares one budget across its edits. */
export interface RangeBudget {
  lines: number;
  bytes: number;
}

/** One window of hashed lines, starting at a 1-based line number. */
export interface RangeWindow {
  start: number;
  lines: Iterable<string>;
  /** The source was cut after these lines, so the ranges are truncated even within budget. */
  cut?: boolean;
}

/**
 * Takes each window's hashed lines into a range until the budget runs out, keeping whole lines.
 * Each line costs its UTF-8 bytes plus a newline. Range reads and edits with context share this,
 * so both bound their output the same way.
 */
export function takeRanges(
  windows: Iterable<RangeWindow>,
  budget: RangeBudget,
): { ranges: LineRange[]; truncated: boolean } {
  const ranges: LineRange[] = [];
  for (const window of windows) {
    const kept: string[] = [];
    let exhausted = false;
    for (const line of window.lines) {
      const cost = Buffer.byteLength(line) + 1;
      if (budget.lines < 1 || budget.bytes < cost) {
        exhausted = true;
        break;
      }
      budget.lines--;
      budget.bytes -= cost;
      kept.push(line);
    }
    if (kept.length > 0) {
      ranges.push({
        start: window.start,
        end: window.start + kept.length - 1,
        content: kept.join("\n"),
      });
    }
    if (exhausted || window.cut) return { ranges, truncated: true };
  }
  return { ranges, truncated: false };
}
