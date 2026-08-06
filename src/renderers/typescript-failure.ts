import { truncateHead } from "@earendil-works/pi-coding-agent";

const MAX_DISPLAYED_FUNCTION_PATH = 8;

export function displayedFunctionPath(path: string[]): string {
  if (path.length <= MAX_DISPLAYED_FUNCTION_PATH) {
    return path.join(" → ");
  }
  const edge = MAX_DISPLAYED_FUNCTION_PATH / 2;
  return [
    ...path.slice(0, edge),
    `… ${path.length - MAX_DISPLAYED_FUNCTION_PATH} omitted`,
    ...path.slice(-edge),
  ].join(" → ");
}

export function displayedFailure(message: string, expanded: boolean): string {
  const bounded = truncateHead(message, {
    maxBytes: expanded ? 4_000 : 2_000,
    maxLines: expanded ? 12 : 1,
  });
  if (!bounded.truncated) {
    return bounded.content;
  }
  return expanded
    ? `${bounded.content}\n… additional diagnostic lines omitted`
    : `${bounded.content} …`;
}
