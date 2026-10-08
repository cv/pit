import { buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent";

/** Prompt sections that hold Pit's saved-function catalogs. */
export const CATALOG_SECTIONS = ["pit_user_functions", "pit_project_functions"] as const;
export type CatalogSection = (typeof CATALOG_SECTIONS)[number];

/** A conversation message announcing catalog changes the system prompt does not show yet. */
export const CATALOG_UPDATE_TYPE = "pit.catalog-update";

const TITLES: Record<CatalogSection, string> = {
  pit_user_functions: "User functions",
  pit_project_functions: "Project functions",
};

export interface CatalogUpdateDetails {
  /** Each announced section's complete content, the baseline for the next announcement. */
  sections: Partial<Record<CatalogSection, string>>;
  added: number;
  removed: number;
}

/**
 * Whether the provider keeps a mid-conversation system message in place. Without it, Pi folds
 * every section update into the leading system prompt, which rewrites the whole cached
 * conversation. Every API Pi ships defaults to folding; a proxy that accepts them sets
 * `compat.supportsMidConvoSystemMessages`.
 */
export function keepsSystemUpdates(model: { compat?: unknown } | undefined): boolean {
  const compat = model?.compat as { supportsMidConvoSystemMessages?: boolean } | undefined;
  return compat?.supportsMidConvoSystemMessages === true;
}

export interface RecordedCatalogs {
  /** Catalog sections as the model's system prompt currently has them. */
  system: Map<CatalogSection, string>;
  /** The newest content the model has seen per section, in the prompt or an announcement. */
  seen: Map<CatalogSection, string>;
}

function isCatalogSection(name: string): name is CatalogSection {
  return (CATALOG_SECTIONS as readonly string[]).includes(name);
}

/** Pi records an extension section wrapped in its tag; Pit sets and compares the bare content. */
function unwrap(name: CatalogSection, value: string): string {
  const open = `<${name}>\n`;
  const close = `\n</${name}>`;
  return value.startsWith(open) && value.endsWith(close)
    ? value.slice(open.length, -close.length)
    : value;
}

/** Replays the active branch's system patches and announcements, as Pi replays its prompt. */
export function recordedCatalogs(branch: SessionEntry[], leafId: string | null): RecordedCatalogs {
  const system = new Map<CatalogSection, string>();
  const seen = new Map<CatalogSection, string>();
  for (const { messages } of buildSessionProjection(branch, leafId).entries) {
    for (const message of messages) {
      if (message.role === "system") {
        for (const [name, value] of Object.entries(message.sections ?? {})) {
          if (!isCatalogSection(name)) continue;
          if (value === null) {
            system.delete(name);
            seen.delete(name);
          } else {
            system.set(name, unwrap(name, value));
            seen.set(name, unwrap(name, value));
          }
        }
      } else if (message.role === "custom" && message.customType === CATALOG_UPDATE_TYPE) {
        const details = message.details as Partial<CatalogUpdateDetails> | undefined;
        for (const [name, value] of Object.entries(details?.sections ?? {})) {
          if (isCatalogSection(name) && typeof value === "string") seen.set(name, value);
        }
      }
    }
  }
  return { system, seen };
}

const entryLines = (content: string) => content.split("\n").filter((line) => line.startsWith("- "));

/** A catalog line's function name: `- ci.find(input) — Summary.` names `ci.find`. */
function entryName(line: string): string {
  return line.slice(2).split(/[( ]/, 1)[0] as string;
}

function delta(previous: string, current: string): { added: string[]; removed: string[] } {
  const before = new Set(entryLines(previous));
  const after = new Set(entryLines(current));
  const added = [...after].filter((line) => !before.has(line));
  const changed = new Set(added.map(entryName));
  const removed = [...before]
    .filter((line) => !after.has(line))
    .map(entryName)
    .filter((name) => !changed.has(name));
  return { added, removed };
}

export interface CatalogPlan {
  /** The value each catalog section should have in this request's prompt; undefined leaves it unset. */
  sections: Record<CatalogSection, string | undefined>;
  /** A message announcing changes the prompt keeps out, when there are any. */
  message?: {
    customType: string;
    content: string;
    display: boolean;
    details: CatalogUpdateDetails;
  };
}

/**
 * Chooses the catalog sections for the next request. Refreshing them sends the current
 * catalogs. Holding them keeps the system prompt byte for byte, and announces in the conversation
 * what changed since the model last saw each catalog.
 */
export function planCatalogSections(
  current: Record<CatalogSection, string>,
  recorded: RecordedCatalogs,
  hold: boolean,
): CatalogPlan {
  const sections = {} as Record<CatalogSection, string | undefined>;
  const lines: string[] = [];
  const announced: Partial<Record<CatalogSection, string>> = {};
  let added = 0;
  let removed = 0;
  for (const name of CATALOG_SECTIONS) {
    const content = current[name];
    if (!hold) {
      sections[name] = content || undefined;
      continue;
    }
    sections[name] = recorded.system.get(name);
    const change = delta(recorded.seen.get(name) ?? "", content);
    if (change.added.length === 0 && change.removed.length === 0) continue;
    announced[name] = content;
    added += change.added.length;
    removed += change.removed.length;
    lines.push(
      `${TITLES[name]}:`,
      ...change.added.map((line) => `+ ${line.slice(2)}`),
      ...change.removed.map((gone) => `- ${gone} (removed)`),
    );
  }
  if (lines.length === 0) return { sections };
  return {
    sections,
    message: {
      customType: CATALOG_UPDATE_TYPE,
      content: [
        "[Pit] Saved functions changed. The function lists in the system prompt stay as they are until the cache expires, a compaction, or a reload, so the cached prompt is kept; these changes apply now:",
        ...lines,
      ].join("\n"),
      display: true,
      details: { sections: announced, added, removed },
    },
  };
}
