/**
 * Source files of the generated "shopline" repository that the tickets change: the shipped
 * (buggy or unimplemented) versions, their visible tests, and a reference solution.
 */
import type { RepoParams, Rounding } from "./model.js";

const js = String.raw;

const TEST_HEADER = js`import { test } from "node:test";
import assert from "node:assert/strict";
`;

const csvParse = () => js`/**
 * Minimal CSV parsing for catalog imports.
 */

/**
 * Splits one CSV line into trimmed fields.
 * @param {string} line
 * @returns {string[]}
 */
export function parseCsvLine(line) {
  return line.split(",").map((field) => field.trim());
}

/**
 * Parses CSV text with a header row into objects keyed by column name. Blank lines are skipped.
 * @param {string} text
 * @returns {Record<string, string>[]}
 */
export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const [header, ...rows] = lines;
  if (header === undefined) return [];
  const columns = parseCsvLine(header);
  return rows.map((row) => {
    const fields = parseCsvLine(row);
    return Object.fromEntries(columns.map((column, index) => [column, fields[index] ?? ""]));
  });
}
`;

const csvParseFixed = () => js`/**
 * CSV parsing for catalog imports: commas inside double-quoted fields, and doubled quotes inside
 * them, as in RFC 4180. Unquoted fields are trimmed.
 */

/**
 * Splits one CSV line into fields.
 * @param {string} line
 * @returns {string[]}
 */
export function parseCsvLine(line) {
  const fields = [];
  let field = "";
  let quoted = false;
  let wasQuoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field.trim() === "") {
      quoted = true;
      wasQuoted = true;
      field = "";
    } else if (char === ",") {
      fields.push(wasQuoted ? field : field.trim());
      field = "";
      wasQuoted = false;
    } else {
      field += char;
    }
  }
  fields.push(wasQuoted ? field : field.trim());
  return fields;
}

/**
 * Parses CSV text with a header row into objects keyed by column name. Blank lines are skipped.
 * @param {string} text
 * @returns {Record<string, string>[]}
 */
export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const [header, ...rows] = lines;
  if (header === undefined) return [];
  const columns = parseCsvLine(header);
  return rows.map((row) => {
    const fields = parseCsvLine(row);
    return Object.fromEntries(columns.map((column, index) => [column, fields[index] ?? ""]));
  });
}
`;

const csvTest =
  () => js`${TEST_HEADER}import { parseCsv, parseCsvLine } from "../../src/csv/parse.js";

test("splits a line into trimmed fields", () => {
  assert.deepEqual(parseCsvLine(" lantern , 3,1250 "), ["lantern", "3", "1250"]);
});

test("maps rows to the header columns", () => {
  assert.deepEqual(parseCsv("name,qty\nlantern,3\n\nmap,1\n"), [
    { name: "lantern", qty: "3" },
    { name: "map", qty: "1" },
  ]);
});

test("fills missing fields with empty strings", () => {
  assert.deepEqual(parseCsv("name,qty,price\nlantern,3"), [{ name: "lantern", qty: "3", price: "" }]);
});
`;

const importScript =
  () => js`// Imports a catalog CSV export (name,qty,price) and reports rows that do not parse cleanly.
// CI downloads the fixtures; they are not checked in.
import { readFileSync } from "node:fs";

import { parseCsv } from "../src/csv/parse.js";

const file = process.argv[2];
if (!file) throw new Error("Usage: node scripts/import-catalog.js <file.csv>");
const rows = parseCsv(readFileSync(file, "utf8"));
let failed = 0;
for (const [index, row] of rows.entries()) {
  if (!row.name || !/^\d+$/.test(row.qty) || !/^\d+$/.test(row.price)) {
    failed++;
    console.log("[import] row " + (index + 1) + ": FAILED " + JSON.stringify(row));
  }
}
console.log("[import] summary: " + (rows.length - failed) + " rows ok, " + failed + " failed");
process.exitCode = failed > 0 ? 1 : 0;
`;

const cents = () => js`/**
 * Parses a decimal string such as "12.34" or "-0.5" into integer cents.
 * @param {string} text
 * @returns {number}
 */
export function toCents(text) {
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(String(text).trim());
  if (!match) throw new RangeError("Not an amount: " + text);
  const value = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  return match[1] ? -value : value;
}

/**
 * Formats integer cents as a plain decimal string such as "12.34".
 * @param {number} value
 * @returns {string}
 */
export function centsToDecimal(value) {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  return sign + Math.floor(abs / 100) + "." + String(abs % 100).padStart(2, "0");
}
`;

const centsTest =
  () => js`${TEST_HEADER}import { centsToDecimal, toCents } from "../../src/money/cents.js";

test("parses decimal amounts into cents", () => {
  assert.equal(toCents("12.34"), 1234);
  assert.equal(toCents("7.5"), 750);
  assert.equal(toCents("-0.05"), -5);
  assert.equal(toCents("3"), 300);
});

test("rejects malformed amounts", () => {
  assert.throws(() => toCents("1.234"), RangeError);
  assert.throws(() => toCents("abc"), RangeError);
});

test("formats cents as decimals", () => {
  assert.equal(centsToDecimal(1234), "12.34");
  assert.equal(centsToDecimal(-5), "-0.05");
});
`;

const format = () => js`/**
 * Formats integer cents for display, such as formatCents(123456) === "$1,234.56".
 * @param {number} value
 * @param {string} [symbol]
 * @returns {string}
 */
export function formatCents(value, symbol = "$") {
  const sign = value < 0 ? "-" : "";
  const [whole, fraction] = (Math.abs(value) / 100).toFixed(2).split(".");
  return sign + symbol + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + fraction;
}
`;

const formatTest = () => js`${TEST_HEADER}import { formatCents } from "../../src/money/format.js";

test("formats cents with a currency symbol and separators", () => {
  assert.equal(formatCents(123456), "$1,234.56");
  assert.equal(formatCents(5), "$0.05");
  assert.equal(formatCents(-2500, "€"), "-€25.00");
});
`;

const discount = () => js`/**
 * Applies a percentage discount to an amount in dollars.
 * @param {number} amount Amount in dollars, such as 19.99.
 * @param {number} percent Discount percentage from 0 to 100.
 * @returns {number} The discounted amount in dollars, rounded to cents.
 */
export function applyDiscount(amount, percent) {
  if (percent < 0 || percent > 100) throw new RangeError("Invalid discount: " + percent);
  return parseFloat((amount * (1 - percent / 100)).toFixed(2));
}
`;

const discountTest =
  () => js`${TEST_HEADER}import { applyDiscount } from "../../src/billing/discount.js";

test("applies a percentage discount", () => {
  assert.equal(applyDiscount(19.99, 10), 17.99);
});

test("a zero discount keeps the amount", () => {
  assert.equal(applyDiscount(100, 0), 100);
});

test("rejects percentages outside 0-100", () => {
  assert.throws(() => applyDiscount(10, 101), RangeError);
});
`;

const rounding = (rule: Rounding) => js`function divRound(numerator, denominator) {
  const quotient = Math.floor(numerator / denominator);
  const twice = 2 * (numerator - quotient * denominator);
  if (twice > denominator) return quotient + 1;
  if (twice < denominator) return quotient;
  return ${rule === "half-up" ? "quotient + 1" : "quotient % 2 === 1 ? quotient + 1 : quotient"};
}
`;

const discountFixed = (
  rule: Rounding,
) => js`// Rounds to the nearest cent; exact halves round ${rule === "half-up" ? "up" : "to even"}.
${rounding(rule)}
/**
 * Applies a percentage discount to an amount in integer cents.
 * @param {number} amount Amount in integer cents.
 * @param {number} percent Discount percentage from 0 to 100.
 * @returns {number} The discounted amount in integer cents.
 */
export function applyDiscount(amount, percent) {
  if (percent < 0 || percent > 100) throw new RangeError("Invalid discount: " + percent);
  return divRound(amount * (100 - percent), 100);
}
`;

const discountTestFixed =
  () => js`${TEST_HEADER}import { applyDiscount } from "../../src/billing/discount.js";

test("applies a percentage discount in cents", () => {
  assert.equal(applyDiscount(1999, 10), 1799);
});

test("a zero discount keeps the amount", () => {
  assert.equal(applyDiscount(100, 0), 100);
});

test("rejects percentages outside 0-100", () => {
  assert.throws(() => applyDiscount(10, 101), RangeError);
});
`;

const rates = (params: RepoParams) =>
  Object.entries(params.taxBps)
    .map(([region, bps]) => `${region}: ${bps}`)
    .join(", ");

const tax = (
  params: RepoParams,
) => js`/** Sales tax rates by region, in basis points (hundredths of a percent). */
const RATES_BPS = { ${rates(params)} };

/**
 * The tax rate for a region in basis points. Unknown regions throw a RangeError.
 * @param {string} region
 * @returns {number}
 */
export function taxRateBps(region) {
  const rate = RATES_BPS[region];
  if (rate === undefined) throw new RangeError("Unknown tax region: " + region);
  return rate;
}

/**
 * Tax in integer cents on an amount in integer cents.
 * @param {number} amountCents
 * @param {string} region
 * @returns {number}
 */
export function computeTax(amountCents, region) {
  return Math.floor((amountCents * taxRateBps(region)) / 10000);
}
`;

const taxFixed = (
  params: RepoParams,
) => js`/** Sales tax rates by region, in basis points (hundredths of a percent). */
const RATES_BPS = { ${rates(params)} };

// Rounds to the nearest cent with the discount rule from ticket 2.
${rounding(params.rounding)}
/**
 * The tax rate for a region in basis points. Unknown regions throw a RangeError.
 * @param {string} region
 * @returns {number}
 */
export function taxRateBps(region) {
  const rate = RATES_BPS[region];
  if (rate === undefined) throw new RangeError("Unknown tax region: " + region);
  return rate;
}

/**
 * Tax in integer cents on an amount in integer cents, rounded to the nearest cent.
 * @param {number} amountCents
 * @param {string} region
 * @returns {number}
 */
export function computeTax(amountCents, region) {
  return divRound(amountCents * taxRateBps(region), 10000);
}
`;

const taxTest = (params: RepoParams) => {
  const [region, bps] = Object.entries(params.taxBps)[0] ?? ["NW", 0];
  return js`${TEST_HEADER}import { computeTax, taxRateBps } from "../../src/billing/tax.js";

test("taxes whole amounts at the regional rate", () => {
  assert.equal(computeTax(10000, "${region}"), ${bps});
});

test("rejects unknown regions", () => {
  assert.throws(() => taxRateBps("ZZ"), RangeError);
});
`;
};

const codes = () => js`/**
 * Discount codes. An order can carry several codes; each is { code, percent }.
 */

/**
 * Applies an order's discount codes to an amount in integer cents.
 * @param {number} amountCents
 * @param {{ code: string, percent: number }[]} codes
 * @returns {number}
 */
export function applyCodes(amountCents, codes) {
  let amount = amountCents;
  for (const { percent } of codes) {
    amount = parseFloat((amount * (1 - percent / 100)).toFixed(0));
  }
  return amount;
}

/**
 * Whether a code is well formed: capital letters followed by a percentage, such as SPRING10.
 * @param {string} code
 * @returns {boolean}
 */
export function isValidCode(code) {
  return /^[A-Z]+\d{1,2}$/.test(code);
}
`;

const codesFixed = () => js`/**
 * Discount codes. An order can carry several codes; each is { code, percent }. Only the best code
 * applies.
 */
import { applyDiscount } from "./discount.js";

/**
 * Applies the best of an order's discount codes to an amount in integer cents.
 * @param {number} amountCents
 * @param {{ code: string, percent: number }[]} codes
 * @returns {number}
 */
export function applyCodes(amountCents, codes) {
  if (codes.length === 0) return amountCents;
  return applyDiscount(amountCents, Math.max(...codes.map((code) => code.percent)));
}

/**
 * Whether a code is well formed: capital letters followed by a percentage, such as SPRING10.
 * @param {string} code
 * @returns {boolean}
 */
export function isValidCode(code) {
  return /^[A-Z]+\d{1,2}$/.test(code);
}
`;

const codesTest =
  () => js`${TEST_HEADER}import { applyCodes, isValidCode } from "../../src/billing/codes.js";

test("leaves amounts without codes unchanged", () => {
  assert.equal(applyCodes(1234, []), 1234);
});

test("applies a single code", () => {
  assert.equal(applyCodes(1000, [{ code: "SAVE10", percent: 10 }]), 900);
});

test("recognizes well-formed codes", () => {
  assert.equal(isValidCode("SPRING15"), true);
  assert.equal(isValidCode("spring15"), false);
});
`;

export function shippedSources(params: RepoParams): Record<string, string> {
  return {
    "src/csv/parse.js": csvParse(),
    "test/csv/parse.test.js": csvTest(),
    "scripts/import-catalog.js": importScript(),
    "src/money/cents.js": cents(),
    "test/money/cents.test.js": centsTest(),
    "src/money/format.js": format(),
    "test/money/format.test.js": formatTest(),
    "src/billing/discount.js": discount(),
    "test/billing/discount.test.js": discountTest(),
    "src/billing/tax.js": tax(params),
    "test/billing/tax.test.js": taxTest(params),
    "src/billing/codes.js": codes(),
    "test/billing/codes.test.js": codesTest(),
  };
}

export function fixedSources(params: RepoParams): Record<string, string> {
  return {
    "src/csv/parse.js": csvParseFixed(),
    "src/billing/discount.js": discountFixed(params.rounding),
    "test/billing/discount.test.js": discountTestFixed(),
    "src/billing/tax.js": taxFixed(params),
    "src/billing/codes.js": codesFixed(),
  };
}
