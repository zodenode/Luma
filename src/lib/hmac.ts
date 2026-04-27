import { createHmac, timingSafeEqual } from "crypto";

/**
 * Verifies `X-Signature: sha256=<hex>` (or raw hex) against the request body using HMAC-SHA256.
 */
export function verifyWebhookHmac(
  body: string,
  signatureHeader: string | null,
  secret: string | undefined,
): boolean {
  if (!secret) return true;
  if (!signatureHeader) return false;
  const sig = signatureHeader.replace(/^sha256=/i, "").trim();
  if (!/^[a-f0-9]+$/i.test(sig)) return false;
  const mac = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  try {
    const a = Buffer.from(mac, "hex");
    const b = Buffer.from(sig, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
