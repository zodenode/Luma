import { NextResponse } from "next/server";
import { z } from "zod";
import { handleUserChat } from "@/lib/chat";

const Schema = z.object({
  userId: z.string().min(1),
  content: z.string().min(1).max(4000),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const reply = await handleUserChat(parsed.data.userId, parsed.data.content);
  return NextResponse.json({ reply });
}
