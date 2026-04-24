import { getEvents } from "@/lib/store";
import { jsonWithRequestId, getOrCreateRequestId } from "@/lib/request-id";
import { z } from "zod";

export const dynamic = "force-dynamic";

const Query = z.object({
  userId: z.string().min(1),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export async function GET(req: Request) {
  const requestId = getOrCreateRequestId(req);
  const url = new URL(req.url);
  const parsed = Query.safeParse({
    userId: url.searchParams.get("userId"),
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return jsonWithRequestId({ error: parsed.error.flatten() }, { requestId, status: 400 });
  }
  const events = await getEvents(parsed.data.userId);
  const cursorIdx = parsed.data.cursor
    ? events.findIndex((e) => e.id === parsed.data.cursor)
    : -1;
  const sliceStart = cursorIdx >= 0 ? cursorIdx + 1 : 0;
  const page = events.slice(sliceStart, sliceStart + parsed.data.limit);
  const nextCursor = page.length ? page[page.length - 1]!.id : null;
  return jsonWithRequestId({ events: page, next_cursor: nextCursor }, { requestId });
}
