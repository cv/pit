/**
 * Turns a finished program's value into the typescript tool's result: the fitted text the model
 * receives, its notices, and the details the renderer and context edits read.
 */
import type { CompletedCallJournal } from "../execution/completed-calls.js";
import type { ExecutionProgressController } from "../execution/progress.js";
import type { FunctionActivity } from "../functions/core.js";
import { functionDependencyBinding } from "../functions/identifier.js";
import { getSavedFunctionCallSignature } from "../functions/source.js";
import type { FunctionState } from "../functions/state.js";
import { LIMITS } from "../shared/bounds.js";
import { fitValue } from "../shared/json-budget.js";
import type { ImageAttachmentInfo } from "../workspace/view-image.js";

const TRUNCATION_NOTICE =
  '\n[Result truncated to fit the output budget; omissions are marked "… N omitted …".]';

const MAX_SAVED_FUNCTION_CATALOG_BYTES = 1200;

export function savedFunctionCatalogNotice(registry: ReadonlyMap<string, string>): string {
  const signatures = [...registry]
    .map(([id, source]) => getSavedFunctionCallSignature(source, id))
    .filter((signature): signature is string => signature !== undefined)
    .sort((a, b) => a.localeCompare(b));
  if (signatures.length === 0) {
    return "";
  }

  const notice = (shown: readonly string[], omitted: number): string => {
    const entries = omitted > 0 ? [...shown, `… ${omitted} more`] : shown;
    return `\n[Session functions: ${entries.join(", ")}]`;
  };
  let catalog = notice([], signatures.length);
  for (let shown = 1; shown <= signatures.length; shown++) {
    const candidate = notice(signatures.slice(0, shown), signatures.length - shown);
    if (Buffer.byteLength(candidate) > MAX_SAVED_FUNCTION_CATALOG_BYTES) {
      break;
    }
    catalog = candidate;
  }
  return catalog;
}

export function promotionSuggestionNotice(names: readonly string[]): string {
  const suggested = [...new Set(names)].sort((a, b) => a.localeCompare(b));
  const shown = suggested.slice(0, 5);
  if (shown.length === 0) {
    return "";
  }
  const omitted =
    suggested.length > shown.length ? `; … ${suggested.length - shown.length} more` : "";
  return `\n[Promotion suggestion: heavily reused session function${shown.length === 1 ? "" : "s"} ${shown.join(", ")}. Use functions.promote(name, summary) explicitly in an enabled, trusted project${omitted}.]`;
}

export function buildToolResult(input: {
  value: unknown;
  namedFunction?: string;
  projectFunction: boolean;
  saveOnly: boolean;
  functionState: FunctionState;
  functionActivity: FunctionActivity[];
  promotionSuggestions: string[];
  executionProgress: ExecutionProgressController;
  imageMetadata: ImageAttachmentInfo[];
  imageOmissions: string[];
}) {
  const savedSignature = input.namedFunction
    ? getSavedFunctionCallSignature(input.functionState.effective.get(input.namedFunction) ?? "")
    : undefined;
  const invocationGuidance = savedSignature
    ? `. Inject ${input.namedFunction?.includes(".") ? functionDependencyBinding(input.namedFunction) : input.namedFunction} in the first parameter, then call ${savedSignature}`
    : ".";
  const savedNotice = input.namedFunction
    ? input.saveOnly
      ? `\n[Saved ${input.projectFunction ? "project " : ""}function "${input.namedFunction}" without executing it${invocationGuidance}]`
      : `\n[Saved ${input.projectFunction ? "project " : ""}function "${input.namedFunction}"${invocationGuidance}]`
    : "";
  // The session-function list repeats only when it changed since a result last showed it.
  const catalog = savedFunctionCatalogNotice(input.functionState.session);
  const catalogNotice = catalog === input.functionState.announcedSessionCatalog ? "" : catalog;
  input.functionState.announcedSessionCatalog = catalog;
  const notices =
    savedNotice + promotionSuggestionNotice(input.promotionSuggestions) + catalogNotice;
  // The result gets the budget the notices leave, so the complete text stays within Pi's limit.
  const attachmentText =
    input.imageMetadata.map(({ file, note }) => `\nImage: ${file}\n${note}`).join("") +
    input.imageOmissions.map((omission) => `\n${omission}`).join("");
  const reserved = TRUNCATION_NOTICE + notices + attachmentText;
  const output = fitValue(input.value, {
    maxBytes: LIMITS.result.maxBytes - Buffer.byteLength(reserved),
    maxLines: LIMITS.result.maxLines - (reserved.split("\n").length - 1),
  });
  return {
    content: [
      {
        type: "text" as const,
        text: output.text + (output.truncated ? TRUNCATION_NOTICE : "") + notices + attachmentText,
      },
    ],
    details: {
      // A truncated result keeps its fitted value, so the TUI shows what the model received.
      value: output.value,
      ...(input.imageMetadata.length > 0 ? { imageAttachments: input.imageMetadata } : {}),

      truncated: output.truncated,
      ...(input.functionActivity.length > 0 ? { functions: input.functionActivity } : {}),
      ...input.executionProgress.snapshot(),
    },
  };
}

/** The file edits a program applied, which `session.elide` names when it stubs the call. */
export function appliedEditDetails(journal: CompletedCallJournal) {
  const { edits, omitted } = journal.edits();
  if (edits.length === 0) return {};
  return { edits, ...(omitted > 0 ? { editsOmitted: omitted } : {}) };
}
