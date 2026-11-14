/**
 * Opens a pull request from local changes: creates the branch from the current HEAD, commits and
 * pushes the listed files through delivery.commit, and creates the pull request. Uncommitted
 * changes move to the new branch. When the branch is already checked out, it commits there; when
 * it already has an open pull request, it returns that one instead of creating another.
 *
 * @param input.branch - Branch to create, or the checked-out branch to reuse. Not main or master.
 * @param input.files - Repository-relative files to commit (see delivery.commit).
 * @param input.message - Commit message (see delivery.commit).
 * @param input.title - Pull request title. The default is the commit message's first line.
 * @param input.body - Pull request description. The default is empty.
 * @param input.base - Base branch. The default is main.
 * @param input.draft - Open the pull request as a draft. The default is false.
 */
async function openPullRequest(
  { git: { revParse, switchBranch }, delivery: { commit }, gh: { prCreate, prList } },
  input: {
    branch: string;
    files: string[];
    message: string;
    title?: string;
    body?: string;
    base?: string;
    draft?: boolean;
  },
) {
  const branch = input.branch.trim();
  const base = (input.base ?? "main").trim();
  const validBranch = (name: string) =>
    /^[\w][\w./-]*$/.test(name) &&
    !name.includes("..") &&
    !name.endsWith("/") &&
    !name.endsWith(".lock");
  if (!validBranch(branch)) throw new Error(`branch is not a valid branch name: ${input.branch}`);
  if (!validBranch(base)) throw new Error(`base is not a valid branch name: ${input.base}`);
  if (branch === "main" || branch === "master" || branch === base) {
    throw new Error(`branch must differ from ${branch === base ? "the base branch" : branch}`);
  }
  const title = (input.title ?? input.message.trim().split("\n")[0] ?? "").trim();
  if (title.length === 0) throw new Error("title must not be empty");

  const current = (await revParse(["--abbrev-ref", "HEAD"], { raise: true })).stdout.trim();
  const created = current !== branch;
  if (created) await switchBranch(["-c", branch], { raise: true });
  const committed = await commit({ files: input.files, message: input.message, push: true });

  const listed = await prList({
    head: branch,
    state: "open",
    json: ["number", "url"],
    limit: 1,
    raise: true,
  });
  const existing = (JSON.parse(listed.stdout || "[]") as Array<{ number: number; url: string }>)[0];
  if (existing) {
    return {
      number: existing.number,
      url: existing.url,
      created: false,
      branch,
      branchCreated: created,
      sha: committed.sha,
      files: committed.files,
    };
  }
  const opened = await prCreate({
    title,
    body: input.body ?? "",
    base,
    head: branch,
    ...(input.draft === true ? { draft: true } : {}),
    raise: true,
  });
  const url = opened.stdout.trim().split("\n").at(-1) ?? "";
  const number = Number(url.match(/\/pull\/(\d+)/)?.[1] ?? Number.NaN);
  return {
    number: Number.isInteger(number) ? number : null,
    url,
    created: true,
    branch,
    branchCreated: created,
    sha: committed.sha,
    files: committed.files,
  };
}
