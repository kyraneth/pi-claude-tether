/** A callback-free probe child: stdout and close match cross-spawn's contract. */
import { vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

export function cliProbe(
  stdout = "2.1.283 (Claude Code)",
  code: number | null = 0,
  error?: Error,
): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  proc.stdout = new PassThrough();
  proc.kill = vi.fn(() => true);
  queueMicrotask(() => {
    proc.stdout!.emit("data", stdout);
    if (error) proc.emit("error", error);
    else proc.emit("close", code);
  });
  return proc;
}
