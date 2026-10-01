/**
 * Hidden tests for the generated repository, one suite per ticket. Each test name starts with its
 * check ID, and the scorer requires every listed test to pass.
 */
import {
  bestCode,
  discounted,
  divRound,
  type HiddenSuite,
  type Order,
  type RepoParams,
  type Rng,
  taxCases,
  ZONE_IDS,
} from "./model.js";

const HEADER = `import { test } from "node:test";
import assert from "node:assert/strict";
`;

const literal = (value: unknown) => JSON.stringify(value);

function suite(check: string, imports: string, cases: Array<[string, string]>): HiddenSuite {
  const tests = cases.map(([name]) => `${check} ${name}`);
  if (new Set(tests).size !== tests.length) throw new Error(`Duplicate hidden test in ${check}`);
  const blocks = cases.map(
    ([name, body]) => `test(${literal(`${check} ${name}`)}, () => {\n${body}\n});\n`,
  );
  return {
    check,
    file: `${check.toLowerCase()}.test.js`,
    tests,
    source: `${HEADER}${imports}\n\n${blocks.join("\n")}`,
  };
}

const equal = (call: string, expected: unknown) =>
  `  assert.deepEqual(${call}, ${literal(expected)});`;

function csv(params: RepoParams): HiddenSuite {
  const [first, second] = params.csvFailures;
  if (!first || !second) throw new Error("Ticket 1 needs two CSV failures");
  return suite("T1", `import { parseCsv, parseCsvLine } from "../src/csv/parse.js";`, [
    [
      "parses the first failing CI row",
      equal(`parseCsvLine(${literal(first.input)})`, first.expected),
    ],
    [
      "parses the second failing CI row",
      equal(`parseCsvLine(${literal(second.input)})`, second.expected),
    ],
    ["keeps commas inside quoted fields", equal(`parseCsvLine('a,"b, c",d')`, ["a", "b, c", "d"])],
    ["unescapes doubled quotes", equal(`parseCsvLine('"say ""hi""",2')`, ['say "hi"', "2"])],
    ["keeps empty fields", equal(`parseCsvLine("a,,b,")`, ["a", "", "b", ""])],
    ["still trims unquoted fields", equal(`parseCsvLine(" a , b ")`, ["a", "b"])],
    [
      "parses quoted fields in CSV text",
      equal(`parseCsv('name,qty\\n"Lamp, tall",2')`, [{ name: "Lamp, tall", qty: "2" }]),
    ],
  ]);
}

function discount(params: RepoParams, rng: Rng): HiddenSuite {
  const cases: Array<[number, number]> = [
    [5, 10],
    [25, 10],
    [15, 10],
    [1999, 15],
    [999, 7],
    [4567, 12],
  ];
  while (cases.length < 9) {
    const candidate: [number, number] = [rng.int(100, 99_999), rng.int(1, 90)];
    if (!cases.some(([cents]) => cents === candidate[0])) cases.push(candidate);
  }
  return suite("T2", `import { applyDiscount } from "../src/billing/discount.js";`, [
    ...cases.map(([cents, percent]): [string, string] => [
      `discounts ${cents} cents by ${percent}%`,
      equal(`applyDiscount(${cents}, ${percent})`, discounted(cents, percent, params.rounding)),
    ]),
    [
      "returns integer cents",
      `  for (const [cents, percent] of ${literal(cases)}) assert.ok(Number.isInteger(applyDiscount(cents, percent)));`,
    ],
    [
      "rejects percentages above 100",
      `  assert.throws(() => applyDiscount(1000, 101), RangeError);`,
    ],
  ]);
}

function shipping(params: RepoParams): HiddenSuite {
  const cases: Array<[string, string]> = [];
  for (const zone of ZONE_IDS) {
    const { base, perKg, freeOver } = params.zones[zone];
    const call = (grams: number, subtotal: number) =>
      `shippingCents("${zone}", ${grams}, ${subtotal})`;
    cases.push(
      [
        `zone ${zone}: the first kilogram costs the base rate`,
        `${equal(call(1000, 0), base)}\n${equal(call(1, 0), base)}`,
      ],
      [
        `zone ${zone}: each started kilogram adds the per-kilogram rate`,
        `${equal(call(1001, 0), base + perKg)}\n${equal(call(3500, 0), base + 3 * perKg)}`,
      ],
      freeOver === null
        ? [`zone ${zone}: never ships free`, equal(call(2500, 10_000_000), base + 2 * perKg)]
        : [
            `zone ${zone}: ships free from the threshold`,
            `${equal(call(2500, freeOver), 0)}\n${equal(call(2500, freeOver - 1), base + 2 * perKg)}`,
          ],
    );
  }
  cases.push([
    "rejects unknown zones",
    `  assert.throws(() => shippingCents("Q", 1000, 0), RangeError);`,
  ]);
  return suite("T3", `import { shippingCents } from "../src/shipping/zones.js";`, cases);
}

function refunds(params: RepoParams, rng: Rng): HiddenSuite {
  const percent = rng.pick([10, 20, 30]);
  const lines = [1, 2, 3].map((index) => ({
    id: `L${index}`,
    sku: `${params.skuPrefix}-KIT-0000${index}`,
    qty: rng.int(1, 4),
    unitCents: rng.int(20, 900) * 10,
  }));
  const order = {
    id: "ORD-REFUND",
    date: "2024-06-01",
    region: "NE",
    zone: "B",
    weightGrams: 900,
    codes: [{ code: `MEMBER${percent}`, percent }],
    lines,
  };
  const amount = (ids: string[]) =>
    lines
      .filter((line) => ids.includes(line.id))
      .reduce((sum, line) => sum + line.qty * line.unitCents, 0);
  const setup = `  const order = ${literal(order)};`;
  return suite("T4", `import { refundCents } from "../src/billing/refunds.js";`, [
    [
      "refunds the listed lines with the order's discount",
      `${setup}\n${equal(`refundCents(order, ["L1", "L3"])`, discounted(amount(["L1", "L3"]), percent, params.rounding))}`,
    ],
    [
      "refunds lines of an order without codes at full price",
      `${setup}\n${equal(`refundCents({ ...order, codes: [] }, ["L2"])`, amount(["L2"]))}`,
    ],
    ["refunds nothing for no lines", `${setup}\n${equal("refundCents(order, [])", 0)}`],
    [
      "rejects unknown lines",
      `${setup}\n  assert.throws(() => refundCents(order, ["L9"]), RangeError);`,
    ],
  ]);
}

function tax(params: RepoParams): HiddenSuite {
  const cases: Array<[string, string]> = [];
  for (const [region, bps] of Object.entries(params.taxBps)) {
    for (const amount of taxCases(bps)) {
      cases.push([
        `${region}: tax on ${amount} cents`,
        equal(
          `computeTax(${amount}, "${region}")`,
          divRound(amount * bps, 10_000, params.rounding),
        ),
      ]);
    }
    cases.push([
      `${region}: whole amounts stay exact`,
      equal(`computeTax(10000, "${region}")`, bps),
    ]);
  }
  return suite("T5", `import { computeTax } from "../src/billing/tax.js";`, cases);
}

function codes(params: RepoParams): HiddenSuite {
  const pair = [
    { code: "SPRING10", percent: 10 },
    { code: "MEMBER15", percent: 15 },
  ];
  const { disputed } = params;
  return suite("T6", `import { applyCodes } from "../src/billing/codes.js";`, [
    ["applies only the best of several codes", equal(`applyCodes(12000, ${literal(pair)})`, 10200)],
    [
      "ignores the order of codes",
      equal(`applyCodes(12000, ${literal([...pair].reverse())})`, 10200),
    ],
    [
      "corrects the disputed order",
      equal(`applyCodes(${disputed.subtotal}, ${literal(disputed.codes)})`, disputed.expected),
    ],
    [
      "applies a single code",
      equal(
        `applyCodes(3000, ${literal([{ code: "WELCOME20", percent: 20 }])})`,
        bestCode(3000, [{ code: "W", percent: 20 }], params.rounding),
      ),
    ],
    ["leaves amounts without codes unchanged", equal("applyCodes(4321, [])", 4321)],
  ]);
}

function rename(sample: readonly Order[]): HiddenSuite {
  const setup = `  const orders = ${literal(sample)};`;
  return suite(
    "T7",
    `import * as total from "../src/billing/total.js";
import { legacyReport } from "../src/legacy/report.js";
import { dailyRevenue } from "../src/reports/daily.js";
import { formatCents } from "../src/money/format.js";`,
    [
      ["exports orderTotal", `  assert.equal(typeof total.orderTotal, "function");`],
      [
        "keeps calcTotal as an alias",
        `${setup}\n  for (const order of orders) assert.equal(total.calcTotal(order), total.orderTotal(order));`,
      ],
      [
        "keeps the legacy report working",
        `${setup}\n  assert.equal(legacyReport(orders), orders.map((order) => order.id + "\\t" + formatCents(total.orderTotal(order))).join("\\n"));`,
      ],
      [
        "daily revenue uses order totals",
        `${setup}\n  const expected = {};\n  for (const order of orders) expected[order.date] = (expected[order.date] ?? 0) + total.orderTotal(order);\n  assert.deepEqual(dailyRevenue(orders), expected);`,
      ],
    ],
  );
}

/** The regression check's legacy-report body; it accepts either total function name. */
export function legacyRegression(sample: readonly Order[]): string {
  return `  const orders = ${literal(sample)};\n  const totalOf = total.orderTotal ?? total.calcTotal;\n  assert.equal(legacyReport(orders), orders.map((order) => order.id + "\\t" + formatCents(totalOf(order))).join("\\n"));`;
}

export function ticketSuites(
  params: RepoParams,
  rng: Rng,
  sample: readonly Order[],
): HiddenSuite[] {
  return [
    csv(params),
    discount(params, rng),
    shipping(params),
    refunds(params, rng),
    tax(params),
    codes(params),
    rename(sample),
  ];
}
