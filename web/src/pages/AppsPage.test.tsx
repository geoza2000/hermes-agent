// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import AppsPage from "./AppsPage";

const fetchJSON = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ fetchJSON, HERMES_BASE_PATH: "", getManagementProfile: () => "personal" }));
vi.mock("@/contexts/useProfileScope", () => ({ useProfileScope: () => ({ profile: "personal" }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const container = document.createElement("div");
const root = createRoot(container);
afterEach(async () => { await act(async () => root.render(null)); vi.clearAllMocks(); });

it("lists private apps with a stable signed-in entry and install help, never a permanent capability link", async () => {
  fetchJSON.mockResolvedValue({ profile: "personal", apps: [{ slug: "invoices", name: "Invoices", icon: "🧾", current_version: 1, entry_path: "/apps/personal/invoices/" }] });
  await act(async () => root.render(<AppsPage />));
  expect(container.textContent).toContain("Invoices");
  expect(container.querySelector('a[data-app-open]')?.getAttribute("href")).toBe("/apps/personal/invoices/");
  const help = Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Install on this device");
  expect(help).toBeTruthy();
  expect(Array.from(container.querySelectorAll("button")).some(b => b.textContent === "Preview draft")).toBe(true);
  await act(async () => help!.click());
  expect(container.textContent).toContain("sign in again");
  expect(container.textContent).toContain("Add to Home Screen");
});

it("creates a draft then offers dismissible installation guidance", async () => {
  fetchJSON.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.includes("/api/config")) return {};
    if (init?.method === "POST") return { app: { slug: "notes", name: "Notes", entry_path: "/apps/personal/notes/", current_version: null } };
    return { profile: "personal", apps: [] };
  });
  await act(async () => root.render(<AppsPage />));
  const form = container.querySelector('form[aria-label="Create app"]');
  expect(form).toBeTruthy();
  await act(async () => form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(container.textContent).toContain("Draft created");
  expect(container.textContent).toContain("Maybe later");
  await act(async () => Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Maybe later")!.click());
  expect(container.textContent).not.toContain("Maybe later");
});


it("suggests installing a published app once, and remembers Not now", async () => {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } });
  fetchJSON.mockResolvedValue({ profile: "personal", apps: [{ slug: "invoices", name: "Invoices", icon: "🧾", current_version: 1, entry_path: "/apps/personal/invoices/" }] });
  await act(async () => root.render(<AppsPage />));
  expect(container.textContent).toContain("Add it to your home screen or Dock");
  await act(async () => Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Not now")!.click());
  expect(container.textContent).not.toContain("Add it to your home screen or Dock");
  await act(async () => root.render(<AppsPage key="again" />));
  expect(container.textContent).not.toContain("Add it to your home screen or Dock");
});


it("opens an installed app's fresh link when launched with ?open=", async () => {
  const replace = vi.fn();
  const original = window.location;
  Object.defineProperty(window, "location", { configurable: true, value: { ...original, search: "?open=invoices&profile=personal", replace } });
  fetchJSON.mockResolvedValue({ path: "/apps-cap/fresh/" });
  await act(async () => root.render(<AppsPage />));
  expect(fetchJSON).toHaveBeenCalledWith("/api/apps/invoices/link?profile=personal", expect.objectContaining({ method: "POST" }));
  expect(replace).toHaveBeenCalledWith("/apps-cap/fresh/");
  Object.defineProperty(window, "location", { configurable: true, value: original });
});
