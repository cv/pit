import { boundText, LIMITS } from "../shared/bounds.js";

export function displayedFunctionPath(path: string[]): string {
  return path.join(" → ");
}

const STACK_FRAME_OR_BLANK = /^\s+at\s|^\s*$/;

/**
 * Collapsed failures keep the leading context and the decisive tail, such as the last stderr
 * lines of a failed command, around a counted omission.
 */
export function displayedFailure(message: string, expanded: boolean): string {
  if (expanded) return message;
  // Trailing guest stack frames stay in the expanded view, so the preview ends on the cause.
  const rows = message.split("\n");
  let end = rows.length;
  while (end > 1 && STACK_FRAME_OR_BLANK.test(rows[end - 1] as string)) end--;
  return boundText(rows.slice(0, end).join("\n"), LIMITS.failurePreview, "ends").text;
}
