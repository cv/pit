/**
 * Edits a GitHub pull request description with verified literal replacements, checklist ticks, and
 * an appended section. Each expected text must occur exactly once before anything is written, so a
 * stale expectation fails without a partial edit. Returns the added or changed lines, bounded.
 *
 * @param input.number - Pull request number.
 * @param input.repo - GitHub owner/name. The default is the current repository.
 * @param input.replace - Literal [from, to] pairs (at most 20), applied in order; each `from` must
 *   occur exactly once.
 * @param input.check - Unchecked checklist item texts (at most 20), without the `- [ ] ` prefix.
 * @param input.append - Markdown appended after a blank line (1-20,000 characters).
 * @param input.dryRun - Report the edit without writing it. The default is false.
 */
async function editBody(
  { gh: { prView, api } },
  input: {
    number: number;
    repo?: string;
    replace?: [string, string][];
    check?: string[];
    append?: string;
    dryRun?: boolean;
  },
) {
  if (!Number.isInteger(input.number) || input.number < 1) {
    throw new Error("number must be a positive integer");
  }
  if (input.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(input.repo)) {
    throw new Error("repo must be owner/name");
  }
  const replace = input.replace ?? [];
  const check = input.check ?? [];
  if (replace.length > 20 || check.length > 20) {
    throw new Error("Provide at most 20 replacements and 20 checklist items");
  }
  if (
    replace.some(
      (pair) =>
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        typeof pair[0] !== "string" ||
        typeof pair[1] !== "string" ||
        pair[0].length === 0,
    )
  ) {
    throw new Error("replace entries must be [from, to] string pairs with a non-empty from");
  }
  if (check.some((item) => typeof item !== "string" || !item.trim() || item.includes("\n"))) {
    throw new Error("check items must be non-empty single-line strings");
  }
  if (
    input.append !== undefined &&
    (typeof input.append !== "string" || !input.append.trim() || input.append.length > 20000)
  ) {
    throw new Error("append must contain 1-20000 characters");
  }
  if (replace.length === 0 && check.length === 0 && input.append === undefined) {
    throw new Error("Provide replace, check, or append");
  }

  const view = await prView(input.number, {
    json: ["body", "url"],
    ...(input.repo ? { repo: input.repo } : {}),
    raise: true,
  });
  if (view.truncated) throw new Error("Pull request view was truncated");
  const { body: original, url } = JSON.parse(view.stdout) as { body: string; url: string };
  const once = (text: string, needle: string, label: string) => {
    const at = text.indexOf(needle);
    if (at < 0) throw new Error(`${label} not found: ${needle.slice(0, 120)}`);
    if (text.indexOf(needle, at + needle.length) >= 0) {
      throw new Error(`${label} occurs more than once: ${needle.slice(0, 120)}`);
    }
    return at;
  };
  let body = original;
  for (const [from, to] of replace) {
    const at = once(body, from, "Replacement text");
    body = body.slice(0, at) + to + body.slice(at + from.length);
  }
  for (const item of check) {
    const needle = `- [ ] ${item}`;
    const at = once(body, needle, "Unchecked item");
    body = `${body.slice(0, at)}- [x] ${item}${body.slice(at + needle.length)}`;
  }
  if (input.append !== undefined) body = `${body.trimEnd()}\n\n${input.append.trim()}\n`;
  const length = [...body].length;
  if (length > 65536) throw new Error(`Edited body has ${length} characters; GitHub allows 65,536`);

  const previous = new Set(original.split("\n"));
  const added = body.split("\n").filter((line) => !previous.has(line));
  const changed = body !== original;
  if (changed && input.dryRun !== true) {
    const endpoint = `repos/${input.repo ?? "{owner}/{repo}"}/pulls/${input.number}`;
    const written = await api(
      endpoint,
      ["--method", "PATCH", "-f", `body=${body}`, "--jq", ".body | length"],
      { raise: true },
    );
    const stored = Number(written.stdout.trim());
    if (stored !== length) {
      throw new Error(`GitHub stored ${stored} characters; expected ${length}. Inspect ${url}`);
    }
  }
  return {
    number: input.number,
    url,
    dryRun: input.dryRun === true,
    written: changed && input.dryRun !== true,
    changed,
    replaced: replace.length,
    checked: check.length,
    appended: input.append !== undefined,
    length,
    changedLines: added
      .slice(0, 40)
      .map((line) => (line.length > 200 ? `${line.slice(0, 199)}…` : line)),
    changedLinesOmitted: Math.max(0, added.length - 40),
  };
}
