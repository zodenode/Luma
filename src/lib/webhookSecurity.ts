import { createHmac, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";

function hex(buf: ArrayBuffer): string {
  return Buffer.from(buf).toString("hex");
}

/**
 * Verify HMAC-SHA256 of raw body using shared secret (engineering plan §6.2).
 * Expects header `x-signature: sha256=<hex>` or `sha256=<hex>`.
 */
export function verifyWebhookHmac(
  rawBody: string,
  signatureHeader: string | null,
  secret: string | undefined,
): boolean {
  if (!secret) return true;
  if (!signatureHeader) return false;
  const value = signatureHeader.replace(/^sha256=/i, "").trim();
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  try {
    const a = Buffer.from(value, "hex");
    const b = Buffer.from(expected, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function webhookUnauthorized() {
  return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
}

export function stableIdempotencyKey(parts: string[]): string {
  return parts.filter(Boolean).join(":");
}
