import { describe, expect, it } from "vitest";
import { piContext, historyHash, replayPiMessages } from "../src/pi-context";

describe("the replayed history checkpoint", () => {
  const history = [
    { role: "user", content: "question" },
    { role: "assistant", content: [{ type: "toolCall", id: "t", name: "read", arguments: { path: "file" } }] },
    { role: "toolResult", toolCallId: "t", toolName: "read", content: [{ type: "text", text: "result" }] },
    { role: "user", content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] },
  ];

  it("matches string/text-block and absent/false error representations", () => {
    const equivalent = structuredClone(history) as any[];
    equivalent[0].content = [{ type: "text", text: "question" }];
    equivalent[2].isError = false;
    equivalent[1].content[0].piOnlyMetadata = "not replayed";
    equivalent[3].content[0].piOnlyMetadata = "not replayed";
    expect(replayPiMessages(equivalent)).toEqual(replayPiMessages(history));
    expect(historyHash(equivalent)).toBe(historyHash(history));
  });

  it.each(["text", "result", "error", "image", "mime", "tool-args", "tool-id", "tool-name", "role"])(
    "still mismatches a replay-visible %s change", (change) => {
      const changed = structuredClone(history) as any[];
      if (change === "text") changed[0].content += "!";
      if (change === "result") changed[2].content[0].text += "!";
      if (change === "error") changed[2].isError = true;
      if (change === "image") changed[3].content[0].data += "!";
      if (change === "mime") changed[3].content[0].mimeType = "image/jpeg";
      if (change === "tool-args") changed[1].content[0].arguments.path += "!";
      if (change === "tool-id") changed[2].toolCallId += "!";
      if (change === "tool-name") changed[2].toolName += "!";
      if (change === "role") changed[0].role = "assistant";
      expect(replayPiMessages(changed)).not.toEqual(replayPiMessages(history));
      expect(historyHash(changed)).not.toBe(historyHash(history));
    });
});

describe("pi 0.87 transcript normalization", () => {
  it("uses current prompt sections and tools, never historical declarations", () => {
    const read = {
      name: "read",
      description: "Read",
      parameters: { type: "object" },
    };
    const write = {
      name: "write",
      description: "Write",
      parameters: { type: "object" },
    };
    const user = { role: "user", content: "go" };
    const context = piContext({
      messages: [
        {
          role: "system",
          content: "base",
          sections: { rules: "old rules", remove: "old extra" },
          toolsAdded: [read, write],
        },
        user,
        {
          role: "system",
          content: "",
          sections: { rules: "new rules", remove: null },
          toolsRemoved: [{ name: "write" }],
        },
      ],
    });
    expect(context.systemPrompt).toContain("new rules");
    expect(context.systemPrompt).not.toContain("old");
    expect(context.tools.map((t: any) => t.name)).toEqual(["read"]);
    expect(context.messages).toEqual([user]);
  });

  it("supports legacy Context and an explicitly empty tool set", () => {
    expect(
      piContext({ systemPrompt: "hello", messages: [], tools: [] }),
    ).toEqual({ systemPrompt: "hello", messages: [], tools: [] });
  });
});
