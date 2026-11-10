/** Official CLI owns the entire sign-in exchange. No credential file is read. */
import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { cliEnvironment, resolveCliPath } from "./process-manager.js";

export interface AccountUI {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
}

/** Handles OSC hyperlinks as well as CSI colour/control sequences. */
export function plainCliOutput(text: string): string {
  return stripVTControlCharacters(text);
}

export async function accountAuth(
  dir: string,
  action: "login" | "logout",
  ui: AccountUI,
  options: { email?: string; sso?: boolean; console?: boolean } = {},
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error("Account authentication cancelled");
  const env = cliEnvironment(dir);
  const binary = resolveCliPath(env);
  if (!binary) throw new Error("Claude Code CLI not found on PATH");
  const args = ["auth", action];
  if (action === "login") {
    args.push(options.console ? "--console" : "--claudeai");
    if (options.email) args.push("--email", options.email);
    if (options.sso) args.push("--sso");
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let prompted = false;
    let inputPending = false;
    let lastRejection = -1;
    let cancelled = false;
    const abort = () => {
      cancelled = true;
      child.kill();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdin.on("error", () => {
      /* close/error below owns completion */
    });
    const askForCode = () => {
      if (inputPending || cancelled) return;
      inputPending = true;
      void ui
        .input("Paste code (code#state) from the Claude sign-in page")
        .then((code) => {
          inputPending = false;
          if (child.exitCode !== null || child.signalCode !== null) return;
          if (code === undefined) abort();
          else child.stdin.write(`${code}\n`);
        })
        .catch(() => abort());
    };
    const consume = (data: string) => {
      output += data;
      const clean = plainCliOutput(output);
      if (!prompted && /Paste code here/i.test(clean)) {
        prompted = true;
        const urls = clean.match(/https?:\/\/[^\s<>]+/g) ?? [];
        ui.notify(
          urls.length
            ? `Claude sign-in URL (open anywhere):\n${urls.join("\n")}`
            : `CLI sign-in output:\n${clean}`,
          "info",
        );
        askForCode();
      }
      // Observed official-CLI line (§3.2 of the login prior art): it keeps
      // stdin open after a malformed paste. Surface that rejection and let
      // the user retry or cancel; do not impose a deadline or retry limit.
      const rejection =
        "Invalid code. Please make sure the full code was copied.";
      const at = clean.lastIndexOf(rejection);
      if (at > lastRejection) {
        lastRejection = at;
        ui.notify(`Claude CLI: ${rejection}`, "warning");
        askForCode();
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.on("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (cancelled) reject(new Error("Account authentication cancelled"));
      else if (code !== 0)
        reject(
          new Error(
            `Claude auth ${action} failed (exit ${code}): ${plainCliOutput(output)}`,
          ),
        );
      else resolve();
    });
  });
}
