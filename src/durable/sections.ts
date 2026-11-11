import type { PromptInput, PromptSection } from "@earendil-works/pi-durable";

import { projectFunctionCatalog, userFunctionCatalog } from "../functions/persistent-functions.js";
import { PROMPT_GUIDELINES, PROMPT_SNIPPET } from "../tool/metadata.js";
import type { DurableFunctionStore } from "./state.js";

// Context editing is Pi-only so far; its guideline would point at unavailable functions.
const GUIDELINES = PROMPT_GUIDELINES.filter((guideline) => !guideline.startsWith("Long tasks:"));

/** How to use the `typescript` tool: Pi's prompt snippet and guidelines for it. */
export const GUIDELINES_SECTION: PromptSection = {
  key: "pit_guidelines",
  render: () =>
    [`typescript: ${PROMPT_SNIPPET}.`, ...GUIDELINES.map((line) => `- ${line}`)].join("\n"),
};

/**
 * The user and project function catalogs, as Pi's system prompt lists them. Both are empty, and
 * so omitted, until a conversation has saved functions in those scopes.
 */
export function createCatalogSections(
  store: DurableFunctionStore,
  cwdOf: (input: PromptInput) => string,
): PromptSection[] {
  return [
    {
      key: "pit_user_functions",
      render: async (input) => {
        const { functionState } = await store.persistent(input.conversationId, cwdOf(input));
        return (
          userFunctionCatalog(
            functionState.userMetadata,
            functionState.project,
            functionState.session,
          ) || undefined
        );
      },
    },
    {
      key: "pit_project_functions",
      render: async (input) => {
        const { functionState } = await store.persistent(input.conversationId, cwdOf(input));
        return projectFunctionCatalog(functionState.metadata, functionState.session) || undefined;
      },
    },
  ];
}
