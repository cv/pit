/**
 * Documents, data, and logs of the generated repository: the places where tickets' decisive facts
 * live among realistic bulk.
 */
import type { Module } from "./fillers.js";
import {
  type Code,
  type CsvFailure,
  dollars,
  type Order,
  REGIONS,
  type RepoParams,
  type Rng,
  splitCsv,
  ZONE_IDS,
} from "./model.js";

const NOUNS = [
  "Lantern",
  "Compass",
  "Map",
  "Journal",
  "Clock",
  "Vase",
  "Bench",
  "Loom",
  "Ruler",
  "Kite",
];
const ADJECTIVES = ["brass", "copper", "painted", "wooden", "folding", "pocket", "glass", "linen"];
const CODE_NAMES = ["SPRING", "SUMMER", "MEMBER", "WELCOME", "FALL", "HOLIDAY"];
const CATEGORIES = ["LAN", "MAP", "CLO", "JOU", "VAS", "KIT"];

export function packageJson(): string {
  return `${JSON.stringify(
    {
      name: "shopline",
      version: "2.3.1",
      description: "Order, billing, and catalog helpers for the museum shop.",
      type: "module",
      license: "UNLICENSED",
      private: true,
      scripts: { test: "node --test" },
      engines: { node: ">=22" },
    },
    null,
    2,
  )}\n`;
}

export function readme(modules: readonly Module[]): string {
  const layout = [
    "- `src/billing/`: discounts, discount codes, tax, and order totals",
    "- `src/csv/`: CSV parsing for catalog imports",
    "- `src/legacy/`: the reporting team's vendored report",
    "- `src/money/`: parsing and formatting amounts",
    "- `src/shipping/`: shipping costs by zone",
    "- `src/reports/daily.js`: revenue per day",
    ...modules.map((module) => `- \`${module.path}\`: ${module.imports.join(", ")}`),
  ];
  return `# shopline

Order, billing, and catalog helpers for the museum shop's online store. The checkout service and
the nightly reports import these modules directly; there is no build step.

## Development

- Node.js 22 or later; no dependencies.
- Run the tests with \`node --test\`. Tests live under \`test/\` and mirror \`src/\`.
- \`scripts/import-catalog.js\` imports a catalog CSV export. CI runs it against fixtures that are
  downloaded at build time and not checked in.

## Layout

${layout.join("\n")}

## Data

\`data/orders.jsonl\` is an anonymized export of recent orders, one JSON object per line, used for
support investigations. \`logs/\` holds CI logs attached to recent incidents.

See CONTRIBUTING.md before sending changes and docs/ARCHITECTURE.md for how the pieces fit.
`;
}

export function contributing(): string {
  return `# Contributing

## Code style

- ES modules only, with explicit \`.js\` extensions in imports.
- Exported functions have a JSDoc comment describing parameters and the return value.
- Prefer small pure functions. Modules under \`src/\` must not read files or the environment;
  scripts under \`scripts/\` may.
- Throw \`RangeError\` for invalid arguments such as unknown regions, zones, or line IDs.

## Tests

- Every module has a test file under \`test/\` at the matching path.
- Use \`node:test\` and \`node:assert/strict\`. Keep tests deterministic: no clocks, network, or
  randomness.
- Run \`node --test\` before sending a change. CI runs the same command, then the catalog import.

## Changelog

CHANGELOG.md has one section per release, newest first, with one line per change.

## Reviews

Every change needs one approving review. Reviewers check behavior against the docs in \`docs/\`,
look for missing tests, and confirm that public functions keep working for existing callers.
Breaking changes need a deprecation period of at least one minor release.
`;
}

export function changelog(entries?: readonly string[]): string {
  const next = entries ? `## 2.4.0\n\n${entries.join("\n")}\n\n` : "";
  return `# Changelog

${next}## 2.3.1

- Fixed rounding in formatWeight for weights just under a kilogram.

## 2.3.0

- Added paginate.
- Added the reporting team's legacy report.
- Added discount codes with isValidCode.

## 2.2.0

- Added daily revenue reports.
`;
}

export function architecture(modules: readonly Module[]): string {
  const sections = [
    [
      "Billing",
      "An order total is the subtotal (quantity times unit price over all lines) after discount codes, plus tax on that discounted amount, plus shipping. `src/billing/total.js` composes `applyCodes`, `computeTax`, and `shippingCents`. Discounts live in `discount.js`, codes in `codes.js`, and regional tax rates in `tax.js`.",
    ],
    [
      "Shipping",
      "`src/shipping/zones.js` computes shipping from the destination zone, the parcel weight, and the discounted subtotal. docs/SHIPPING.md is the specification; the code should follow it exactly.",
    ],
    [
      "Catalog imports",
      "The merchandising team exports the catalog as CSV with the columns name, qty, and price. Product names can contain commas and quotes, so exports quote those fields. `scripts/import-catalog.js` parses the export with `src/csv/parse.js` and fails when a row does not parse into a name, a quantity, and a price.",
    ],
    [
      "Legacy report",
      "`src/legacy/report.js` is vendored from the reporting team's repository and updated by copying their releases. It imports our billing functions by name, so those names are part of our public interface.",
    ],
    ...modules.map((module) => [
      module.path,
      `Exports ${module.imports.map((name) => `\`${name}\``).join(", ")}. It has no dependencies on other modules, and its tests in ${module.path.replace(/^src\//, "test/").replace(/\.js$/, ".test.js")} cover the edge cases callers rely on.`,
    ]),
  ];
  return `# Architecture

shopline is a set of small modules that the checkout service and the reporting jobs import. The
modules are pure: they take plain objects and return values, and only scripts touch files.

## Orders

An order is a plain object:

\`\`\`json
{ "id": "ORD-10432", "date": "2024-05-03", "region": "NW", "zone": "B", "weightGrams": 1840,
  "codes": [{ "code": "SPRING10", "percent": 10 }],
  "lines": [{ "id": "L1", "sku": "...", "qty": 2, "unitCents": 1250 }] }
\`\`\`

${sections.map(([heading, text]) => `## ${heading}\n\n${text}`).join("\n\n")}
`;
}

export function shippingDoc(params: RepoParams): string {
  const destinations = {
    A: "Same state",
    B: "Neighboring states",
    C: "Rest of the country",
    X: "International",
  };
  const rows = ZONE_IDS.map((zone) => {
    const rates = params.zones[zone];
    const free = rates.freeOver === null ? "never" : dollars(rates.freeOver);
    return `| ${zone} | ${destinations[zone]} | ${dollars(rates.base)} | ${dollars(rates.perKg)} | ${free} |`;
  });
  return `# Shipping

This document is the specification for shipping costs. Customer service quotes from it, so the
code must match it exactly.

## Zones

| Zone | Destinations | First kilogram | Each additional kilogram | Free shipping from |
|---|---|---|---|---|
${rows.join("\n")}

## Rules

1. Weight is the total parcel weight in grams, rounded up to whole kilograms. Anything up to
   1,000 g counts as 1 kg; 1,001 g counts as 2 kg.
2. The first kilogram costs the zone's first-kilogram rate. Each additional started kilogram costs
   the zone's additional-kilogram rate.
3. Shipping is free when the order's discounted subtotal is at least the zone's threshold. Zone X
   never ships free.
4. The table is in dollars for readability; the code works in integer cents.
5. An unknown zone is a programming error: throw a RangeError.

## Packaging

Parcels up to 2 kg ship in padded envelopes; heavier parcels ship in boxes. Fragile items, such as
vases and clocks, are boxed regardless of weight. Packaging cost is included in the rates above.

## Carriers

Zones A and B ship with the regional courier, which collects every weekday afternoon. Zone C ships
with the national post. Zone X ships with the international post and needs a customs declaration,
which the warehouse prints from the order lines.

## Returns

Customers pay return shipping unless the item arrived damaged. Refunds never include the original
shipping cost.
`;
}

function line(rng: Rng, index: number, prefix: string, round: boolean) {
  return {
    id: `L${index + 1}`,
    sku: `${prefix}-${rng.pick(CATEGORIES)}-${String(rng.int(1, 9999)).padStart(5, "0")}`,
    qty: rng.int(1, 4),
    unitCents: round ? rng.int(5, 60) * 100 : rng.int(199, 9999),
  };
}

const code = (rng: Rng, percent: number): Code => ({
  code: `${rng.pick(CODE_NAMES)}${percent}`,
  percent,
});

/** The order export, with one disputed order that carries two codes. */
export function orders(
  rng: Rng,
  prefix: string,
  count: number,
): { orders: Order[]; disputed: number } {
  const disputed = rng.int(Math.floor(count / 3), Math.floor((2 * count) / 3));
  const start = Date.UTC(2024, 4, 1);
  const list: Order[] = [];
  for (let index = 0; index < count; index++) {
    const special = index === disputed;
    const roll = rng.next();
    const percents = rng.sample([5, 10, 15, 20, 25], 2);
    const codes = special
      ? percents.map((percent) => code(rng, percent))
      : roll < 0.7
        ? []
        : [code(rng, percents[0] ?? 10)];
    list.push({
      id: `ORD-${10400 + index * 3 + rng.int(0, 2)}`,
      date: new Date(start + Math.floor(index / 12) * 86_400_000).toISOString().slice(0, 10),
      region: rng.pick(REGIONS),
      zone: rng.pick(ZONE_IDS),
      weightGrams: rng.int(150, 6000),
      codes,
      lines: Array.from({ length: special ? 3 : rng.int(1, 4) }, (_, at) =>
        line(rng, at, prefix, special),
      ),
    });
  }
  return { orders: list, disputed };
}

export function csvFailures(rng: Rng): CsvFailure[] {
  const first = `${rng.pick(NOUNS)}, ${rng.pick(["large", "small", "boxed", "set of 2"])}`;
  const second = `${rng.int(6, 18)}" ${rng.pick(ADJECTIVES)} ${rng.pick(NOUNS).toLowerCase()}`;
  const rows = [rng.int(60, 250), rng.int(300, 560)];
  return [first, second].map((name, index) => {
    const qty = String(rng.int(1, 9));
    const price = String(rng.int(199, 9999));
    const input = `"${name.replaceAll('"', '""')}",${qty},${price}`;
    return { row: rows[index] ?? 0, input, expected: [name, qty, price], actual: splitCsv(input) };
  });
}

/** A CI log of about 20K tokens in which two import rows decide ticket 1. */
export function ciLog(rng: Rng, params: RepoParams, testNames: readonly string[]): string {
  let time = Date.UTC(2026, 8, 28, 2, 0, 0);
  const out: string[] = [];
  const log = (text: string) => {
    time += rng.int(1, 90);
    out.push(`${new Date(time).toISOString()} ${text}`);
  };
  log(`Job ci #${params.ciRun} on main (ubuntu-24.04)`);
  log("##[group]Run actions/checkout@v4");
  for (const step of [
    "Syncing repository: museum/shopline",
    "Fetching the repository",
    "Checking out the ref",
    "HEAD is now at 4be1f0c Merge pull request #412",
  ])
    log(step);
  log("##[endgroup]");
  log("##[group]Run actions/setup-node@v4 with node-version 22");
  log("Found in cache @ /opt/hostedtoolcache/node/22.11.0/x64");
  log("##[endgroup]");
  log("##[group]Run node --test");
  log("TAP version 13");
  let count = 0;
  for (let pass = 0; pass < 3; pass++) {
    for (const name of testNames) {
      count++;
      log(`# Subtest: ${name}`);
      log(`ok ${count} - ${name}`);
      log("  ---");
      log(`  duration_ms: ${(rng.next() * 3).toFixed(4)}`);
      log("  ...");
    }
  }
  log(`1..${count}`);
  log(`# tests ${count}`);
  log(`# pass ${count}`);
  log("# fail 0");
  log("##[endgroup]");
  log("##[group]Run node scripts/import-catalog.js fixtures/catalog-2024.csv");
  log("[import] downloading fixtures/catalog-2024.csv (612 rows)");
  const failures = new Map(params.csvFailures.map((failure) => [failure.row, failure]));
  for (let row = 1; row <= 600; row++) {
    const failure = failures.get(row);
    if (failure) {
      log(`[import] row ${row}: FAILED parseCsvLine(${JSON.stringify(failure.input)})`);
      log(`[import]   expected: ${JSON.stringify(failure.expected)}`);
      log(`[import]   actual:   ${JSON.stringify(failure.actual)}`);
      continue;
    }
    const name = `${rng.pick(ADJECTIVES)} ${rng.pick(NOUNS).toLowerCase()}`;
    log(
      `[import] row ${row}: ok name="${name}" qty=${rng.int(1, 40)} price=${rng.int(199, 9999)} sku=${params.skuPrefix}-${rng.pick(CATEGORIES)}-${String(rng.int(1, 9999)).padStart(5, "0")}`,
    );
  }
  log(`[import] summary: ${600 - failures.size} rows ok, ${failures.size} failed`);
  log("##[error]Process completed with exit code 1.");
  log("##[endgroup]");
  log("Post job cleanup.");
  log("Cleaning up orphan processes");
  return `${out.join("\n")}\n`;
}
