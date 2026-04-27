import { NextResponse } from "next/server";
import { z } from "zod";
import { createIntake } from "@/lib/intake";

const Schema = z.object({
  name: z.string().min(1).max(80),
  goal: z.enum(["hormones", "weight_loss", "energy", "sleep", "mental_health"]),
  symptoms: z.array(z.string()).max(20).default([]),
  history: z.string().max(2000).default(""),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const user = await createIntake(parsed.data);
  return NextResponse.json({ user });
}
