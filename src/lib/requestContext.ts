import { randomUUID } from "crypto";

export function getOrCreateRequestId(req: Request): string {
  const fromHeader = req.headers.get("x-request-id")?.trim();
  if (fromHeader) return fromHeader.slice(0, 128);
  return randomUUID();
}

export function logLine(
  level: "info" | "warn" | "error",
  requestId: string,
  msg: string,
  extra?: Record<string, unknown>,
): void {
  const base = { level, requestId, msg, ts: new Date().toISOString(), ...extra };
  const line = JSON.stringify(base);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
