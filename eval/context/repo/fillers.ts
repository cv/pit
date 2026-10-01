/**
 * Supporting modules of the generated repository that no ticket changes. They give the repository
 * realistic bulk, and their tests double as hidden regression tests.
 */
import type { Rng } from "./model.js";

const js = String.raw;

export interface Module {
  path: string;
  source: string;
  imports: string[];
  /** Test names and bodies; each body is a block of assertions. */
  cases: Array<[string, string]>;
}

const sku = (prefix: string, width: number): Module => {
  const padded = (value: number) => String(value).padStart(width, "0");
  return {
    path: "src/catalog/sku.js",
    imports: ["formatSku", "parseSku"],
    source: js`/**
 * Catalog SKUs. A SKU is ${prefix}-CAT-${"N".repeat(width)}: the store prefix, a three-letter category
 * code, and a zero-padded item number.
 */
const PREFIX = "${prefix}";
const WIDTH = ${width};
const PATTERN = /^${prefix}-([A-Z]{3})-(\d{${width}})$/;

/**
 * Formats a SKU from a category name and an item number.
 * @param {string} category
 * @param {number} number
 * @returns {string}
 */
export function formatSku(category, number) {
  if (!Number.isInteger(number) || number < 0) {
    throw new RangeError("Item numbers are non-negative integers");
  }
  const code = category.replace(/[^a-z]/gi, "").slice(0, 3).toUpperCase().padEnd(3, "X");
  return PREFIX + "-" + code + "-" + String(number).padStart(WIDTH, "0");
}

/**
 * Parses a SKU into its category code and item number, or returns null.
 * @param {string} sku
 * @returns {{ category: string, number: number } | null}
 */
export function parseSku(sku) {
  const match = PATTERN.exec(sku);
  return match ? { category: match[1], number: Number(match[2]) } : null;
}
`,
    cases: [
      [
        "formats a SKU",
        `  assert.equal(formatSku("lanterns", 42), "${prefix}-LAN-${padded(42)}");`,
      ],
      [
        "pads short categories",
        `  assert.equal(formatSku("ab", 7), "${prefix}-ABX-${padded(7)}");`,
      ],
      [
        "parses a formatted SKU",
        `  assert.deepEqual(parseSku(formatSku("maps", 123)), { category: "MAP", number: 123 });`,
      ],
      ["rejects malformed SKUs", `  assert.equal(parseSku("nope"), null);`],
      ["rejects negative numbers", `  assert.throws(() => formatSku("maps", -1), RangeError);`],
    ],
  };
};

const slug = (max: number): Module => ({
  path: "src/catalog/slug.js",
  imports: ["slugify"],
  source: js`/** The default maximum slug length for catalog URLs. */
const MAX_LENGTH = ${max};

/**
 * A URL slug for a product title: lowercase ASCII words joined by dashes, cut at a word boundary
 * when longer than maxLength.
 * @param {string} title
 * @param {number} [maxLength]
 * @returns {string}
 */
export function slugify(title, maxLength = MAX_LENGTH) {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= maxLength) return slug;
  const cut = slug.slice(0, maxLength);
  if (slug[maxLength] === "-") return cut;
  const dash = cut.lastIndexOf("-");
  return dash > 0 ? cut.slice(0, dash) : cut;
}
`,
  cases: [
    [
      "slugifies a title",
      `  assert.equal(slugify("Brass Lantern (Large)"), "brass-lantern-large");`,
    ],
    ["strips accents", `  assert.equal(slugify("  Café   Maps "), "cafe-maps");`],
    [
      "cuts at a word boundary",
      `  assert.equal(slugify("north harbor reading room lantern", 12), "north-harbor");\n  assert.equal(slugify("north harbor reading room lantern", 14), "north-harbor");`,
    ],
    [
      "applies the default limit",
      `  assert.equal(slugify("x".repeat(${max + 5})), "x".repeat(${max}));`,
    ],
  ],
});

const title = (): Module => ({
  path: "src/catalog/title.js",
  imports: ["titleCase"],
  source: js`const SMALL_WORDS = new Set(["a", "an", "and", "at", "for", "in", "of", "on", "the", "to"]);

/**
 * Title case for product names: every word capitalized except small words after the first.
 * @param {string} text
 * @returns {string}
 */
export function titleCase(text) {
  return text
    .trim()
    .split(/\s+/)
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index > 0 && SMALL_WORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}
`,
  cases: [
    [
      "capitalizes words but not small ones",
      `  assert.equal(titleCase("the LANTERN of the north"), "The Lantern of the North");`,
    ],
    ["collapses whitespace", `  assert.equal(titleCase("  brass   map "), "Brass Map");`],
  ],
});

const stock = (low: number, critical: number): Module => ({
  path: "src/inventory/stock.js",
  imports: ["stockStatus", "reorderQuantity"],
  source: js`/** Stock levels at or below these quantities are reported as low or critical. */
const LOW = ${low};
const CRITICAL = ${critical};

/**
 * The stock status for a quantity on hand: "out", "critical", "low", or "ok".
 * @param {number} quantity
 * @returns {string}
 */
export function stockStatus(quantity) {
  if (quantity <= 0) return "out";
  if (quantity <= CRITICAL) return "critical";
  if (quantity <= LOW) return "low";
  return "ok";
}

/**
 * How many units to reorder to reach a target, in whole packs.
 * @param {number} quantity Units on hand.
 * @param {number} target Units wanted on hand.
 * @param {number} packSize Units per pack.
 * @returns {number}
 */
export function reorderQuantity(quantity, target, packSize) {
  if (packSize <= 0) throw new RangeError("Pack size must be positive");
  const missing = Math.max(0, target - quantity);
  return Math.ceil(missing / packSize) * packSize;
}
`,
  cases: [
    [
      "reports stock levels",
      [
        `  assert.equal(stockStatus(0), "out");`,
        `  assert.equal(stockStatus(${critical}), "critical");`,
        `  assert.equal(stockStatus(${critical + 1}), "low");`,
        `  assert.equal(stockStatus(${low}), "low");`,
        `  assert.equal(stockStatus(${low + 1}), "ok");`,
      ].join("\n"),
    ],
    [
      "reorders in whole packs",
      `  assert.equal(reorderQuantity(7, 50, 12), 48);\n  assert.equal(reorderQuantity(60, 50, 12), 0);`,
    ],
    ["rejects empty packs", `  assert.throws(() => reorderQuantity(1, 2, 0), RangeError);`],
  ],
});

const batches = (): Module => ({
  path: "src/inventory/batches.js",
  imports: ["chunk", "groupBy"],
  source: js`/**
 * Splits items into batches of at most size items.
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @returns {T[][]}
 */
export function chunk(items, size) {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("Batch size must be at least 1");
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

/**
 * Groups items by a key, preserving order within each group.
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string} key
 * @returns {Record<string, T[]>}
 */
export function groupBy(items, key) {
  const groups = {};
  for (const item of items) (groups[key(item)] ??= []).push(item);
  return groups;
}
`,
  cases: [
    ["chunks items", `  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);`],
    ["rejects empty batches", `  assert.throws(() => chunk([1], 0), RangeError);`],
    [
      "groups items by key",
      `  assert.deepEqual(groupBy(["ab", "b", "ac"], (word) => word[0]), { a: ["ab", "ac"], b: ["b"] });`,
    ],
  ],
});

const stats = (): Module => ({
  path: "src/reports/stats.js",
  imports: ["mean", "median", "percentile"],
  source: js`function sorted(values) {
  if (values.length === 0) throw new RangeError("No values");
  return [...values].sort((a, b) => a - b);
}

/**
 * The arithmetic mean of some numbers.
 * @param {number[]} values
 * @returns {number}
 */
export function mean(values) {
  return sorted(values).reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * The median: the middle value, or the mean of the two middle values.
 * @param {number[]} values
 * @returns {number}
 */
export function median(values) {
  const list = sorted(values);
  const middle = Math.floor(list.length / 2);
  return list.length % 2 === 1 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
}

/**
 * The nearest-rank percentile, for p from 0 (exclusive) to 100.
 * @param {number[]} values
 * @param {number} p
 * @returns {number}
 */
export function percentile(values, p) {
  if (!(p > 0 && p <= 100)) throw new RangeError("Percentiles are in (0, 100]");
  const list = sorted(values);
  return list[Math.ceil((p / 100) * list.length) - 1];
}
`,
  cases: [
    ["averages values", `  assert.equal(mean([2, 4, 9]), 5);`],
    [
      "finds medians",
      `  assert.equal(median([5, 1, 3]), 3);\n  assert.equal(median([4, 1, 3, 2]), 2.5);`,
    ],
    [
      "finds nearest-rank percentiles",
      `  assert.equal(percentile([15, 20, 35, 40, 50], 40), 20);\n  assert.equal(percentile([15, 20, 35, 40, 50], 100), 50);`,
    ],
    ["rejects empty input", `  assert.throws(() => mean([]), RangeError);`],
  ],
});

const dates = (): Module => ({
  path: "src/reports/dates.js",
  imports: ["daysBetween", "addDays", "weekday"],
  source: js`const DAY = 86400000;
const NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function parse(iso) {
  const time = Date.parse(iso + "T00:00:00Z");
  if (Number.isNaN(time)) throw new RangeError("Not a date: " + iso);
  return time;
}

/**
 * Whole days from one ISO date to another.
 * @param {string} from
 * @param {string} to
 * @returns {number}
 */
export function daysBetween(from, to) {
  return Math.round((parse(to) - parse(from)) / DAY);
}

/**
 * An ISO date some days later (or earlier, for negative days).
 * @param {string} iso
 * @param {number} days
 * @returns {string}
 */
export function addDays(iso, days) {
  return new Date(parse(iso) + days * DAY).toISOString().slice(0, 10);
}

/**
 * The English weekday name of an ISO date.
 * @param {string} iso
 * @returns {string}
 */
export function weekday(iso) {
  return NAMES[new Date(parse(iso)).getUTCDay()];
}
`,
  cases: [
    ["counts days between dates", `  assert.equal(daysBetween("2024-03-01", "2024-03-31"), 30);`],
    ["adds days across a leap day", `  assert.equal(addDays("2024-02-28", 2), "2024-03-01");`],
    ["names weekdays", `  assert.equal(weekday("2024-05-01"), "Wednesday");`],
    ["rejects malformed dates", `  assert.throws(() => addDays("soon", 1), RangeError);`],
  ],
});

const paginate = (perPage: number): Module => ({
  path: "src/util/paginate.js",
  imports: ["paginate"],
  source: js`/** Items per page in listings unless a caller asks for another size. */
const PER_PAGE = ${perPage};

/**
 * One page of a list, with the page count.
 * @template T
 * @param {T[]} items
 * @param {number} [page] The page number, starting at 1.
 * @param {number} [perPage]
 * @returns {{ items: T[], page: number, pages: number, total: number }}
 */
export function paginate(items, page = 1, perPage = PER_PAGE) {
  if (!Number.isInteger(page) || page < 1) throw new RangeError("Pages start at 1");
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), page, pages, total: items.length };
}
`,
  cases: [
    [
      "returns one page",
      `  const result = paginate(Array.from({ length: 45 }, (_, index) => index), 2, 20);\n  assert.deepEqual(result.items, Array.from({ length: 20 }, (_, index) => index + 20));\n  assert.equal(result.pages, 3);`,
    ],
    [
      "handles empty lists",
      `  assert.deepEqual(paginate([]), { items: [], page: 1, pages: 1, total: 0 });`,
    ],
    [
      "uses the default page size",
      `  assert.equal(paginate(Array.from({ length: ${perPage + 1} })).pages, 2);`,
    ],
  ],
});

const weights = (): Module => ({
  path: "src/util/weights.js",
  imports: ["formatWeight", "parseWeight"],
  source: js`/**
 * Formats a weight in grams for labels: grams below 1 kg, otherwise kilograms to two decimals.
 * @param {number} grams
 * @returns {string}
 */
export function formatWeight(grams) {
  if (grams < 1000) return grams + " g";
  return String(Math.round(grams / 10) / 100) + " kg";
}

/**
 * Parses a label weight such as "1.5 kg" or "750g" into grams.
 * @param {string} text
 * @returns {number}
 */
export function parseWeight(text) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(kg|g)\s*$/i.exec(text);
  if (!match) throw new RangeError("Not a weight: " + text);
  const value = Number(match[1]);
  return Math.round(match[2].toLowerCase() === "kg" ? value * 1000 : value);
}
`,
  cases: [
    [
      "formats weights",
      `  assert.equal(formatWeight(750), "750 g");\n  assert.equal(formatWeight(1250), "1.25 kg");\n  assert.equal(formatWeight(2000), "2 kg");`,
    ],
    [
      "parses weights",
      `  assert.equal(parseWeight("1.5 kg"), 1500);\n  assert.equal(parseWeight("750g"), 750);`,
    ],
    ["rejects malformed weights", `  assert.throws(() => parseWeight("heavy"), RangeError);`],
  ],
});

export function fillerModules(rng: Rng, skuPrefix: string): Module[] {
  const critical = rng.int(2, 5);
  return [
    sku(skuPrefix, rng.int(4, 6)),
    slug(rng.int(20, 32)),
    title(),
    stock(rng.int(10, 25), critical),
    batches(),
    stats(),
    dates(),
    paginate(rng.int(10, 25)),
    weights(),
  ];
}

const TEST_HEADER = js`import { test } from "node:test";
import assert from "node:assert/strict";
`;

const block = (name: string, body: string) =>
  `test(${JSON.stringify(name)}, () => {\n${body}\n});\n`;

/** The module's visible test file, beside the others under test/. */
export function visibleTest(module: Module): [string, string] {
  const path = module.path.replace(/^src\//, "test/").replace(/\.js$/, ".test.js");
  const source = `${TEST_HEADER}import { ${module.imports.join(", ")} } from "../../${module.path}";\n\n${module.cases
    .map(([name, body]) => block(name, body))
    .join("\n")}`;
  return [path, source];
}

/** One hidden file with every module's cases, named `REG <module>: <case>`. */
export function regressionSuite(modules: readonly Module[], legacy: string) {
  const tests: string[] = [];
  const blocks: string[] = [];
  const imports = modules.map(
    (module) => `import { ${module.imports.join(", ")} } from "../${module.path}";`,
  );
  for (const module of modules) {
    for (const [name, body] of module.cases) {
      const full = `REG ${module.path}: ${name}`;
      tests.push(full);
      blocks.push(block(full, body));
    }
  }
  tests.push("REG src/legacy/report.js: formats order totals");
  blocks.push(block("REG src/legacy/report.js: formats order totals", legacy));
  return {
    check: "REG",
    file: "regression.test.js",
    tests,
    source: `${TEST_HEADER}${imports.join("\n")}\nimport { legacyReport } from "../src/legacy/report.js";\nimport { formatCents } from "../src/money/format.js";\nimport * as total from "../src/billing/total.js";\n\n${blocks.join("\n")}`,
  };
}
