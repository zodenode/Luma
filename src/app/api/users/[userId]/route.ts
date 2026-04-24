import { NextResponse } from "next/server";
import {
  getEvents,
  getLatestMemorySnapshot,
  getMemory,
  getMessages,
  getTreatment,
  getUser,
} from "@/lib/store";

export async function GET(
  _req: Request,
  { params }: { params: { userId: string } },
) {
  const user = await getUser(params.userId);
  if (!user) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const [treatment, events, messages, memory, latest_snapshot] = await Promise.all([
    getTreatment(params.userId),
    getEvents(params.userId),
    getMessages(params.userId),
    getMemory(params.userId),
    getLatestMemorySnapshot(params.userId),
  ]);
  return NextResponse.json({ user, treatment, events, messages, memory, latest_snapshot });
}
