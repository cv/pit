/**
 * Returns a bounded review summary for a GitHub pull request.
 *
 */
async function inspectGitHubPullRequest(
  { gh: { api, prView } },
  input: { number: number; repo?: string },
) {
  interface ReviewActor {
    login?: string;
  }
  interface PullRequestComment {
    author?: ReviewActor;
    body?: string;
  }
  interface PullRequestReview extends PullRequestComment {
    state?: string;
  }
  interface PullRequestView {
    title?: string;
    url?: string;
    state?: string;
    reviewDecision?: string;
    body?: string;
    comments?: PullRequestComment[];
    reviews?: PullRequestReview[];
    statusCheckRollup?: Array<Record<string, string | number | boolean | null>>;
  }

  const repo = input.repo ?? "cv/pit";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("repo must use owner/name form");
  }
  if (!(Number.isInteger(input.number) && input.number > 0)) {
    throw new Error("number must be a positive integer");
  }
  const endpoint = `/repos/${repo}/pulls/${input.number}`;
  const [view, metadata, commits, files] = await Promise.all([
    prView(input.number, { repo, maxLines: 240, maxBytes: 32000, raise: true }),
    api(
      endpoint,
      [
        "--jq",
        "{draft, mergeable, mergeableState: .mergeable_state, headRef: .head.ref, headSha: .head.sha, headRepo: .head.repo.full_name, baseRef: .base.ref, updatedAt: .updated_at}",
      ],
      { maxLines: 20, maxBytes: 5000, raise: true },
    ),
    api(
      `${endpoint}/commits`,
      ["--jq", "[.[] | {sha: .sha[0:7], message: .commit.message, author: .commit.author.name}]"],
      { maxLines: 160, maxBytes: 20000, raise: true },
    ),
    api(
      `${endpoint}/files`,
      ["--jq", "[.[] | {filename, status, additions, deletions, changes}]"],
      { maxLines: 240, maxBytes: 30000, raise: true },
    ),
  ]);
  const pr = JSON.parse(view.stdout) as PullRequestView;
  return {
    number: input.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    reviewDecision: pr.reviewDecision,
    body: String(pr.body ?? "").slice(0, 8000),
    metadata: JSON.parse(metadata.stdout),
    commits: JSON.parse(commits.stdout),
    files: JSON.parse(files.stdout),
    comments: (pr.comments ?? []).slice(-8).map((comment) => ({
      author: comment.author?.login,
      body: String(comment.body ?? "").slice(0, 3000),
    })),
    reviews: (pr.reviews ?? []).slice(-8).map((review) => ({
      author: review.author?.login,
      state: review.state,
      body: String(review.body ?? "").slice(0, 3000),
    })),
    checks: pr.statusCheckRollup ?? [],
  };
}
