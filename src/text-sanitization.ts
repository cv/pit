export function sanitizeTerminalText(value: string): string {
  let sanitized = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character === "\r") {
      sanitized += "\n";
    } else if (character === "\n" || character === "\t" || (code >= 32 && code !== 127)) {
      sanitized += character;
    }
  }
  return sanitized;
}
