import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Exercise Pi's real after-tool steering delivery, not a provider-only context. */
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "fixture_steer_tool",
    label: "Steer stub tool",
    description: "Deterministic local handoff proof",
    parameters: Type.Object({}),
    async execute() {
      pi.sendUserMessage("FIXTURE-STEER", { deliverAs: "steer" });
      pi.sendUserMessage("FIXTURE-FOLLOWUP", { deliverAs: "followUp" });
      return { content: [{ type: "text", text: "FIXTURE-TOOL-RESULT" }], details: undefined };
    },
  });
}
