import { LIMITS, sliceText } from "../shared/bounds.js";

export function displayedFunctionPath(path: string[]): string {
  return path.join(" → ");
}

export function displayedFailure(message: string, expanded: boolean): string {
  if (expanded) return message;
  const headline = sliceText(message, LIMITS.failureHeadline, "head");
  return headline.truncated ? `${headline.text} …` : headline.text;
}
