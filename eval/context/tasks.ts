/**
 * Deterministic ContextBench-style task generators for the context-management evaluation (#205).
 *
 * A task streams chunks through the eval feed. Some chunks end with questions whose exact answers
 * depend on earlier chunks, so a model must retain, note, or offload what matters while its
 * context window holds only part of the stream.
 */

export const TASK_KINDS = ["needle", "kv", "logs", "ledger"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export interface Question {
  id: string;
  prompt: string;
  answer: string;
  /** Chunks between the chunk that decides the answer and the chunk that asks the question. */
  distance: number;
}

export interface Chunk {
  text: string;
  questions: Question[];
}

export interface Task {
  kind: TaskKind;
  seed: number;
  /** What the feed contains and what its questions ask about. */
  description: string;
  chunks: Chunk[];
}

export interface TaskSize {
  chunks: number;
  /** Approximate tokens per chunk by Pi's four-characters-per-token estimate. */
  chunkTokens: number;
}

export const DEFAULT_SIZE: TaskSize = { chunks: 24, chunkTokens: 2500 };

/** Pi's context estimate: about four characters per token. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export function generateTask(kind: TaskKind, seed: number, size: TaskSize = DEFAULT_SIZE): Task {
  if (!Number.isInteger(size.chunks) || size.chunks < 4 || size.chunks > 400) {
    throw new Error("A task needs 4 to 400 chunks");
  }
  if (!Number.isInteger(size.chunkTokens) || size.chunkTokens < 500 || size.chunkTokens > 50_000) {
    throw new Error("Chunks need 500 to 50000 tokens");
  }
  const rng = random(seed, kind);
  const chunks = GENERATORS[kind](rng, size);
  return { kind, seed, description: DESCRIPTIONS[kind], chunks };
}

const DESCRIPTIONS: Record<TaskKind, string> = {
  needle:
    "The feed is long prose. Scattered sentences record vault access codes. Questions ask for the exact access code of a named vault.",
  kv: "The feed stores account records: `PUT <key>` followed by a JSON value, among unrelated text. Questions ask for one field of a stored record by key.",
  logs: "The feed is one long service log. Questions ask about its ERROR lines: their order, count, services, request IDs, and error codes.",
  ledger:
    "The feed is a transaction ledger for a few accounts. It starts with opening balances; transfers, deposits, and withdrawals change them, and `VOID <id>` cancels an earlier transaction. Questions ask for current balances.",
};

type Rng = ReturnType<typeof random>;

const GENERATORS: Record<TaskKind, (rng: Rng, size: TaskSize) => Chunk[]> = {
  needle,
  kv,
  logs,
  ledger,
};

function needle(rng: Rng, size: TaskSize): Chunk[] {
  const vaults = uniqueNames(rng, size.chunks * 2, () => `${rng.pick(STARS)}-${rng.int(10, 99)}`);
  const facts = vaults.map((vault, index) => ({
    vault,
    code: `${rng.code(4)}-${rng.code(4)}`,
    chunk: Math.floor(index / 2),
  }));
  const checkpoints = new Map<number, typeof facts>();
  const middle = Math.floor(size.chunks / 2) - 1;
  const early = facts.filter((fact) => fact.chunk < Math.max(1, Math.floor(size.chunks / 4)));
  const midQuestions = rng.sample(early, 3);
  checkpoints.set(middle, midQuestions);
  const remaining = facts.filter((fact) => !midQuestions.includes(fact));
  checkpoints.set(size.chunks - 1, stratified(rng, remaining, 8, size.chunks));
  let id = 0;
  return range(size.chunks).map((chunk) => {
    const inserts = facts
      .filter((fact) => fact.chunk === chunk)
      .map((fact) => `For the record, the access code for vault ${fact.vault} is ${fact.code}.`);
    const questions = (checkpoints.get(chunk) ?? []).map((fact) => ({
      id: `q${++id}`,
      prompt: `What is the access code for vault ${fact.vault}?`,
      answer: fact.code,
      distance: chunk - fact.chunk,
    }));
    return { text: proseWith(rng, size.chunkTokens, inserts), questions };
  });
}

function kv(rng: Rng, size: TaskSize): Chunk[] {
  const perChunk = 3;
  const keys = uniqueNames(rng, size.chunks * perChunk, () => `acct-${rng.int(1000, 9999)}`);
  const records = keys.map((key, index) => ({
    key,
    chunk: Math.floor(index / perChunk),
    value: {
      owner: `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`,
      email: `${rng.pick(FIRST_NAMES).toLowerCase()}.${rng.code(5, "abcdefghijkmnpqrstuvwxyz")}@example.com`,
      plan: rng.pick(["free", "starter", "team", "business", "enterprise"]),
      region: rng.pick(["us-east-1", "us-west-2", "eu-west-1", "eu-central-1", "ap-south-1"]),
      quota: rng.int(10, 5000),
      token: rng.code(24, "0123456789abcdef"),
      created: `20${rng.int(18, 25)}-${pad(rng.int(1, 12))}-${pad(rng.int(1, 28))}`,
      tags: rng.sample(TAGS, 3),
      notes: sentence(rng, 18) + " " + sentence(rng, 14),
    },
  }));
  const fields = ["email", "plan", "region", "quota", "token", "created"] as const;
  let id = 0;
  return range(size.chunks).map((chunk) => {
    const stored = records.filter((record) => record.chunk === chunk);
    const inserts = stored.map(
      (record) => `PUT ${record.key}\n${JSON.stringify(record.value, null, 2)}`,
    );
    const last = chunk === size.chunks - 1;
    const isCheckpoint = last || (chunk > 0 && chunk % 4 === 3);
    const older = records.filter((record) => record.chunk < chunk);
    const queried = isCheckpoint ? rng.sample(older, last ? 4 : 2) : [];
    const questions = queried.map((record) => {
      const field = rng.pick(fields);
      return {
        id: `q${++id}`,
        prompt: `What is the \`${field}\` of the record stored under ${record.key}?`,
        answer: String(record.value[field]),
        distance: chunk - record.chunk,
      };
    });
    return { text: proseWith(rng, size.chunkTokens, inserts), questions };
  });
}

function logs(rng: Rng, size: TaskSize): Chunk[] {
  const errorCount = rng.int(5, 8);
  // Distinct chunks after the first, in order, so "first" and "last" are unambiguous.
  const errorChunks = rng.sample(
    range(size.chunks - 1).map((chunk) => chunk + 1),
    errorCount,
  );
  errorChunks.sort((a, b) => a - b);
  const requests = uniqueNames(rng, errorCount, () => `r-${rng.code(6, "0123456789abcdef")}`);
  const codes = uniqueNames(rng, errorCount, () => `E${rng.int(100, 999)}`);
  const errors = errorChunks.map((chunk, index) => ({
    chunk,
    service: rng.pick(SERVICES),
    request: requests[index] ?? "",
    code: codes[index] ?? "",
    reason: rng.pick(ERROR_REASONS),
  }));
  const first = errors[0];
  const last = errors.at(-1);
  const middle = errors[Math.floor(errors.length / 2)];
  if (!first || !last || !middle) throw new Error("A log task needs errors");
  const checkpoints = new Set([
    Math.floor(size.chunks / 3) - 1,
    Math.floor((2 * size.chunks) / 3) - 1,
  ]);
  const final = size.chunks - 1;
  let id = 0;
  const question = (prompt: string, answer: string, chunk: number, decidedAt: number) => ({
    id: `q${++id}`,
    prompt,
    answer,
    distance: chunk - decidedAt,
  });
  const seenBy = (chunk: number) => errors.filter((error) => error.chunk <= chunk);
  let clock = Date.UTC(2026, 2, 1, 8, 0, 0);
  return range(size.chunks).map((chunk) => {
    const times: string[] = [];
    const lines: string[] = [];
    while (estimateTokens(lines.join("\n")) < size.chunkTokens) {
      clock += rng.int(5, 900);
      times.push(new Date(clock).toISOString());
      lines.push(`${times.at(-1)} ${noiseLine(rng)}`);
    }
    const error = errors.find((candidate) => candidate.chunk === chunk);
    if (error) {
      // Replace one noise line, keeping its timestamp in order.
      const at = rng.int(0, lines.length - 1);
      lines[at] =
        `${times[at]} ERROR [${error.service}] request ${error.request} failed with code ${error.code}: ${error.reason}`;
    }
    const questions: Question[] = [];
    if (checkpoints.has(chunk)) {
      const seen = seenBy(chunk);
      const latest = seen.at(-1);
      questions.push(
        question(
          "How many ERROR lines has the log contained so far?",
          String(seen.length),
          chunk,
          seen[0]?.chunk ?? chunk,
        ),
      );
      if (latest) {
        questions.push(
          question(
            "Which request did the most recent ERROR line so far report?",
            latest.request,
            chunk,
            latest.chunk,
          ),
        );
      }
    }
    if (chunk === final) {
      questions.push(
        question(
          "What error code did the first ERROR line report?",
          first.code,
          chunk,
          first.chunk,
        ),
        question("Which service logged the last ERROR line?", last.service, chunk, last.chunk),
        question(
          `Which request failed with error code ${middle.code}?`,
          middle.request,
          chunk,
          middle.chunk,
        ),
        question(
          "How many ERROR lines did the whole log contain?",
          String(errors.length),
          chunk,
          first.chunk,
        ),
      );
    }
    return { text: lines.join("\n"), questions };
  });
}

function noiseLine(rng: Rng): string {
  const service = rng.pick(SERVICES);
  const request = `r-${rng.code(6, "0123456789abcdef")}`;
  const roll = rng.next();
  if (roll < 0.06) {
    return `WARN  [${service}] request ${request} retrying after code W${rng.int(100, 999)} (attempt ${rng.int(1, 3)})`;
  }
  if (roll < 0.3) {
    return `DEBUG [${service}] cache ${rng.pick(["hit", "miss", "refresh"])} key=${rng.pick(TAGS)}:${rng.int(1, 9999)} request ${request}`;
  }
  const method = rng.pick(["GET", "GET", "POST", "PUT", "DELETE"]);
  const path = `/api/v${rng.int(1, 3)}/${rng.pick(TAGS)}/${rng.int(1, 99999)}`;
  return `INFO  [${service}] ${method} ${path} ${rng.pick([200, 200, 200, 201, 204, 304, 404])} ${rng.int(1, 900)}ms request ${request}`;
}

function ledger(rng: Rng, size: TaskSize): Chunk[] {
  const accounts = rng.sample(ACCOUNTS, 5);
  const balances = new Map(accounts.map((account) => [account, rng.int(500, 2000)]));
  const opening = accounts.map((account) => `${account} ${balances.get(account)}`).join(", ");
  const history: Array<{
    id: string;
    chunk: number;
    deltas: Array<[string, number]>;
    void: boolean;
  }> = [];
  const apply = (deltas: Array<[string, number]>, sign: number) => {
    for (const [account, amount] of deltas) {
      balances.set(account, (balances.get(account) ?? 0) + sign * amount);
    }
  };
  let serial = 100;
  let id = 0;
  return range(size.chunks).map((chunk) => {
    const lines = chunk === 0 ? [`OPENING BALANCES: ${opening}`] : [];
    while (estimateTokens(lines.join("\n")) < size.chunkTokens) {
      const tx = `TX-${String(++serial).padStart(6, "0")}`;
      const roll = rng.next();
      const memo = `memo: ${sentence(rng, rng.int(14, 30))}`;
      const voidable = history.filter((entry) => !entry.void && entry.chunk >= chunk - 2);
      if (roll < 0.08 && voidable.length > 0) {
        const target = rng.pick(voidable);
        target.void = true;
        apply(target.deltas, -1);
        lines.push(`${tx} VOID ${target.id}; ${memo}`);
        continue;
      }
      const [from, to] = rng.sample(accounts, 2);
      if (!from || !to) throw new Error("A ledger needs two accounts");
      const amount = rng.int(1, 250);
      let deltas: Array<[string, number]>;
      if (roll < 0.6) {
        deltas = [
          [from, -amount],
          [to, amount],
        ];
        lines.push(`${tx} transfer ${amount} from ${from} to ${to}; ${memo}`);
      } else if (roll < 0.8) {
        deltas = [[to, amount]];
        lines.push(`${tx} deposit ${amount} to ${to}; ${memo}`);
      } else {
        deltas = [[from, -amount]];
        lines.push(`${tx} withdraw ${amount} from ${from}; ${memo}`);
      }
      apply(deltas, 1);
      history.push({ id: tx, chunk, deltas, void: false });
    }
    const last = chunk === size.chunks - 1;
    const isCheckpoint = last || (chunk > 0 && chunk % 6 === 5);
    const asked = isCheckpoint ? (last ? accounts : rng.sample(accounts, 2)) : [];
    const questions = asked.map((account) => ({
      id: `q${++id}`,
      prompt: `What is the current balance of ${account}?`,
      answer: String(balances.get(account)),
      distance: chunk,
    }));
    return { text: lines.join("\n"), questions };
  });
}

/** Prose filler of about `tokens` tokens with each insert as its own paragraph at a random place. */
function proseWith(rng: Rng, tokens: number, inserts: string[]): string {
  const insertTokens = estimateTokens(inserts.join("\n\n"));
  const paragraphs: string[] = [];
  while (estimateTokens(paragraphs.join("\n\n")) < Math.max(200, tokens - insertTokens)) {
    paragraphs.push(
      range(rng.int(4, 8))
        .map(() => sentence(rng, rng.int(8, 22)))
        .join(" "),
    );
  }
  for (const insert of inserts) {
    paragraphs.splice(rng.int(0, paragraphs.length), 0, insert);
  }
  return paragraphs.join("\n\n");
}

function sentence(rng: Rng, words: number): string {
  const text = range(words)
    .map(() => rng.pick(WORDS))
    .join(" ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** `count` items spread across the stream: one from each equal slice of chunks, when possible. */
function stratified<T extends { chunk: number }>(
  rng: Rng,
  items: T[],
  count: number,
  chunks: number,
): T[] {
  const picked: T[] = [];
  for (let slice = 0; slice < count; slice++) {
    const start = Math.floor((slice * chunks) / count);
    const end = Math.floor(((slice + 1) * chunks) / count);
    const candidates = items.filter(
      (item) => item.chunk >= start && item.chunk < end && !picked.includes(item),
    );
    if (candidates.length > 0) picked.push(rng.pick(candidates));
  }
  return picked;
}

function uniqueNames(rng: Rng, count: number, make: () => string): string[] {
  const names = new Set<string>();
  for (let attempt = 0; names.size < count; attempt++) {
    if (attempt > count * 100) throw new Error("Could not generate unique names");
    names.add(make());
  }
  return [...names];
}

const range = (count: number) => Array.from({ length: count }, (_, index) => index);
const pad = (value: number) => String(value).padStart(2, "0");

/** A seeded mulberry32 generator; the salt keeps task kinds independent for one seed. */
export function random(seed: number, salt: string) {
  let state = 2166136261;
  for (const char of `${salt}:${seed}`) {
    state = Math.imul(state ^ (char.codePointAt(0) ?? 0), 16777619);
  }
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const index = (length: number) => Math.floor(next() * length);
  const pick = <T>(items: readonly T[]): T => {
    const item = items[index(items.length)];
    if (item === undefined) throw new Error("Cannot pick from an empty list");
    return item;
  };
  return {
    next,
    int: (min: number, max: number) => min + index(max - min + 1),
    pick,
    code: (length: number, alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789") =>
      range(length)
        .map(() => alphabet.charAt(index(alphabet.length)))
        .join(""),
    /** Up to `count` distinct items in random order. */
    sample: <T>(items: readonly T[], count: number): T[] => {
      const pool = [...items];
      const picked: T[] = [];
      while (picked.length < count && pool.length > 0) {
        picked.push(...pool.splice(index(pool.length), 1));
      }
      return picked;
    },
  };
}

const STARS = [
  "Orion",
  "Vega",
  "Lyra",
  "Draco",
  "Cygnus",
  "Altair",
  "Rigel",
  "Sirius",
  "Deneb",
  "Polaris",
  "Antares",
  "Castor",
];
const FIRST_NAMES = [
  "Ada",
  "Bram",
  "Cleo",
  "Dmitri",
  "Esme",
  "Farid",
  "Greta",
  "Hiro",
  "Ines",
  "Jonas",
  "Kemi",
  "Luis",
  "Mira",
  "Nils",
  "Oona",
  "Priya",
];
const LAST_NAMES = [
  "Abara",
  "Berg",
  "Costa",
  "Dahl",
  "Eze",
  "Fujita",
  "Garcia",
  "Holm",
  "Ivanova",
  "Jensen",
  "Kowalski",
  "Lindqvist",
];
const TAGS = [
  "billing",
  "search",
  "profile",
  "orders",
  "inventory",
  "session",
  "media",
  "reports",
  "alerts",
  "audit",
];
const SERVICES = [
  "auth-api",
  "billing-worker",
  "search-indexer",
  "orders-api",
  "media-proxy",
  "notify-queue",
  "report-builder",
];
const ERROR_REASONS = [
  "upstream connection reset",
  "deadline exceeded after 30s",
  "unique constraint violated",
  "payload failed schema validation",
  "disk quota exhausted",
  "certificate expired",
];
const ACCOUNTS = ["ACME", "BOLT", "CRUX", "DUNE", "EMBER", "FJORD", "GLYPH", "HALO"];
const WORDS = (
  "the a of and to in that it with as for was on are by this be from at or which an have not they " +
  "river stone market winter lantern harbor orchard signal ledger window garden thread copper meadow " +
  "quiet bright narrow ancient distant gentle steady hollow amber silver northern western " +
  "carries follows gathers measures crosses remembers settles opens returns describes " +
  "engine archive bridge corridor village council season valley journal compass canvas"
).split(" ");
