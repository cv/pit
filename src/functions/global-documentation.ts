import { globalFunctionGroups, type GlobalNamespace } from "./globals.js";

// Optional prompt compression; function membership and full docs come from global definitions.
const NAMESPACE_SUMMARIES: Partial<Record<GlobalNamespace, string>> = {
  workspace:
    'read(file, { format?: "hashed" | "raw", offset?, limit?, ranges? }); search(query, { path?, glob?, regex?, caseSensitive?, contextLines?: 0..10, limit?: 1..500, ignore?, dot? }) returns edit-ready anchors and revisions; edit(file, { revision, changes }), where replace/delete take start and end?, insertBefore/insertAfter take anchor, and replaceFile/deleteFile take none; batch runs reads [{ kind: "read", file, options? }] with { failure?: "fail-fast" | "settled" }, or edits [{ kind: "edit", file, changes }], and returns ordered { results }; glob(patterns?, { limit?, dot?, onlyFiles?, ignore? }) -> { entries, truncated }; list(path?); stat(path); viewImage(file) attaches up to 8 images to a successful result',
  git: "status, diff, log, add, commit, show, push, and tag take an argument array and shell options",
  npm: "run, test, install, audit, outdated, and pack",
  gh: "issue, PR, run, and release workflows with selectable JSON fields and list filters; api(endpoint) for the rest",
  shell:
    'execFile(program, args, options?) runs without a shell; exec(command, options?) runs /bin/sh. Options: cwd, timeoutMs, raise, maxBytes, maxLines, truncate: "head" | "tail". They return { stdout, stderr, code, truncated }; a nonzero exit is data unless raise: true',
  session:
    "outline(options?) lists model-visible entries with tokens and state; inspectEntry(id) reads an original; elide(ids, { reason?, when? }), summarize({ from, to, summary, when? }), and setNote(key, content | null) stage edits that apply if the call succeeds; notes(), info, getName/setName, compact",
  commands: "list",
  models: "current, list, set",
  runtime: "status(); completedCalls(toolCallId) returns what a failed program's calls returned",
  functions:
    'list, get, remove (project); listUser, getUser, removeUser (user); listAll({ scope?, allDefinitions?, offset?, limit? }); getSaved(name) for a signature, dependencies, and source; promote(name, summary, { to?: "user" }) saves a session function to the project or user after confirmation; planRemoval(name) and removeSession(name, { cascade: true })',
};

export function globalFunctionDocumentation(): string[] {
  return [...globalFunctionGroups()].map(([name, definitions]) => {
    const documentation =
      NAMESPACE_SUMMARIES[name] ??
      definitions.map((definition) => definition.documentation).join("; ");
    return `${name}: ${documentation}.`;
  });
}
