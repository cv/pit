/**
 * Lists changed Git paths, including staged, unstaged, renamed, and untracked files. Deleted paths
 * are omitted unless requested, so formatters and editors receive only files that exist.
 * Rejects conflicts, incomplete status output, and more than 500 paths rather than returning a partial list.
 *
 * @param input.includeDeleted - Also list tracked deletions and staged rename sources, the paths
 *   `delivery.commit()` needs to record them. A file added and then deleted before any commit has
 *   nothing to commit and stays omitted. The default is false.
 */
async function listChangedFiles({ git: { status } }, input: { includeDeleted?: boolean } = {}) {
  if (input.includeDeleted !== undefined && typeof input.includeDeleted !== "boolean") {
    throw new TypeError("includeDeleted must be a boolean");
  }
  const includeDeleted = input.includeDeleted === true;
  const result = await status(["--porcelain=v1", "-z", "--untracked-files=all"], {
    raise: true,
    maxBytes: 50000,
    maxLines: 1000,
  });
  if (result.truncated) {
    throw new Error("Git status was truncated; narrow the worktree before listing changed files");
  }
  if (result.stdout && !result.stdout.endsWith("\0")) {
    throw new Error("Git status did not return complete NUL-delimited records");
  }
  const records = result.stdout.split("\0");
  const files = new Set<string>();
  for (let index = 0; index < records.length - 1; index++) {
    const record = records[index];
    if (!/^[ MADRCU?!T]{2} .+$/s.test(record)) {
      throw new Error("Git status returned an invalid porcelain record");
    }
    const state = record.slice(0, 2);
    if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(state)) {
      throw new Error("Resolve Git conflicts before listing changed files");
    }
    if (/[RC]/.test(state)) {
      // Porcelain -z places the destination first, followed by the original path.
      const original = records[++index];
      if (!original) throw new Error("Git rename/copy record is missing its original path");
      // A staged rename deletes its source; a copy leaves the source in place.
      if (includeDeleted && state[0] === "R") files.add(original);
    }
    if (state === "!!") continue;
    // An index addition (A) is absent from HEAD, so deleting it leaves nothing to commit.
    if (!state.includes("D") || (includeDeleted && state[0] !== "A")) files.add(record.slice(3));
  }
  if (files.size > 500) {
    throw new Error("More than 500 changed paths; narrow the worktree before continuing");
  }
  return { files: [...files].sort() };
}
