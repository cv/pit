/**
 * Generates the realistic long task (#205): a seeded maintenance session on "shopline", a small
 * dependency-free Node.js library. Eight tickets arrive one at a time as user messages. Some set
 * standing rules that later tickets must keep, and some need facts found only in a CI log, a
 * specification, or a data file. Hidden tests and static checks score the final repository.
 */
import { random } from "../tasks.js";
import {
  architecture,
  changelog,
  ciLog,
  contributing,
  csvFailures,
  orders as generateOrders,
  packageJson,
  readme,
  shippingDoc,
} from "./artifacts.js";
import { fillerModules, regressionSuite, visibleTest } from "./fillers.js";
import { legacyRegression, ticketSuites } from "./hidden.js";
import {
  bestCode,
  dollars,
  REGIONS,
  type RepoParams,
  type RepoTask,
  type Rounding,
  stackedCodes,
  subtotalOf,
  type Ticket,
  type Zone,
  type ZoneRates,
} from "./model.js";
import { fixedOrderSources, shippedOrderSources } from "./sources-orders.js";
import { fixedSources, shippedSources } from "./sources.js";

const TAX_RATES = [600, 625, 700, 725, 775, 825, 850, 875, 900, 950];

const ROUNDING_TEXT: Record<Rounding, string> = {
  "half-even": "round half to even, to whichever of the two cents is even",
  "half-up": "round half up, to the higher of the two cents",
};

export function tickets(params: RepoParams): Ticket[] {
  const { disputed } = params;
  const texts = [
    `Last night's CI run #${params.ciRun} on main failed in the catalog import step. The full log is in logs/ci-${params.ciRun}.log. Find what failed, fix the cause in the code, and add regression tests for the failing inputs.`,
    `We're moving all money handling to integer cents. This is a standing rule from now on: in src/money/ and src/billing/, amounts are integer cents, and parseFloat and toFixed must not be used there (src/money/format.js may keep toFixed for display). Start with applyDiscount in src/billing/discount.js: it should take an amount in integer cents and return integer cents. When the exact result falls halfway between two cents, ${ROUNDING_TEXT[params.rounding]}. Update its tests.`,
    "shippingCents in src/shipping/zones.js still returns a placeholder. Implement it as specified in docs/SHIPPING.md, with tests.",
    "Two more standing rules, effective now. First, src/legacy/ is vendored from the reporting team: never modify anything under it. Second, every new exported function needs a JSDoc comment that includes `@since 2.4`. Today's task: add refundCents(order, lineIds) in a new file, src/billing/refunds.js. It returns the refund in integer cents for the listed line IDs: the sum of qty × unitCents over those lines, with the order's discount codes applied through applyCodes from src/billing/codes.js. Tax and shipping are not refunded. Unknown line IDs throw a RangeError. Add tests.",
    "Finance reports that tax is sometimes a cent short. computeTax in src/billing/tax.js should round to the nearest cent instead of truncating, and an exact half cent must be rounded with the same rule we agreed for discounts in ticket 2. Add tests that cover halves.",
    `A customer disputes order ${disputed.id} in data/orders.jsonl. Its discounted subtotal came to ${dollars(disputed.charged)}, but under our policy it should have been ${dollars(disputed.expected)}. The policy: when an order carries several discount codes, only the single best one (the highest percent) applies, computed exactly as applyDiscount computes it. Find the bug, fix it, and add tests.`,
    "Rename calcTotal to orderTotal in src/billing/total.js, and update every caller and test to use the new name. Keep calcTotal exported from total.js as a deprecated alias for compatibility.",
    'Wrap-up: in CHANGELOG.md, add a "## 2.4.0" section at the top with one line per ticket you completed, in the form "- T<n>: <summary>" (for example "- T3: ..."), and make sure the whole suite passes with node --test.',
  ];
  return texts.map((text, index) => ({ id: index + 1, text }));
}

const REFERENCE_CHANGELOG = [
  "- T1: Parse quoted CSV fields and doubled quotes in catalog imports.",
  "- T2: applyDiscount works in integer cents.",
  "- T3: Shipping costs follow docs/SHIPPING.md.",
  "- T4: Added refundCents.",
  "- T5: computeTax rounds to the nearest cent.",
  "- T6: Only the best discount code applies.",
  "- T7: Renamed calcTotal to orderTotal; calcTotal is a deprecated alias.",
];

function zones(rng: ReturnType<typeof random>): Record<Zone, ZoneRates> {
  return {
    A: { base: rng.int(30, 50) * 10, perKg: rng.int(5, 15) * 10, freeOver: rng.int(50, 80) * 100 },
    B: {
      base: rng.int(50, 80) * 10,
      perKg: rng.int(10, 25) * 10,
      freeOver: rng.int(80, 120) * 100,
    },
    C: {
      base: rng.int(80, 120) * 10,
      perKg: rng.int(20, 40) * 10,
      freeOver: rng.int(120, 200) * 100,
    },
    X: { base: rng.int(150, 250) * 10, perKg: rng.int(50, 90) * 10, freeOver: null },
  };
}

export function generateRepo(seed: number): RepoTask {
  const rng = random(seed, "repo");
  const rounding = rng.pick<Rounding>(["half-even", "half-up"]);
  const rates = rng.sample(TAX_RATES, REGIONS.length);
  const skuPrefix = rng.pick(["SHP", "SLN", "MUS"]);
  const { orders, disputed: index } = generateOrders(rng, skuPrefix, 300);
  const order = orders[index];
  if (!order) throw new Error("No disputed order");
  const subtotal = subtotalOf(order);
  const params: RepoParams = {
    rounding,
    taxBps: Object.fromEntries(REGIONS.map((region, at) => [region, rates[at] ?? 600])),
    zones: zones(rng),
    skuPrefix,
    ciRun: rng.int(1800, 4999),
    csvFailures: csvFailures(rng),
    disputed: {
      id: order.id,
      subtotal,
      codes: order.codes,
      charged: stackedCodes(subtotal, order.codes),
      expected: bestCode(subtotal, order.codes, rounding),
    },
  };
  const modules = fillerModules(rng, skuPrefix);
  const sample = orders.slice(0, 3);
  const testNames = modules.flatMap((module) => module.cases.map(([name]) => name));
  const files: Record<string, string> = {
    "package.json": packageJson(),
    ".gitignore": "node_modules/\nfixtures/\n",
    "README.md": readme(modules),
    "CONTRIBUTING.md": contributing(),
    "CHANGELOG.md": changelog(),
    "docs/ARCHITECTURE.md": architecture(modules),
    "docs/SHIPPING.md": shippingDoc(params),
    ...shippedSources(params),
    ...shippedOrderSources(),
    ...Object.fromEntries(
      modules.flatMap((module) => [[module.path, module.source], visibleTest(module)]),
    ),
    "data/orders.jsonl": `${orders.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    [`logs/ci-${params.ciRun}.log`]: ciLog(rng, params, testNames),
  };
  return {
    seed,
    files,
    hidden: [
      ...ticketSuites(params, rng, sample),
      regressionSuite(modules, legacyRegression(sample)),
    ],
    reference: {
      ...fixedSources(params),
      ...fixedOrderSources(params),
      "CHANGELOG.md": changelog(REFERENCE_CHANGELOG),
    },
    tickets: tickets(params),
    params,
    orders,
  };
}
