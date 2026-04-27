import { NextResponse } from "next/server";
import { z } from "zod";
import { treatmentToCareState } from "@/lib/careApi";
import { getTreatment, getUser } from "@/lib/store";
import { getRequestId, withRequestIdHeaders } from "@/lib/requestContext";

export async function GET(req: Request) {
  const requestId = getRequestId(req);
  const { searchParams } = new URL(req.url);
  const parsed = z.object({ userId: z.string().min(1) }).safeParse({
    userId: searchParams.get("userId") ?? "",
  });
  if (!parsed.success) {
    return withRequestIdHeaders(
      NextResponse.json({ error: parsed.error.flatten() }, { status: 400 }),
      requestId,
    );
  }
  const user = await getUser(parsed.data.userId);
  if (!user) {
    return withRequestIdHeaders(NextResponse.json({ error: "not_found" }, { status: 404 }), requestId);
  }
  const treatment = await getTreatment(parsed.data.userId);
  return withRequestIdHeaders(
    NextResponse.json({ state: treatmentToCareState(treatment) }),
    requestId,
  );
}
