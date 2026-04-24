import { newId } from "./id";

export function getOrCreateRequestId(req: Request): string {
  return req.headers.get("x-request-id")?.trim() || newId("req");
}

export function jsonWithRequestId(
  body: unknown,
  options: { requestId: string; status?: number },
): Response {
  return Response.json(body, {
    status: options.status,
    headers: { "x-request-id": options.requestId },
  });
}
