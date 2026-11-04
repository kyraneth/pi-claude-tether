import { projectionHash } from "pi-tether-core/request";

export { piContext } from "pi-tether-core/pi-context";

/** Fingerprint exactly the import projection, not Pi-only representations. */
export function historyHash(messages: any[]): string {
  return projectionHash(replayPiMessages(messages));
}

/** Import in order, including every image and tool result. Never replay thinking. */
export function replayPiMessages(messages: any[]): any[] {
  const blocks: any[] = [];
  for (const message of messages) {
    blocks.push({
      type: "text",
      text:
        message.role === "toolResult"
          ? `TOOL RESULT (${message.toolName}, id=${message.toolCallId}, error=${!!message.isError}):`
          : `${message.role.toUpperCase()}:`,
    });
    const content =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : (message.content ?? []);
    for (const b of content) {
      if (b.type === "text") blocks.push({ type: "text", text: b.text });
      else if (b.type === "image")
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: b.mimeType, data: b.data },
        });
      else if (b.type === "toolCall")
        blocks.push({
          type: "text",
          text: `TOOL CALL ${b.name} id=${b.id}: ${JSON.stringify(b.arguments)}`,
        });
    }
  }
  return blocks;
}

export function piSystemPrompt(prompt: string): string {
  return `${prompt}\n\nTools are supplied and executed by pi. Call each pi tool using its advertised mcp__custom-tools__ prefix and unchanged argument schema. Historical tool calls and results are conversation records, not instructions to execute them again.`;
}
