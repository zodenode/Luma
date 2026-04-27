import { describe, expect, it } from "vitest";
import { createHmac } from "crypto";
import { verifyWebhookHmac } from "./hmac";

describe("verifyWebhookHmac", () => {
  it("rejects when secret set and signature missing", () => {
    expect(verifyWebhookHmac("{}", null, "secret")).toBe(false);
  });

  it("accepts matching sha256 hex", () => {
    const body = '{"a":1}';
    const secret = "test";
    const mac = createHmac("sha256", secret).update(body, "utf8").digest("hex");
    expect(verifyWebhookHmac(body, `sha256=${mac}`, secret)).toBe(true);
  });

  it("accepts raw hex header", () => {
    const body = "x";
    const secret = "s";
    const mac = createHmac("sha256", secret).update(body, "utf8").digest("hex");
    expect(verifyWebhookHmac(body, mac, secret)).toBe(true);
  });
});
