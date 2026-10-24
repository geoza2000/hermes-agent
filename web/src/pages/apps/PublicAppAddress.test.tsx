// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PublicAppAddress } from "./PublicAppAddress";
const fetchJSON = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ fetchJSON }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("loads the profile's configured address and verifies a saved address by reading back", async () => {
  const host = document.createElement("div"); const root = createRoot(host);
  fetchJSON.mockResolvedValue({ apps: { public_base_url: "https://hermes.example/proxy" } });
  const changed = vi.fn();
  await act(async () => root.render(<PublicAppAddress profile="personal" onChange={changed} />));
  expect((host.querySelector("input") as HTMLInputElement).value).toBe("https://hermes.example/proxy");
  await act(async () => host.querySelector("button")!.click());
  expect(fetchJSON).toHaveBeenCalledWith("/api/config?profile=personal", expect.objectContaining({ method: "PUT", body: JSON.stringify({ config: { apps: { public_base_url: "https://hermes.example/proxy" } } }) }));
  expect(fetchJSON.mock.calls.filter(c => c.length === 1).length).toBe(2);
  expect(changed).toHaveBeenLastCalledWith("https://hermes.example/proxy");
  await act(async () => root.unmount());
});
