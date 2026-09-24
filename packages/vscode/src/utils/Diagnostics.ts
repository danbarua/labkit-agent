import { log, logError } from "./Logger";

export function sendEvent(
  event: string,
  fields?: Record<string, string>,
  measurements?: Record<string, number>,
): void {
  log(event, { ...fields, ...measurements });
}

export function sendError(
  event: string,
  fields?: Record<string, string>,
  measurements?: Record<string, number>,
): void {
  logError(event, { ...fields, ...measurements });
}
