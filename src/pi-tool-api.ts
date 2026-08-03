import type { AgentToolResult, ToolInfo } from "@earendil-works/pi-coding-agent";

export type PiToolScope = "active" | "registered";

export interface PiToolListOptions {
  scope?: PiToolScope;
}

export interface PiToolExecutionUpdateContext {
  toolCallId: string;
}

export type PiToolErrorKind =
  | "not_found"
  | "inactive"
  | "validation"
  | "blocked"
  | "aborted"
  | "execution"
  | "hook"
  | "recursion";

export interface PiToolExecutionOptions {
  scope?: PiToolScope;
  signal?: AbortSignal;
  /** Observer failures do not fail or interrupt tool execution. */
  onUpdate?: (
    update: AgentToolResult<unknown>,
    context: PiToolExecutionUpdateContext,
  ) => void | Promise<void>;
}

export interface PiToolExecutionResult extends AgentToolResult<unknown> {
  toolCallId: string;
  isError: boolean;
  errorKind?: PiToolErrorKind;
}

export interface PiToolExecutionApi {
  listTools(options?: PiToolListOptions): Array<ToolInfo & { active: boolean }>;
  executeTool(
    name: string,
    args: Record<string, unknown>,
    options?: PiToolExecutionOptions,
  ): Promise<PiToolExecutionResult>;
}
