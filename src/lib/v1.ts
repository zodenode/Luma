import { NextResponse } from "next/server";
import { getOrCreateRequestId, logLine } from "./requestContext";

export function parseUserId(req: Request): string | null {
  const url = new URL(req.url);
  const q = url.searchParams.get("userId")?.trim();
  if (q) return q;
  return null;
}

export function requireUserId(req: Request): string | null {
  return parseUserId(req);
}

export function jsonOk(
  req: Request,
  data: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): NextResponse {
  const requestId = getOrCreateRequestId(req);
  return NextResponse.json(data, {
    status: init?.status ?? 200,
    headers: {
      "x-request-id": requestId,
      ...(init?.headers ?? {}),
    },
  });
}

export function jsonError(
  req: Request,
  status: number,
  code: string,
  message?: string,
): NextResponse {
  const requestId = getOrCreateRequestId(req);
  logLine(status >= 500 ? "error" : "warn", requestId, message ?? code, { code, status });
  return NextResponse.json(
    { error: code, message: message ?? code, request_id: requestId },
    { status, headers: { "x-request-id": requestId } },
  );
}
