/**
 * Creates or removes an isolated worktree for reviewing a GitHub pull request.
 *
 * @pit project
 */
async function managePullRequestWorktree(
  { context, shell, workspace },
  input:
    | { action: "create"; number: number; remote?: string; path?: string }
    | { action: "remove"; path: string },
) {
  const runtime = await context.get();
  if (input.action === "remove") {
    if (!input.path.startsWith("/tmp/pit-pr-review-")) {
      throw new Error("refusing to remove a worktree outside /tmp/pit-pr-review-");
    }
    const removed = await shell.execFile("git", ["worktree", "remove", "--force", input.path], {
      cwd: runtime.cwd,
      timeoutMs: 120000,
      maxLines: 40,
      maxBytes: 5000,
      raise: true,
    });
    return { action: "remove", path: input.path, output: removed.stderr || removed.stdout };
  }

  if (!(Number.isInteger(input.number) && input.number > 0)) {
    throw new Error("number must be a positive integer");
  }
  const remote = input.remote ?? "origin";
  if (!/^[A-Za-z0-9_.-]+$/.test(remote)) {
    throw new Error("remote contains unsupported characters");
  }
  const path = input.path ?? `/tmp/pit-pr-review-${input.number}-${Date.now()}`;
  if (!path.startsWith("/tmp/pit-pr-review-")) {
    throw new Error("review worktrees must use /tmp/pit-pr-review-");
  }
  const ref = `refs/remotes/${remote}/pr-${input.number}`;
  await shell.execFile("git", ["fetch", remote, `+pull/${input.number}/head:${ref}`], {
    cwd: runtime.cwd,
    timeoutMs: 120000,
    maxLines: 60,
    maxBytes: 8000,
    raise: true,
  });
  await shell.execFile(
    "git",
    ["worktree", "add", "--detach", path, `${remote}/pr-${input.number}`],
    { cwd: runtime.cwd, timeoutMs: 120000, maxLines: 60, maxBytes: 8000, raise: true },
  );
  const modules = await workspace.stat(`${runtime.cwd}/node_modules`).catch(() => undefined);
  if (modules?.directory) {
    await shell.execFile("ln", ["-s", `${runtime.cwd}/node_modules`, `${path}/node_modules`], {
      timeoutMs: 30000,
      maxLines: 20,
      maxBytes: 3000,
      raise: true,
    });
  }
  const head = await shell.execFile("git", ["log", "-1", "--oneline", "--decorate"], {
    cwd: path,
    maxLines: 20,
    maxBytes: 3000,
    raise: true,
  });
  return { action: "create", number: input.number, path, ref, head: head.stdout.trim() };
}
