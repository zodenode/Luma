import { NextResponse } from "next/server";
import { readDB } from "./store";
import type { User } from "./types";

export function verifySecret(req: Request, envVar: string): boolean {
  const expected = process.env[envVar];
  if (!expected) return true; // in dev without secret, accept
  const provided = req.headers.get("x-webhook-secret");
  return provided === expected;
}

export async function resolveUserByOpenLoopId(openloopId: string): Promise<User | null> {
  const db = await readDB();
  return db.users.find((u) => u.linked_openloop_id === openloopId) ?? null;
}

export async function resolveUserByAny(args: {
  userId?: string;
  openloopId?: string;
}): Promise<User | null> {
  const db = await readDB();
  if (args.userId) {
    return db.users.find((u) => u.id === args.userId) ?? null;
  }
  if (args.openloopId) {
    return db.users.find((u) => u.linked_openloop_id === args.openloopId) ?? null;
  }
  return null;
}

export function unauthorized() {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export function badRequest(msg: string) {
  return NextResponse.json({ error: msg }, { status: 400 });
}

export function notFound(msg: string) {
  return NextResponse.json({ error: msg }, { status: 404 });
}
