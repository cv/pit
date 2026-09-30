import { globalFunctionGroups, type GlobalNamespace } from "./globals.js";

// Optional prompt compression; function membership and full docs come from global definitions.
const NAMESPACE_SUMMARIES: Partial<Record<GlobalNamespace, string>> = {
  git: "git.status, git.diff, git.log, git.add, git.commit, git.show, git.push, and git.tag accept optional argument arrays and shell.execFile options; results are bounded",
  npm: "npm.run, npm.test, npm.install, npm.audit, npm.outdated, and npm.pack provide typed bounded npm workflows",
  gh: "typed bounded issue/PR/run/release workflows with selectable JSON fields, common list filters, and argument-safe extra args; api is the escape hatch",
  session:
    "info/name/compact; outline(options?) pages model-visible entries with tokens, reprefillTokens, edit state, and editability; inspectEntry(id) reads original content; elide(ids, {reason?})/restore(ids) and setNote(key, content|null) stage branch-local edits applied after this turn if the call succeeds; notes() lists live notes",
  commands: "list",
  models: "current/list/set",
  runtime: "runtime status",
  functions:
    'list/get/remove: project; listUser/getUser/removeUser: user. listAll({scope?, allDefinitions?, offset?, limit?}?) -> {functions, total, offset, nextOffset?}; limit 1–200, default 50. Effective by default; scope includes shadowed entries; allDefinitions: every layer. getSaved(name, scope?) -> native/source/invalid metadata (signature, dependencies, chain, next, effects); source only for kind: "source". promote(name, summary, {to: "user"}) persists session to user after confirmation; default target: project. planRemoval(name, scope?) previews blockers; removeSession(name, {cascade: true}) explicitly removes dependents',
};

export function globalFunctionDocumentation(): string[] {
  return [...globalFunctionGroups()].map(([name, definitions]) => {
    const documentation =
      NAMESPACE_SUMMARIES[name] ??
      definitions.map((definition) => definition.documentation).join("; ");
    return `${name}: ${documentation}.`;
  });
}
