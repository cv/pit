/**
 * Returns a bounded review summary for a GitHub pull request.
 * Previews are bounded before transport and fitted to one output budget. Shortened text and
 * omitted items are explicit, and incomplete JSON is rejected.
 */
async function inspect({ gh: { api, prView } }, input: { number: number; repo?: string }) {
  interface Preview {
    author?: string;
    state?: string;
    body: string;
    bodyLength: number;
  }
  interface View {
    title?: string;
    url?: string;
    state?: string;
    reviewDecision?: string;
    body: string;
    bodyLength: number;
    comments: Preview[];
    reviews: Preview[];
    checks: Array<Record<string, string | null>>;
    counts: { comments: number; reviews: number; checks: number };
  }
  const OUTPUT_BUDGET = 45_000;
  const TRANSPORT_BYTES = 48_000;
  const MAX_DISCUSSION_ITEMS = 8;
  const MAX_CHECKS = 40;
  const MAX_SUBJECT = 200;
  // Character previews cannot bound UTF-8 bytes, so truncated transport retries smaller previews.
  const PREVIEW_ATTEMPTS = [
    { body: 8000, item: 3000 },
    { body: 3000, item: 1000 },
    { body: 1000, item: 300 },
  ];
  const repo = input.repo ?? "cv/pit";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
    throw new Error("repo must use owner/name form");
  if (!(Number.isInteger(input.number) && input.number > 0))
    throw new Error("number must be a positive integer");

  const parse = (label: string, result: { stdout: string; truncated: boolean }) => {
    if (result.truncated)
      throw new Error(
        `PR ${input.number}: ${label} JSON was truncated; use narrower GitHub queries rather than parsing partial output`,
      );
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error(`PR ${input.number}: ${label} returned invalid JSON`);
    }
  };
  // Shape the CLI's JSON before process bounds apply. Failing and pending checks sort first,
  // so the check cap omits passing checks before anything that needs attention.
  const viewProjection = ({ body, item }: (typeof PREVIEW_ATTEMPTS)[number]) => `
def text: . // "";
def preview($n): {body: (.body | text | .[0:$n]), bodyLength: (.body | text | length)};
def passing: ((.conclusion // .state // "") | ascii_upcase) as $s
  | $s == "SUCCESS" or $s == "SKIPPED" or $s == "NEUTRAL";
{title, url, state, reviewDecision} + preview(${body}) + {
 comments: ((.comments // [])[-${MAX_DISCUSSION_ITEMS}:] | map({author: .author.login} + preview(${item}))),
 reviews: ((.reviews // [])[-${MAX_DISCUSSION_ITEMS}:] | map({author: .author.login, state} + preview(${item}))),
 checks: ((.statusCheckRollup // []) | sort_by(if passing then 1 else 0 end) | .[0:${MAX_CHECKS}]
   | map({name: (.name // .context), workflow: .workflowName, status: (.status // .state),
          conclusion, url: (.detailsUrl // .targetUrl)})),
 counts: {comments: (.comments // [] | length), reviews: (.reviews // [] | length),
          checks: (.statusCheckRollup // [] | length)}}`;
  const fetchView = async (attempt = 0): Promise<Awaited<ReturnType<typeof prView>>> => {
    const result = await prView(input.number, {
      repo,
      json: [
        "title",
        "url",
        "state",
        "reviewDecision",
        "body",
        "comments",
        "reviews",
        "statusCheckRollup",
      ],
      args: ["--jq", viewProjection(PREVIEW_ATTEMPTS[attempt])],
      maxLines: 240,
      maxBytes: TRANSPORT_BYTES,
      raise: true,
    });
    return result.truncated && attempt + 1 < PREVIEW_ATTEMPTS.length
      ? fetchView(attempt + 1)
      : result;
  };
  const endpoint = `/repos/${repo}/pulls/${input.number}`;
  const [view, metadata, commits, files] = await Promise.all([
    fetchView(),
    api(
      endpoint,
      [
        "--jq",
        "{draft, mergeable, mergeableState: .mergeable_state, headRef: .head.ref, headSha: .head.sha, headRepo: .head.repo.full_name, baseRef: .base.ref, updatedAt: .updated_at, commitCount: .commits, fileCount: .changed_files}",
      ],
      { maxLines: 20, maxBytes: 5000, raise: true },
    ),
    api(
      `${endpoint}/commits`,
      [
        "--jq",
        `[.[] | (.commit.message // "" | rtrimstr("\\n")) as $message | ($message | split("\\n")[0]) as $subject
          | {sha: .sha[0:7], subject: ($subject | .[0:${MAX_SUBJECT}]),
             messageTruncated: (($message | length) > ($subject | .[0:${MAX_SUBJECT}] | length)),
             author: .commit.author.name}]`,
      ],
      { maxLines: 160, maxBytes: 40000, raise: true },
    ),
    api(
      `${endpoint}/files`,
      ["--jq", "[.[] | {filename, status, additions, deletions, changes}]"],
      { maxLines: 240, maxBytes: 30000, raise: true },
    ),
  ]);
  const pr = parse("view", view) as View;
  const meta = parse("metadata", metadata) as { commitCount?: number; fileCount?: number };
  const commitItems = parse("commits", commits);
  const fileItems = parse("files", files);
  if (
    !pr ||
    typeof pr !== "object" ||
    Array.isArray(pr) ||
    !meta ||
    typeof meta !== "object" ||
    Array.isArray(meta) ||
    !Array.isArray(commitItems) ||
    !Array.isArray(fileItems)
  ) {
    throw new Error(`PR ${input.number}: unexpected GitHub response shape`);
  }
  // jq lengths count code points, so previews are measured the same way.
  const codePoints = (text: string) => Array.from(text).length;
  const summary = {
    number: input.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    reviewDecision: pr.reviewDecision,
    body: pr.body,
    metadata: meta,
    commits: commitItems,
    files: fileItems,
    comments: pr.comments.map(({ author, body, bodyLength }) => ({
      author,
      body,
      bodyTruncated: codePoints(body) < bodyLength,
    })),
    reviews: pr.reviews.map(({ author, state, body, bodyLength }) => ({
      author,
      state,
      body,
      bodyTruncated: codePoints(body) < bodyLength,
    })),
    checks: pr.checks,
    omissions: {
      bodyCharacters: pr.bodyLength - codePoints(pr.body),
      comments: pr.counts.comments - pr.comments.length,
      reviews: pr.counts.reviews - pr.reviews.length,
      checks: pr.counts.checks - pr.checks.length,
      commits:
        typeof meta.commitCount === "number"
          ? Math.max(0, meta.commitCount - commitItems.length)
          : null,
      files:
        typeof meta.fileCount === "number" ? Math.max(0, meta.fileCount - fileItems.length) : null,
    },
  };
  // JSON.stringify escapes lone surrogates, so URI encoding safely measures UTF-8 bytes.
  const serializedBytes = () =>
    encodeURIComponent(JSON.stringify(summary, null, 2)).replace(/%[0-9A-F]{2}/g, "x").length;
  const previews = [
    {
      text: () => summary.body,
      shorten: (body: string) => {
        summary.body = body;
        summary.omissions.bodyCharacters = pr.bodyLength - codePoints(body);
      },
    },
    ...[...summary.comments, ...summary.reviews].map((item) => ({
      text: () => item.body,
      shorten: (body: string) => {
        item.body = body;
        item.bodyTruncated = true;
      },
    })),
  ];
  // Shorten the longest preview, by at most half per step, until the assembled summary fits.
  for (let excess = serializedBytes() - OUTPUT_BUDGET; excess > 0;) {
    const longest = previews.reduce((a, b) => (b.text().length > a.text().length ? b : a));
    const characters = Array.from(longest.text());
    if (characters.length === 0)
      throw new Error(
        `PR ${input.number}: review summary exceeds ${OUTPUT_BUDGET} bytes even without text previews; use narrower GitHub queries`,
      );
    const kept = Math.max(Math.floor(characters.length / 2), characters.length - excess);
    longest.shorten(characters.slice(0, kept).join(""));
    excess = serializedBytes() - OUTPUT_BUDGET;
  }
  return summary;
}
