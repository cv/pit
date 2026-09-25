import { boundText, omissionMarker, type TextBudget } from "./bounds.js";

/** Model-visible text for a returned value: strings verbatim, everything else as indented JSON. */
export function display(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "undefined";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export interface FittedValue {
  /** Text within the budget. */
  text: string;
  /** The value `text` represents; undefined when only unstructured text could fit. */
  value: unknown;
  truncated: boolean;
}

interface ShrinkCaps {
  stringBytes: number;
  items: number;
}

/** Strings are never shortened below this, so short fields and markers stay readable. */
const MIN_STRING_BYTES = 256;
/** Deeper values fall back to marked text; structural fitting recurses once per level. */
const MAX_FIT_DEPTH = 256;
const OMITTED_KEY = "…";

function lineCount(text: string): number {
  let count = 1;
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) {
    count++;
  }
  return count;
}

function fits(text: string, budget: Required<TextBudget>): boolean {
  return Buffer.byteLength(text) <= budget.maxBytes && lineCount(text) <= budget.maxLines;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The largest string (bytes), container (entries), and nesting depth in a value. */
function measure(value: unknown): { stringBytes: number; items: number; depth: number } {
  const largest = { stringBytes: 0, items: 0, depth: 0 };
  // Iterative, so arbitrarily deep values cannot exhaust the stack.
  const pending: Array<[unknown, number]> = [[value, 1]];
  for (let next = pending.pop(); next; next = pending.pop()) {
    const [current, depth] = next;
    if (typeof current === "string") {
      largest.stringBytes = Math.max(largest.stringBytes, Buffer.byteLength(current));
      continue;
    }
    const children = Array.isArray(current)
      ? current
      : isRecord(current)
        ? Object.values(current)
        : undefined;
    if (!children) continue;
    largest.items = Math.max(largest.items, children.length);
    largest.depth = Math.max(largest.depth, depth);
    for (const child of children) pending.push([child, depth + 1]);
  }
  return largest;
}

/**
 * Copies `value`, keeping both ends of strings longer than `stringBytes` and of containers with
 * more than `items` entries around counted markers. An object that owns a boolean `truncated`
 * flag is marked when anything inside it was shortened.
 */
function shrink(value: unknown, caps: ShrinkCaps): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    const bounded = boundText(value, { maxBytes: caps.stringBytes }, "ends");
    return { value: bounded.text, changed: bounded.truncated };
  }
  if (Array.isArray(value)) {
    let changed = value.length > caps.items;
    const head = changed ? Math.ceil(caps.items / 2) : value.length;
    const tail = changed ? caps.items - head : 0;
    const copy = (items: unknown[]) =>
      items.map((item) => {
        const shrunk = shrink(item, caps);
        changed ||= shrunk.changed;
        return shrunk.value;
      });
    const kept = copy(value.slice(0, head));
    if (value.length > caps.items) {
      kept.push(omissionMarker(value.length - caps.items, "items"));
      kept.push(...copy(value.slice(value.length - tail)));
    }
    return { value: kept, changed };
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    let changed = entries.length > caps.items;
    const copy: Record<string, unknown> = {};
    for (const [key, item] of entries.slice(0, caps.items)) {
      const shrunk = shrink(item, caps);
      changed ||= shrunk.changed;
      copy[key] = shrunk.value;
    }
    if (entries.length > caps.items) {
      let key = OMITTED_KEY;
      while (Object.hasOwn(copy, key)) key += OMITTED_KEY;
      copy[key] = omissionMarker(entries.length - caps.items, "keys");
    }
    if (changed && typeof copy.truncated === "boolean") copy.truncated = true;
    return { value: copy, changed };
  }
  return { value, changed: false };
}

type Attempt = (cap: number) => { text: string; value: unknown } | undefined;

/** The fitting attempt with the largest cap in `[low, high]`, assuming larger caps grow output. */
function largestFitting(low: number, high: number, attempt: Attempt) {
  const first = attempt(low);
  if (!first) return undefined;
  let best = { cap: low, ...first };
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const result = attempt(middle);
    if (result) {
      best = { cap: middle, ...result };
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

/**
 * Fits a returned value into a text budget while keeping it valid JSON. Oversized strings keep
 * both ends; when strings alone cannot fit, oversized arrays and objects keep both ends of
 * their entries. Caps apply uniformly, so small fields such as exit codes always survive.
 */
export function fitValue(value: unknown, budget: Required<TextBudget>): FittedValue {
  if (typeof value === "string") {
    const bounded = boundText(value, budget, "ends");
    return { text: bounded.text, value: bounded.text, truncated: bounded.truncated };
  }
  const text = display(value);
  if (fits(text, budget)) return { text, value, truncated: false };
  let serializable = true;
  try {
    JSON.stringify(value);
  } catch {
    serializable = false;
  }
  const largest = serializable ? measure(value) : undefined;
  if (largest && largest.depth <= MAX_FIT_DEPTH) {
    const attempt =
      (caps: (cap: number) => ShrinkCaps): Attempt =>
      (cap) => {
        const shrunk = shrink(value, caps(cap)).value;
        const candidate = JSON.stringify(shrunk, null, 2);
        return fits(candidate, budget) ? { text: candidate, value: shrunk } : undefined;
      };
    const stringHigh = Math.max(MIN_STRING_BYTES, Math.min(largest.stringBytes, budget.maxBytes));
    const byStrings = largestFitting(
      MIN_STRING_BYTES,
      stringHigh,
      attempt((stringBytes) => ({ stringBytes, items: Number.POSITIVE_INFINITY })),
    );
    if (byStrings) return { text: byStrings.text, value: byStrings.value, truncated: true };
    const itemHigh = Math.max(1, Math.min(largest.items, budget.maxLines));
    const byItems = largestFitting(
      1,
      itemHigh,
      attempt((items) => ({ stringBytes: MIN_STRING_BYTES, items })),
    );
    if (byItems) {
      // Spend any remaining budget on longer strings within the chosen entry cap.
      const items = byItems.cap;
      const fitted =
        largestFitting(
          MIN_STRING_BYTES,
          stringHigh,
          attempt((stringBytes) => ({ stringBytes, items })),
        ) ?? byItems;
      return { text: fitted.text, value: fitted.value, truncated: true };
    }
  }
  // Deep nesting or unserializable values: fall back to marked text with no structured value.
  return { text: boundText(text, budget, "ends").text, value: undefined, truncated: true };
}
