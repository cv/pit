/**
 * Types and reference arithmetic for the realistic long task (#205). The generated repository's
 * correct behavior is computed here, so hidden tests embed exact expected values.
 */
import type { random } from "../tasks.js";

export type Rng = ReturnType<typeof random>;

export type Rounding = "half-even" | "half-up";
export const ZONE_IDS = ["A", "B", "C", "X"] as const;
export type Zone = (typeof ZONE_IDS)[number];
export const REGIONS = ["NW", "NE", "SW", "SE"] as const;

export interface Line {
  id: string;
  sku: string;
  qty: number;
  unitCents: number;
}

export interface Code {
  code: string;
  percent: number;
}

export interface Order {
  id: string;
  date: string;
  region: string;
  zone: Zone;
  weightGrams: number;
  codes: Code[];
  lines: Line[];
}

export interface ZoneRates {
  base: number;
  perKg: number;
  /** The discounted subtotal from which shipping is free, or null when it never is. */
  freeOver: number | null;
}

export interface CsvFailure {
  row: number;
  input: string;
  expected: string[];
  actual: string[];
}

export interface RepoParams {
  rounding: Rounding;
  taxBps: Record<string, number>;
  zones: Record<Zone, ZoneRates>;
  skuPrefix: string;
  ciRun: number;
  csvFailures: CsvFailure[];
  disputed: { id: string; subtotal: number; codes: Code[]; charged: number; expected: number };
}

export interface Ticket {
  id: number;
  text: string;
}

/** A hidden test file and the test names its check requires; a missing test fails the check. */
export interface HiddenSuite {
  check: string;
  file: string;
  source: string;
  tests: string[];
}

export interface RepoTask {
  seed: number;
  /** The starting repository, by relative path. */
  files: Record<string, string>;
  /** Hidden test files, written to test-hidden/ only for scoring. */
  hidden: HiddenSuite[];
  /** Final versions of the files a correct solution changes, for validating the task. */
  reference: Record<string, string>;
  tickets: Ticket[];
  params: RepoParams;
  orders: Order[];
}

/** The ticket that sets the legacy and `@since 2.4` rules. */
export const RULES_TICKET = 4;

/** Integer division rounded to nearest; exact halves follow the rule. */
export function divRound(numerator: number, denominator: number, rule: Rounding): number {
  const quotient = Math.floor(numerator / denominator);
  const twice = 2 * (numerator - quotient * denominator);
  if (twice > denominator) return quotient + 1;
  if (twice < denominator) return quotient;
  return rule === "half-up" || quotient % 2 === 1 ? quotient + 1 : quotient;
}

export const discounted = (cents: number, percent: number, rule: Rounding) =>
  divRound(cents * (100 - percent), 100, rule);

/** The policy: only the best code applies, computed like applyDiscount. */
export const bestCode = (cents: number, codes: readonly Code[], rule: Rounding) =>
  codes.length === 0
    ? cents
    : discounted(cents, Math.max(...codes.map((code) => code.percent)), rule);

/** The shipped applyCodes: every code multiplies, rounded through floating point. */
export function stackedCodes(cents: number, codes: readonly Code[]): number {
  let amount = cents;
  for (const { percent } of codes) {
    amount = Number.parseFloat((amount * (1 - percent / 100)).toFixed(0));
  }
  return amount;
}

export function shipping(rates: ZoneRates, grams: number, subtotal: number): number {
  if (rates.freeOver !== null && subtotal >= rates.freeOver) return 0;
  return rates.base + rates.perKg * (Math.max(1, Math.ceil(grams / 1000)) - 1);
}

export const subtotalOf = (order: Order) =>
  order.lines.reduce((sum, line) => sum + line.qty * line.unitCents, 0);

/** The CSV parser before ticket 1: split on every comma and trim. */
export const splitCsv = (line: string) => line.split(",").map((field) => field.trim());

export const dollars = (cents: number) =>
  `$${Math.floor(cents / 100).toLocaleString("en-US")}.${String(cents % 100).padStart(2, "0")}`;

/** Amounts whose tax lands on exact halves with even and odd quotients, and two non-halves. */
export function taxCases(bps: number): number[] {
  const found = new Map<string, number>();
  for (let amount = 101; found.size < 4 && amount < 200_000; amount++) {
    const product = amount * bps;
    const quotient = Math.floor(product / 10_000);
    const remainder = product % 10_000;
    const kind =
      remainder === 5000
        ? `half-${quotient % 2}`
        : remainder > 5000 && remainder < 9000
          ? "above"
          : remainder > 1000 && remainder < 5000
            ? "below"
            : null;
    if (kind && !found.has(kind)) found.set(kind, amount);
  }
  if (found.size < 4) throw new Error(`No complete tax cases for ${bps} bps`);
  return [...found.values()];
}
