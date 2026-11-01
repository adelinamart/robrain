// Text extraction over the AI SDK's ModelMessage shape, typed structurally so
// the provider carries no dependency on a specific `ai` version.

export interface MessageLike {
  readonly role: string;
  readonly content: unknown;
}

/** Flatten a ModelMessage content value to plain text (text parts only). */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Names of the tools called in these messages (assistant `tool-call` parts),
 * de-duplicated in order of first use. What an agent does, for the org's
 * tool→tag mapping on RoBrain cloud; never the arguments or results.
 */
export function toolNamesIn(messages: readonly MessageLike[]): string[] {
  const names: string[] = [];
  for (const m of messages) {
    if (!m || m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (!part || typeof part !== "object") continue;
      const p = part as { type?: unknown; toolName?: unknown };
      if (p.type !== "tool-call" || typeof p.toolName !== "string") continue;
      const name = p.toolName.trim().slice(0, 100);
      if (name && !names.includes(name)) names.push(name);
      if (names.length >= 50) return names;
    }
  }
  return names;
}

/** Text of the last message with the given role, or "" when there is none. */
export function lastTextByRole(messages: readonly MessageLike[], role: string): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === role) {
      const text = textOf(m.content).trim();
      if (text) return text;
    }
  }
  return "";
}
