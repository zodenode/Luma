import { z } from "zod";
import { jsonError, jsonOk } from "@/lib/v1";

const Schema = z.object({
  userId: z.string().min(1),
  kind: z.enum(["adherence", "shipment_followup"]),
  run_at: z.string().optional(),
});

/**
 * MVP stub: accepts reminder intent; production would enqueue durable jobs.
 * Engineering plan slice D — scheduling hook.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return jsonError(req, 400, "invalid_body");

  return jsonOk(req, {
    ok: true,
    scheduled: false,
    note: "Reminder scheduling is a stub in the JSON-store MVP; integrate a queue for production.",
    ...parsed.data,
  });
}
