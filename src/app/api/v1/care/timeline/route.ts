import { NextResponse } from "next/server";
import { z } from "zod";
import { getEvents, getUser } from "@/lib/store";
import { getRequestId, withRequestIdHeaders } from "@/lib/requestContext";
import type { CareEvent } from "@/lib/types";

const PAGE = 20;

function encodeCursor(e: CareEvent): string {
  return Buffer.from(`${e.occurred_at}|${e.id}`, "utf8").toString("base64url");
}

function decodeCursor(c: string): { at: string; id: string } | null {
  try {
    const raw = Buffer.from(c, "base64url").toString("utf8");
    const [at, id] = raw.split("|");
    if (!at || !id) return null;
    return { at, id };
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const requestId = getRequestId(req);
  const { searchParams } = new URL(req.url);
  const parsed = z
    .object({
      userId: z.string().min(1),
      cursor: z.string().optional(),
    })
    .safeParse({
      userId: searchParams.get("userId") ?? "",
      cursor: searchParams.get("cursor") ?? undefined,
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

  const all = await getEvents(parsed.data.userId);
  let slice = all;
  if (parsed.data.cursor) {
    const cur = decodeCursor(parsed.data.cursor);
    if (cur) {
      const idx = all.findIndex((e) => e.occurred_at === cur.at && e.id === cur.id);
      if (idx >= 0) slice = all.slice(idx + 1);
    }
  }
  const page = slice.slice(0, PAGE);
  const nextCursor =
    page.length === PAGE ? encodeCursor(page[page.length - 1]) : null;

  return withRequestIdHeaders(
    NextResponse.json({
      events: page,
      next_cursor: nextCursor,
    }),
    requestId,
  );
}
