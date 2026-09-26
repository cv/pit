import { defineNativeFunction } from "../native-definition.js";

export const uiFunctions = [
  defineNativeFunction("ui", "confirm", {
    summary: "Confirm with the operator",
    declaration: "confirm(title: string, message: string): Promise<boolean>;",
    documentation: "ui.confirm(title, message)",
    minimumArguments: 2,
    maximumArguments: 2,
  }),
  defineNativeFunction("ui", "input", {
    summary: "Request operator input",
    declaration: "input(title: string, placeholder?: string): Promise<string | undefined>;",
    documentation: "ui.input(title, placeholder?)",
    minimumArguments: 1,
    maximumArguments: 2,
  }),
  defineNativeFunction("ui", "select", {
    summary: "Ask the operator to select",
    declaration: "select(title: string, options: string[]): Promise<string | undefined>;",
    documentation: "ui.select(title, options)",
    minimumArguments: 2,
    maximumArguments: 2,
  }),
  defineNativeFunction("ui", "notify", {
    summary: "Notify the operator",
    declaration: 'notify(message: string, level?: "info" | "warning" | "error"): Promise<null>;',
    documentation: "ui.notify(message, level?) (UI availability depends on mode)",
    minimumArguments: 1,
    maximumArguments: 2,
  }),
] as const;
