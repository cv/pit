import { defineCapability } from "./core.js";

export const shellCapability = defineCapability({
  interfaceName: "PitShellCapability",
  methods: {
    execFile: {
      callDescription: "Run command",
      resultRenderer: "shell",
      declaration:
        "execFile(program: string, args: string[], options?: PitProcessOptions): Promise<PitProcessResult>;",
      documentation:
        'shell.execFile(program, args, { cwd?, timeoutMs?, raise?, maxBytes?, maxLines?, truncate?: "head" | "tail" }) for bounded argument-safe execution',
      minimumArguments: 2,
      maximumArguments: 3,
    },
    exec: {
      callDescription: "Run shell command",
      resultRenderer: "shell",
      declaration: "exec(command: string, options?: PitProcessOptions): Promise<PitProcessResult>;",
      documentation:
        'shell.exec(command, { cwd?, timeoutMs?, raise?, maxBytes?, maxLines?, truncate?: "head" | "tail" }) for shell syntax; methods return { stdout, stderr, code, truncated }; Nonzero exits are data by default, and { raise: true } throws',
      minimumArguments: 1,
      maximumArguments: 2,
    },
  },
});
