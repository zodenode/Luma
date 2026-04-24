import { describe, expect, it } from "vitest";
import { createHmac } from "crypto";
import { stableIdempotencyKey, verifyWebhookHmac } from "./webhookSecurity";

describe("verifyWebhookHmac", () => {
  it("accepts when secret unset", () => {
    expect(verifyWebhookHmac("{}", "sha256=abc", undefined)).toBe(true);
  });

  it("validates sha256 hex signature", () => {
    const secret = "test-secret";
    const body = '{"hello":"world"}';
    const hex = createHmac("sha256", secret).update(body, "utf8").digest("hex");
    expect(verifyWebhookHmac(body, `sha256=${hex}`, secret)).toBe(true);
    expect(verifyWebhookHmac(body, "sha256=deadbeef", secret)).toBe(false);
  });
});

describe("stableIdempotencyKey", () => {
  it("joins parts", () => {
    expect(stableIdempotencyKey(["a", "b"])).toBe("a:b");
  });
});
