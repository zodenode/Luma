import { describe, expect, it } from "vitest";
import { signWebhookBody, verifyWebhookHmac } from "./hmac";

describe("verifyWebhookHmac", () => {
  it("accepts matching sha256 signature", () => {
    const secret = "test-secret";
    const body = '{"event":"consult_completed"}';
    const sig = signWebhookBody(secret, body);
    expect(verifyWebhookHmac(body, sig, secret)).toBe(true);
  });

  it("rejects wrong signature", () => {
    const secret = "a";
    const body = "{}";
    expect(verifyWebhookHmac(body, "sha256=deadbeef", secret)).toBe(false);
  });

  it("skips verification when secret unset", () => {
    expect(verifyWebhookHmac("{}", null, undefined)).toBe(true);
  });
});
