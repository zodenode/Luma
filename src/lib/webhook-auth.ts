import { verifyWebhookHmac } from "./hmac";

/**
 * Prefer HMAC when OPENLOOP_WEBHOOK_HMAC_SECRET / PHARMACY_WEBHOOK_HMAC_SECRET is set;
 * otherwise fall back to shared secret header (dev).
 */
export function verifyOpenLoopRequest(req: Request, rawBody: string): boolean {
  const hmacSecret = process.env.OPENLOOP_WEBHOOK_HMAC_SECRET;
  if (hmacSecret) {
    return verifyWebhookHmac(rawBody, req.headers.get("x-signature"), hmacSecret);
  }
  const expected = process.env.OPENLOOP_WEBHOOK_SECRET;
  if (!expected) return true;
  return req.headers.get("x-webhook-secret") === expected;
}

export function verifyPharmacyRequest(req: Request, rawBody: string): boolean {
  const hmacSecret = process.env.PHARMACY_WEBHOOK_HMAC_SECRET;
  if (hmacSecret) {
    return verifyWebhookHmac(rawBody, req.headers.get("x-signature"), hmacSecret);
  }
  const expected = process.env.PHARMACY_WEBHOOK_SECRET;
  if (!expected) return true;
  return req.headers.get("x-webhook-secret") === expected;
}
