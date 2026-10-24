import { describe, expect, it } from "vitest";
import { phoneLink, validatePublicBase } from "./apps-links";

describe("phone links", () => {
  it("keeps a configured proxy subpath and uses only the stable signed-in entry", () => {
    expect(phoneLink("https://hermes.example/hermes/", "/apps/personal/invoices/")).toBe("https://hermes.example/hermes/apps/personal/invoices/");
    expect(validatePublicBase("")).toBe("");
  });
  it.each(["http://example.com", "https://u:p@example.com", "https://example.com/?token=x", "javascript:alert(1)", "https://example.com/#x", "https://example.com\\evil"])("rejects unsafe public address %s", value => {
    expect(() => validatePublicBase(value)).toThrow();
  });
});
