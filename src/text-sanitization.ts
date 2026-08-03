const ESCAPE = "\u001b";
const STRING_CONTROL_INTRODUCERS = new Set(["]", "P", "X", "^", "_"]);
const SGR_RESET_WITHOUT_BACKGROUND = "\u001b[22;23;24;25;27;28;29;39m";

export interface TerminalSanitizationOptions {
  preserveSgr?: boolean;
}

function csiEnd(value: string, start: number): number {
  for (let index = start; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) {
      return index;
    }
  }
  return value.length;
}

function controlStringEnd(value: string, start: number): number {
  for (let index = start; index < value.length; index++) {
    if (value.charCodeAt(index) === 0x07) {
      return index + 1;
    }
    if (value[index] === ESCAPE && value[index + 1] === "\\") {
      return index + 2;
    }
  }
  return value.length;
}

function isSgrParameters(value: string): boolean {
  for (const character of value) {
    if (!(character === ";" || character === ":" || (character >= "0" && character <= "9"))) {
      return false;
    }
  }
  return true;
}

function preservedSgr(parameters: string): string {
  if (parameters === "" || parameters === "0") {
    return SGR_RESET_WITHOUT_BACKGROUND;
  }
  if (parameters.startsWith("0;")) {
    return `${SGR_RESET_WITHOUT_BACKGROUND}${ESCAPE}[${parameters.slice(2)}m`;
  }
  return `${ESCAPE}[${parameters}m`;
}

export function sanitizeTerminalText(
  value: string,
  options: TerminalSanitizationOptions = {},
): string {
  let sanitized = "";
  let index = 0;
  while (index < value.length) {
    const character = value[index] as string;
    const code = value.charCodeAt(index);
    if (character === ESCAPE) {
      const introducer = value[index + 1];
      if (introducer === "[") {
        const end = csiEnd(value, index + 2);
        if (
          options.preserveSgr &&
          end < value.length &&
          value[end] === "m" &&
          isSgrParameters(value.slice(index + 2, end))
        ) {
          sanitized += preservedSgr(value.slice(index + 2, end));
        }
        index = end + 1;
        continue;
      }
      if (introducer && STRING_CONTROL_INTRODUCERS.has(introducer)) {
        index = controlStringEnd(value, index + 2);
        continue;
      }
      index += introducer ? 2 : 1;
      continue;
    }
    if (code === 0x9b) {
      index = csiEnd(value, index + 1) + 1;
      continue;
    }
    if (character === "\r") {
      sanitized += "\n";
      index += value[index + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (character === "\n" || character === "\t" || (code >= 32 && code !== 127)) {
      sanitized += character;
    }
    index++;
  }
  return sanitized;
}
