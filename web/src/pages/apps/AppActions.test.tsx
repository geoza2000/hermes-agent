// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AppActions } from "./AppActions";
const fetchJSON = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ fetchJSON, HERMES_BASE_PATH: "/proxy" }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.restoreAllMocks());
it("previews with an opaque sandbox and publishes only after explicit confirmation", async () => {
  const host = document.createElement("div"); const root = createRoot(host); const published = vi.fn();
  fetchJSON.mockResolvedValue({ path: "/apps-cap/test/" });
  await act(async () => root.render(<AppActions profile="personal" slug="notes" onPublished={published} />));
  const button = (text: string) => Array.from(host.querySelectorAll("button")).find(b => b.textContent === text)!;
  expect(host.textContent).not.toContain("Approve and publish draft");
  await act(async () => button("Preview draft").click());
  expect(host.querySelector("iframe")?.getAttribute("src")).toBe("/proxy/apps-cap/test/");
  expect(host.querySelector("iframe")?.getAttribute("sandbox")).not.toContain("allow-same-origin");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await act(async () => button("Approve and publish draft").click());
  expect(fetchJSON).toHaveBeenCalledTimes(1);
  confirm.mockReturnValue(true);
  await act(async () => button("Approve and publish draft").click());
  expect(fetchJSON).toHaveBeenLastCalledWith("/api/apps/notes/publish?profile=personal", expect.objectContaining({ method: "POST" }));
  expect(published).toHaveBeenCalledTimes(1);
  expect(host.querySelector("iframe")).toBeNull();
  await act(async () => root.unmount());
});
