import { createHmac, timingSafeEqual } from "crypto";

/**
 * Verify `X-Signature: sha256=<hex>` HMAC over raw body (plan §6.2).
 */
export function verifyWebhookHmac(
  rawBody: string,
  signatureHeader: string | null,
  secret: string | undefined,
): boolean {
  if (!secret) return true;
  if (!signatureHeader) return false;
  const match = /^sha256=(.+)$/i.exec(signatureHeader.trim());
  if (!match) return false;
  const provided = match[1];
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  try {
    const a = Buffer.from(provided, "hex");
    const b = Buffer.from(expected, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function signWebhookBody(secret: string, rawBody: string): string {
  const hex = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return `sha256=${hex}`;
}
