import type { PiControlServices } from "./services.js";

const MAX_COMMANDS = 200;

type CommandsCapabilityHandler = () => unknown;

export function createCommandsCapabilityHandler({
  pi,
}: Pick<PiControlServices, "pi">): CommandsCapabilityHandler {
  return () => {
    const available = pi.getCommands();
    const metadata = (command: (typeof available)[number]) => ({
      name: command.name,
      ...(command.description === undefined ? {} : { description: command.description }),
      source: command.source,
      sourceInfo: {
        path: command.sourceInfo.path,
        source: command.sourceInfo.source,
        scope: command.sourceInfo.scope,
        origin: command.sourceInfo.origin,
        ...(command.sourceInfo.baseDir === undefined
          ? {}
          : { baseDir: command.sourceInfo.baseDir }),
      },
    });
    return {
      commands: available.slice(0, MAX_COMMANDS).map(metadata),
      truncated: available.length > MAX_COMMANDS,
    };
  };
}
