import { getTreatment, getUser } from "@/lib/store";
import { jsonError, jsonOk, requireUserId } from "@/lib/v1";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const userId = requireUserId(req);
  if (!userId) return jsonError(req, 400, "missing_user_id");

  const user = await getUser(userId);
  if (!user) return jsonError(req, 404, "user_not_found");

  const treatment = await getTreatment(userId);
  return jsonOk(req, { user_id: userId, treatment });
}
