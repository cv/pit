/**
 * Order-level source files of the generated repository: shipping, totals, refunds, and the
 * modules that call them, shipped and as a reference solution.
 */
import { type RepoParams, ZONE_IDS } from "./model.js";

const js = String.raw;

const TEST_HEADER = js`import { test } from "node:test";
import assert from "node:assert/strict";
`;

const ORDERS = js`const orders = [
  {
    id: "ORD-1",
    date: "2024-05-01",
    region: "NW",
    zone: "A",
    weightGrams: 1500,
    codes: [],
    lines: [
      { id: "L1", sku: "X", qty: 2, unitCents: 1250 },
      { id: "L2", sku: "Y", qty: 1, unitCents: 999 },
    ],
  },
  {
    id: "ORD-2",
    date: "2024-05-01",
    region: "SE",
    zone: "B",
    weightGrams: 400,
    codes: [{ code: "SAVE10", percent: 10 }],
    lines: [{ id: "L1", sku: "Z", qty: 3, unitCents: 400 }],
  },
  {
    id: "ORD-3",
    date: "2024-05-02",
    region: "NE",
    zone: "C",
    weightGrams: 2200,
    codes: [],
    lines: [{ id: "L1", sku: "W", qty: 1, unitCents: 5000 }],
  },
];
`;

const zones = () => js`/**
 * Shipping costs. The rates and rules are specified in docs/SHIPPING.md.
 */

/**
 * Shipping cost in integer cents for an order.
 * @param {string} zone Shipping zone: A, B, C, or X.
 * @param {number} weightGrams Total parcel weight in grams.
 * @param {number} subtotalCents The order's discounted subtotal in integer cents.
 * @returns {number}
 */
export function shippingCents(zone, weightGrams, subtotalCents) {
  // Placeholder until the zone table from docs/SHIPPING.md is implemented.
  return 500;
}
`;

const zonesFixed = (params: RepoParams) => {
  const table = ZONE_IDS.map((zone) => {
    const rates = params.zones[zone];
    return `  ${zone}: { base: ${rates.base}, perKg: ${rates.perKg}, freeOver: ${rates.freeOver ?? "null"} },`;
  }).join("\n");
  return js`/**
 * Shipping costs, as specified in docs/SHIPPING.md.
 */
const ZONES = {
${table}
};

/**
 * Shipping cost in integer cents for an order.
 * @param {string} zone Shipping zone: A, B, C, or X.
 * @param {number} weightGrams Total parcel weight in grams.
 * @param {number} subtotalCents The order's discounted subtotal in integer cents.
 * @returns {number}
 */
export function shippingCents(zone, weightGrams, subtotalCents) {
  const rates = Object.hasOwn(ZONES, zone) ? ZONES[zone] : undefined;
  if (!rates) throw new RangeError("Unknown shipping zone: " + zone);
  if (rates.freeOver !== null && subtotalCents >= rates.freeOver) return 0;
  const kilograms = Math.max(1, Math.ceil(weightGrams / 1000));
  return rates.base + rates.perKg * (kilograms - 1);
}
`;
};

const total = () => js`import { applyCodes } from "./codes.js";
import { computeTax } from "./tax.js";
import { shippingCents } from "../shipping/zones.js";

/**
 * The sum of quantity times unit price over an order's lines, in integer cents.
 * @param {{ lines: { qty: number, unitCents: number }[] }} order
 * @returns {number}
 */
export function subtotalCents(order) {
  return order.lines.reduce((sum, line) => sum + line.qty * line.unitCents, 0);
}

/**
 * The order total in integer cents: the discounted subtotal plus tax and shipping.
 * @param {object} order
 * @returns {number}
 */
export function calcTotal(order) {
  const discounted = applyCodes(subtotalCents(order), order.codes);
  return (
    discounted +
    computeTax(discounted, order.region) +
    shippingCents(order.zone, order.weightGrams, discounted)
  );
}
`;

const totalFixed = () => js`import { applyCodes } from "./codes.js";
import { computeTax } from "./tax.js";
import { shippingCents } from "../shipping/zones.js";

/**
 * The sum of quantity times unit price over an order's lines, in integer cents.
 * @param {{ lines: { qty: number, unitCents: number }[] }} order
 * @returns {number}
 */
export function subtotalCents(order) {
  return order.lines.reduce((sum, line) => sum + line.qty * line.unitCents, 0);
}

/**
 * The order total in integer cents: the discounted subtotal plus tax and shipping.
 * @since 2.4
 * @param {object} order
 * @returns {number}
 */
export function orderTotal(order) {
  const discounted = applyCodes(subtotalCents(order), order.codes);
  return (
    discounted +
    computeTax(discounted, order.region) +
    shippingCents(order.zone, order.weightGrams, discounted)
  );
}

/**
 * @deprecated Use orderTotal. Kept for src/legacy.
 */
export const calcTotal = orderTotal;
`;

const totalTest = (
  name: string,
) => js`${TEST_HEADER}import { ${name}, subtotalCents } from "../../src/billing/total.js";
import { applyCodes } from "../../src/billing/codes.js";
import { computeTax } from "../../src/billing/tax.js";
import { shippingCents } from "../../src/shipping/zones.js";

${ORDERS}
test("subtotal sums quantity times unit price", () => {
  assert.equal(subtotalCents(orders[0]), 3499);
});

test("total adds tax and shipping to the discounted subtotal", () => {
  for (const order of orders) {
    const discounted = applyCodes(subtotalCents(order), order.codes);
    const expected =
      discounted +
      computeTax(discounted, order.region) +
      shippingCents(order.zone, order.weightGrams, discounted);
    assert.equal(${name}(order), expected);
  }
});
`;

const legacy =
  () => js`// Vendored from the reporting team's repository. Do not edit here; changes go upstream.
import { calcTotal } from "../billing/total.js";
import { formatCents } from "../money/format.js";

/**
 * One tab-separated line per order: its ID and formatted total.
 * @param {object[]} orders
 * @returns {string}
 */
export function legacyReport(orders) {
  return orders.map((order) => order.id + "\t" + formatCents(calcTotal(order))).join("\n");
}
`;

const legacyTest = () => js`${TEST_HEADER}import { legacyReport } from "../../src/legacy/report.js";

${ORDERS}
test("lists one tab-separated line per order", () => {
  const lines = legacyReport(orders).split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith("ORD-1\t$"));
});
`;

const daily = (name: string) => js`import { ${name} } from "../billing/total.js";

/**
 * Revenue in integer cents per order date, such as { "2024-05-01": 12345 }.
 * @param {{ date: string }[]} orders
 * @returns {Record<string, number>}
 */
export function dailyRevenue(orders) {
  const days = {};
  for (const order of orders) days[order.date] = (days[order.date] ?? 0) + ${name}(order);
  return days;
}
`;

const dailyTest = (
  name: string,
) => js`${TEST_HEADER}import { dailyRevenue } from "../../src/reports/daily.js";
import { ${name} } from "../../src/billing/total.js";

${ORDERS}
test("sums order totals per day", () => {
  assert.deepEqual(dailyRevenue(orders), {
    "2024-05-01": ${name}(orders[0]) + ${name}(orders[1]),
    "2024-05-02": ${name}(orders[2]),
  });
});
`;

const refunds = () => js`import { applyCodes } from "./codes.js";

/**
 * The refund in integer cents for some lines of an order: their amounts with the order's
 * discount codes applied. Tax and shipping are not refunded.
 * @since 2.4
 * @param {object} order
 * @param {string[]} lineIds
 * @returns {number}
 */
export function refundCents(order, lineIds) {
  let amount = 0;
  for (const id of lineIds) {
    const line = order.lines.find((candidate) => candidate.id === id);
    if (!line) throw new RangeError("Unknown line: " + id);
    amount += line.qty * line.unitCents;
  }
  return applyCodes(amount, order.codes);
}
`;

export function shippedOrderSources(): Record<string, string> {
  return {
    "src/shipping/zones.js": zones(),
    "src/billing/total.js": total(),
    "test/billing/total.test.js": totalTest("calcTotal"),
    "src/legacy/report.js": legacy(),
    "test/legacy/report.test.js": legacyTest(),
    "src/reports/daily.js": daily("calcTotal"),
    "test/reports/daily.test.js": dailyTest("calcTotal"),
  };
}

export function fixedOrderSources(params: RepoParams): Record<string, string> {
  return {
    "src/shipping/zones.js": zonesFixed(params),
    "src/billing/refunds.js": refunds(),
    "src/billing/total.js": totalFixed(),
    "test/billing/total.test.js": totalTest("orderTotal"),
    "src/reports/daily.js": daily("orderTotal"),
    "test/reports/daily.test.js": dailyTest("orderTotal"),
  };
}
