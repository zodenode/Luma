import { getTreatment, getUser } from "@/lib/store";
import { jsonWithRequestId, getOrCreateRequestId } from "@/lib/request-id";
import { z } from "zod";

export const dynamic = "force-dynamic";

const Query = z.object({
  userId: z.string().min(1),
});

export async function GET(req: Request) {
  const requestId = getOrCreateRequestId(req);
  const url = new URL(req.url);
  const parsed = Query.safeParse({ userId: url.searchParams.get("userId") });
  if (!parsed.success) {
    return jsonWithRequestId({ error: parsed.error.flatten() }, { requestId, status: 400 });
  }
  const user = await getUser(parsed.data.userId);
  if (!user) return jsonWithRequestId({ error: "not_found" }, { requestId, status: 404 });
  const treatment = await getTreatment(parsed.data.userId);
  return jsonWithRequestId(
    {
      stage: treatment?.stage ?? "intake",
      medication_status: treatment?.medication_status ?? "none",
      adherence_indicator: treatment?.adherence_indicator ?? "unknown",
      adherence_score: treatment?.adherence_score ?? null,
      next_recommended_action: treatment?.next_recommended_action ?? null,
    },
    { requestId },
  );
}
