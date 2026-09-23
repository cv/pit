import { truncateHead } from "@earendil-works/pi-coding-agent";

export function displayedFunctionPath(path: string[]): string {
  return path.join(" → ");
}

export function displayedFailure(message: string, expanded: boolean): string {
  if (expanded) return message;
  const bounded = truncateHead(message, {
    maxBytes: 2_000,
    maxLines: 1,
  });
  if (!bounded.truncated) {
    return bounded.content;
  }
  return `${bounded.content} …`;
}
