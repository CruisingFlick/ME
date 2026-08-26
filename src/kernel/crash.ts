import type { Ledger } from "./ledger.js";
import { logger } from "../util/log.js";

const log = logger("crash");

/**
 * Make the process say why it died.
 *
 * An unattended run that vanishes leaves whoever picks it up with a ledger that
 * simply stops: no error, no final state, nothing to distinguish a crash from a
 * closed window from a killed process. That ambiguity has been the single most
 * expensive thing in this project to debug.
 *
 * These handlers write synchronously, because a crashing process will not run
 * anything asynchronous, and then let the failure continue as it would have.
 */
export function recordCrashes(ledger: Ledger): () => void {
  let finished = false;

  const onException = (err: unknown): void => {
    finished = true;
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    ledger.recordSync("error", "process", { stage: "uncaught", error: message.slice(0, 4000) });
    log.error("uncaught exception; the run is ending", message);
    process.exitCode = 1;
    throw err instanceof Error ? err : new Error(message);
  };

  const onRejection = (reason: unknown): void => {
    finished = true;
    const message = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    ledger.recordSync("error", "process", { stage: "unhandled_rejection", error: message.slice(0, 4000) });
    log.error("unhandled rejection; the run is ending", message);
    process.exitCode = 1;
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    finished = true;
    ledger.recordSync("run.finished", "process", { status: "interrupted", signal });
    log.warn(`received ${signal}; the run was interrupted`);
    process.exit(130);
  };

  // Anything reaching `exit` without a recorded ending died in a way none of
  // the handlers above saw - killed from outside, or out of memory.
  const onExit = (code: number): void => {
    if (finished) return;
    ledger.recordSync("run.finished", "process", {
      status: "vanished",
      exitCode: code,
      note: "the process ended without recording an outcome; it was killed from outside or ran out of memory",
    });
  };

  process.on("uncaughtException", onException);
  process.on("unhandledRejection", onRejection);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("exit", onExit);

  return () => {
    finished = true;
    process.off("uncaughtException", onException);
    process.off("unhandledRejection", onRejection);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("exit", onExit);
  };
}
