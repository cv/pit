import { defineCapability } from "../capability-core.js";

export const uiCapability = defineCapability({
  interfaceName: "PitUiCapability",
  methods: {
    confirm: {
      callDescription: "Confirm with the operator",
      declaration: "confirm(title: string, message: string): Promise<boolean>;",
      documentation: "ui.confirm(title, message)",
      minimumArguments: 2,
      maximumArguments: 2,
    },
    input: {
      callDescription: "Request operator input",
      declaration: "input(title: string, placeholder?: string): Promise<string | undefined>;",
      documentation: "ui.input(title, placeholder?)",
      minimumArguments: 1,
      maximumArguments: 2,
    },
    select: {
      callDescription: "Ask the operator to select",
      declaration: "select(title: string, options: string[]): Promise<string | undefined>;",
      documentation: "ui.select(title, options)",
      minimumArguments: 2,
      maximumArguments: 2,
    },
    notify: {
      callDescription: "Notify the operator",
      declaration: 'notify(message: string, level?: "info" | "warning" | "error"): Promise<null>;',
      documentation: "ui.notify(message, level?) (UI availability depends on mode)",
      minimumArguments: 1,
      maximumArguments: 2,
    },
  },
});
