const ESCAPE = "\u001b";
const STRING_CONTROL_INTRODUCERS = new Set(["]", "P", "X", "^", "_"]);
const SGR_RESET_WITHOUT_BACKGROUND = "\u001b[10;22;23;24;25;27;28;29;39;50;54;55;59;65;75m";
const C1_STRING_CONTROL_INTRODUCERS = new Set([0x90, 0x98, 0x9d, 0x9e, 0x9f]);

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
    if (value.charCodeAt(index) === 0x9c) {
      return index + 1;
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

function sgrCode(parameter: string): number {
  const colon = parameter.indexOf(":");
  return Number(colon === -1 ? parameter : parameter.slice(0, colon));
}

function extendedColorTailLength(parts: string[], index: number): number | undefined {
  const mode = sgrCode(parts[index + 1] ?? "");
  const length = mode === 5 ? 2 : mode === 2 ? (parts[index + 2] === "" ? 5 : 4) : 0;
  return length > 0 && index + length < parts.length ? length : undefined;
}

function withoutBackgroundSgr(parameters: string): string | undefined {
  const parts = parameters.split(";");
  const kept: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index] as string;
    const code = sgrCode(part);
    if (code === 38 || code === 48 || code === 58) {
      if (part.includes(":")) {
        if (code !== 48) {
          kept.push(part);
        }
        continue;
      }
      const consumed = extendedColorTailLength(parts, index);
      if (consumed === undefined) {
        return;
      }
      if (code !== 48) {
        kept.push(...parts.slice(index, index + consumed + 1));
      }
      index += consumed;
      continue;
    }
    if ((code >= 40 && code <= 47) || code === 49 || (code >= 100 && code <= 107)) {
      continue;
    }
    kept.push(part);
  }
  return kept.length > 0 ? kept.join(";") : undefined;
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
          const parameters = withoutBackgroundSgr(value.slice(index + 2, end));
          if (parameters !== undefined) {
            sanitized += preservedSgr(parameters);
          }
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
    if (C1_STRING_CONTROL_INTRODUCERS.has(code)) {
      index = controlStringEnd(value, index + 1);
      continue;
    }
    if (code >= 0x80 && code <= 0x9f) {
      index++;
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
