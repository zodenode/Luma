import { getEvents, getUser } from "@/lib/store";
import { jsonError, jsonOk, requireUserId } from "@/lib/v1";

export const dynamic = "force-dynamic";

/** Cursor: occurred_at ISO string — return events strictly older than cursor. */
export async function GET(req: Request) {
  const userId = requireUserId(req);
  if (!userId) return jsonError(req, 400, "missing_user_id");

  const user = await getUser(userId);
  if (!user) return jsonError(req, 404, "user_not_found");

  const url = new URL(req.url);
  const cursor = url.searchParams.get("cursor")?.trim();
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? "20") || 20));

  let events = await getEvents(userId);
  if (cursor) {
    events = events.filter((e) => e.occurred_at < cursor);
  }
  const page = events.slice(0, limit);
  const next_cursor =
    page.length > 0 ? page[page.length - 1].occurred_at : null;

  return jsonOk(req, { events: page, next_cursor });
}
