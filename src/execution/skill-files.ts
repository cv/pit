import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { clipText } from "../shared/bounds.js";
import { isRecord } from "../shared/records.js";

/** A skill Pi loaded for the session: what identifies reads of its files. */
export interface KnownSkill {
  name: string;
  filePath: string;
}

/** The skill a returned read's file belongs to: its own file, or a file in its directory. */
export interface SkillFile {
  name: string;
  kind: "skill" | "reference";
  /** A reference's path relative to its skill's directory. */
  reference?: string;
}

const SKILL_FILE = "SKILL.md";
const MAX_NAME_CHARS = 80;
const MAX_PATH_CHARS = 400;
/** Bounds the walk; renderers stop showing nested values as reads before this depth. */
const MAX_DEPTH = 8;

function inside(parent: string, path: string): string | undefined {
  const rel = relative(parent, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;
  return rel.replaceAll("\\", "/");
}

/**
 * The loaded skill a file belongs to: the skill whose file it is, else the innermost `SKILL.md`
 * skill whose directory contains it. A skill file outside a `SKILL.md` layout owns no directory.
 */
export function classifySkillFile(
  path: string,
  skills: readonly KnownSkill[],
): SkillFile | undefined {
  let owner: { skill: KnownSkill; rel: string } | undefined;
  for (const skill of skills) {
    const skillFile = resolve(skill.filePath);
    if (skillFile === path) return { name: clipText(skill.name, MAX_NAME_CHARS), kind: "skill" };
    if (basename(skillFile) !== SKILL_FILE) continue;
    const rel = inside(dirname(skillFile), path);
    if (rel !== undefined && (owner === undefined || rel.length < owner.rel.length)) {
      owner = { skill, rel };
    }
  }
  if (!owner) return undefined;
  return {
    name: clipText(owner.skill.name, MAX_NAME_CHARS),
    kind: "reference",
    reference: clipText(owner.rel, MAX_PATH_CHARS),
  };
}

/** A `workspace.read` result, by the fields every read returns. */
function readFile(value: Record<string, unknown>): string | undefined {
  const { file, format, revision } = value;
  return typeof file === "string" &&
    (format === "raw" || format === "hashed") &&
    typeof revision === "string"
    ? file
    : undefined;
}

/**
 * The skills of the reads a program returned, keyed by the file each read names. The renderer
 * reads this rather than session state, so a saved transcript shows the skills it was run with.
 * The value is the fitted JSON result, so its size is already bounded and it has no cycles.
 */
export function returnedSkillFiles(
  value: unknown,
  cwd: string,
  skills: readonly KnownSkill[],
): Record<string, SkillFile> | undefined {
  if (skills.length === 0) return undefined;
  const found: Record<string, SkillFile> = {};
  const visit = (node: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || (!isRecord(node) && !Array.isArray(node))) return;
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, depth + 1);
      return;
    }
    const file = readFile(node);
    if (file !== undefined) {
      const skill = classifySkillFile(resolve(cwd, file), skills);
      if (skill) found[file] = skill;
      return;
    }
    for (const entry of Object.values(node)) visit(entry, depth + 1);
  };
  visit(value, 0);
  return Object.keys(found).length > 0 ? found : undefined;
}
