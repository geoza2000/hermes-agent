// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { fetchJSON, setManagementProfile } from "./api";

afterEach(() => { vi.unstubAllGlobals(); setManagementProfile(""); });
it("binds Apps requests to the selected dashboard profile", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ apps: [] }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  setManagementProfile("personal");
  await fetchJSON("/api/apps");
  expect(fetch.mock.calls[0][0]).toBe("/api/apps?profile=personal");
});
