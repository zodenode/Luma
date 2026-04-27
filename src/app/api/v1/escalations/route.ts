import { NextResponse } from "next/server";
import { z } from "zod";
import { getEscalations, updateEscalation } from "@/lib/store";
import { getRequestId, withRequestIdHeaders } from "@/lib/requestContext";

export async function GET(req: Request) {
  const requestId = getRequestId(req);
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get("userId") ?? undefined;
  const status = searchParams.get("status") as "open" | "acknowledged" | "closed" | null;
  const parsed = z
    .object({
      userId: z.string().optional(),
      status: z.enum(["open", "acknowledged", "closed"]).optional(),
    })
    .safeParse({
      userId: userId || undefined,
      status: status ?? undefined,
    });
  if (!parsed.success) {
    return withRequestIdHeaders(
      NextResponse.json({ error: parsed.error.flatten() }, { status: 400 }),
      requestId,
    );
  }
  const list = await getEscalations(parsed.data.userId, parsed.data.status);
  return withRequestIdHeaders(NextResponse.json({ escalations: list }), requestId);
}

export async function PATCH(req: Request) {
  const requestId = getRequestId(req);
  const body = await req.json().catch(() => null);
  const parsed = z
    .object({
      id: z.string().min(1),
      status: z.enum(["open", "acknowledged", "closed"]),
    })
    .safeParse(body);
  if (!parsed.success) {
    return withRequestIdHeaders(
      NextResponse.json({ error: parsed.error.flatten() }, { status: 400 }),
      requestId,
    );
  }
  const updated = await updateEscalation(parsed.data.id, { status: parsed.data.status });
  if (!updated) {
    return withRequestIdHeaders(NextResponse.json({ error: "not_found" }, { status: 404 }), requestId);
  }
  return withRequestIdHeaders(NextResponse.json({ escalation: updated }), requestId);
}
