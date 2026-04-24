import { runSummariseJob } from "@/lib/chat";
import { jsonWithRequestId, getOrCreateRequestId } from "@/lib/request-id";
import { z } from "zod";

const Body = z.object({
  userId: z.string().min(1),
});

/** POST /api/v1/chat/summarise — plan §6.3 */
export async function POST(req: Request) {
  const requestId = getOrCreateRequestId(req);
  const body = await req.json().catch(() => null);
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return jsonWithRequestId({ error: parsed.error.flatten() }, { requestId, status: 400 });
  }
  const result = await runSummariseJob(parsed.data.userId);
  if ("error" in result) {
    return jsonWithRequestId(result, { requestId, status: 400 });
  }
  return jsonWithRequestId(result, { requestId });
}
