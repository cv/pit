/**
 * Stages the listed files, verifies the staged set, and commits it, optionally pushing the
 * current branch. Tracked paths are staged with `git add -u`, so an ignore rule that matches a
 * tracked file (for example a global `.pi` rule) does not block it; new ignored files still fail.
 * Unrelated changes that are already staged stop the commit before anything is staged. A listed
 * deletion that is already staged, such as a `git mv` source, is committed as staged.
 *
 * @param input.files - Repository-relative file paths to commit (1-100), including deletions.
 * @param input.message - Commit message (1-5000 characters).
 * @param input.push - Push the current branch, setting its upstream on the first push. The default
 *   is false. A push to a branch whose pull requests are all merged or closed fails before anything
 *   is staged, since its commits would never reach the base branch.
 * @param input.allowClosedPullRequest - Push even when the branch's pull request is merged or
 *   closed. The default is false.
 */
async function commit(
  { shell: { execFile }, git: { commit: gitCommit, push }, gh: { prList } },
  input: { files: string[]; message: string; push?: boolean; allowClosedPullRequest?: boolean },
) {
  const files = [...new Set(input.files.map((file) => file.replace(/^\.\//, "")))];
  if (files.length === 0 || files.length > 100) {
    throw new Error("Provide between 1 and 100 files to commit");
  }
  const invalid = files.filter(
    (file) =>
      file.length === 0 ||
      file.startsWith("/") ||
      file.endsWith("/") ||
      /[\r\n\0]/.test(file) ||
      file.split("/").includes(".."),
  );
  if (invalid.length > 0) {
    throw new Error(`Commit paths must be repository-relative files: ${invalid.join(", ")}`);
  }
  const message = input.message.trim();
  if (message.length === 0 || message.length > 5000) {
    throw new Error("message must contain 1-5000 characters");
  }
  const git = (args: string[], raise = true) =>
    execFile("git", ["--literal-pathspecs", ...args], { raise, maxBytes: 50000, maxLines: 2000 });
  const paths = async (args: string[]) => {
    const result = await git(args);
    if (result.truncated) throw new Error(`git ${args[0]} output was truncated`);
    return result.stdout.split("\0").filter(Boolean);
  };
  const stagedPaths = () => paths(["diff", "--cached", "--name-only", "--no-renames", "-z"]);
  const requested = new Set(files);
  // A merged or closed pull request's branch is a dead end: commits pushed there never reach the
  // base branch, as happened when PR #272 merged while more commits were on their way.
  if (input.push && input.allowClosedPullRequest !== true) {
    const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    if (branch !== "HEAD") {
      const listed = await prList({
        head: branch,
        state: "all",
        json: ["number", "state"],
        limit: 10,
        raise: true,
      });
      const prs = JSON.parse(listed.stdout || "[]") as Array<{ number: number; state: string }>;
      const finished = prs.filter((pr) => pr.state === "MERGED" || pr.state === "CLOSED");
      if (finished.length > 0 && !prs.some((pr) => pr.state === "OPEN")) {
        const [pr] = finished;
        throw new Error(
          `Branch ${branch} belongs to pull request #${pr!.number}, which is ${pr!.state.toLowerCase()}, so pushed commits would not reach its base. Create a new branch from origin/main (git switch -c <name> origin/main) and cherry-pick onto it, or pass allowClosedPullRequest: true. Nothing was staged or committed.`,
        );
      }
    }
  }

  const alreadyStaged = new Set(await stagedPaths());
  const unrelated = [...alreadyStaged].filter((file) => !requested.has(file));
  if (unrelated.length > 0) {
    throw new Error(
      `Unrelated changes are already staged: ${unrelated.slice(0, 10).join(", ")}. Unstage them or include them in files.`,
    );
  }
  const tracked = new Set(await paths(["ls-files", "-z", "--", ...files]));
  const directories = files.filter(
    (file) => !tracked.has(file) && [...tracked].some((path) => path.startsWith(`${file}/`)),
  );
  if (directories.length > 0) {
    throw new Error(`List files, not directories: ${directories.join(", ")}`);
  }
  const trackedFiles = files.filter((file) => tracked.has(file));
  // A staged deletion, such as a git mv source, is in neither the index nor the tree: git add would
  // reject it, and it needs no staging.
  const newFiles = files.filter((file) => !tracked.has(file) && !alreadyStaged.has(file));
  if (trackedFiles.length > 0) await git(["add", "-u", "--", ...trackedFiles]);
  if (newFiles.length > 0) await git(["add", "--", ...newFiles]);

  const staged = await stagedPaths();
  const stagedSet = new Set(staged);
  const unchanged = files.filter((file) => !stagedSet.has(file));
  const extra = staged.filter((file) => !requested.has(file));
  if (unchanged.length > 0 || extra.length > 0) {
    throw new Error(
      `Staged files do not match the request (unchanged: ${unchanged.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}). Nothing was committed; listed files that were staged remain staged.`,
    );
  }
  await gitCommit(["-m", message], { raise: true, maxBytes: 20000 });
  const [sha = "", branch = ""] = (await git(["rev-parse", "HEAD", "--abbrev-ref", "HEAD"])).stdout
    .trim()
    .split("\n");

  let upstream: string | null = null;
  if (input.push) {
    if (branch === "HEAD") {
      throw new Error(`Created ${sha}, but cannot push from a detached HEAD`);
    }
    const current = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], false);
    if (current.code === 0) {
      await push([], { raise: true });
      upstream = current.stdout.trim();
    } else {
      await push(["-u", "origin", branch], { raise: true });
      upstream = `origin/${branch}`;
    }
  }
  return {
    sha,
    branch,
    subject: message.split("\n")[0],
    files: staged,
    pushed: input.push === true,
    upstream,
  };
}
