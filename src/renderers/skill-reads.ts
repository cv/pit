import { basename, dirname } from "node:path";

import type { ResultTheme, SkillMention } from "./types.js";

const SKILL_FILE = "SKILL.md";
/** Skill rows a collapsed result lists before naming the rest. */
const COLLAPSED_SKILLS = 4;

/** The skill a read file belongs to, when it is a `SKILL.md`. */
export function skillMention(
  file: string,
  spans: Array<[number, number]>,
  totalLines: number,
  detail: string,
): SkillMention[] | undefined {
  if (basename(file) !== SKILL_FILE) return undefined;
  const name = basename(dirname(file));
  return name && name !== "." ? [{ name, spans, totalLines, detail }] : undefined;
}

/** The skill mentions of nested renderings, in order. */
export function nestedSkills(children: Array<{ skills?: SkillMention[] } | undefined>): {
  skills?: SkillMention[];
} {
  const skills = children.flatMap((child) => child?.skills ?? []);
  return skills.length > 0 ? { skills } : {};
}

function mergedSpans(spans: Array<[number, number]>): Array<[number, number]> {
  const merged: Array<[number, number]> = [];
  for (const [start, end] of [...spans].sort((left, right) => left[0] - right[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** Which lines of a skill file its reads together missed, such as `lines 1-80 of 215`. */
function partialCoverage(mentions: readonly SkillMention[]): string | undefined {
  const totalLines = Math.max(...mentions.map((mention) => mention.totalLines));
  const spans = mergedSpans(mentions.flatMap((mention) => mention.spans));
  const [first] = spans;
  if (totalLines === 0 || (spans.length === 1 && first?.[0] === 1 && first[1] >= totalLines)) {
    return undefined;
  }
  if (spans.length === 0) return `no lines of ${totalLines}`;
  const shown = spans.map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`));
  return `lines ${shown.join(", ")} of ${totalLines}`;
}

export function skillLabel(theme: ResultTheme, name: string): string {
  return `${theme.fg("customMessageLabel", theme.bold("[skill]"))} ${theme.fg("customMessageText", name)}`;
}

/**
 * Collapsed rows for the skills a result returned: one per skill, in first-read order, with a
 * warning when its reads did not cover the whole file.
 */
export function renderSkillRows(skills: readonly SkillMention[], theme: ResultTheme): string {
  const byName = new Map<string, SkillMention[]>();
  for (const skill of skills) byName.set(skill.name, [...(byName.get(skill.name) ?? []), skill]);
  const names = [...byName.keys()];
  let text = "";
  for (const name of names.slice(0, COLLAPSED_SKILLS)) {
    const partial = partialCoverage(byName.get(name) ?? []);
    text += `\n${skillLabel(theme, name)}`;
    if (partial) text += ` ${theme.fg("warning", `⚠ partial: ${partial}`)}`;
  }
  const hidden = names.slice(COLLAPSED_SKILLS);
  if (hidden.length > 0)
    text += `\n${theme.fg("dim", `… ${hidden.length} more: ${hidden.join(", ")}`)}`;
  return text;
}
