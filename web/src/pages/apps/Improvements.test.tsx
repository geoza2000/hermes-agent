// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AppImprovements, GlobalImprovements } from "./Improvements";
const fetchJSON = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ fetchJSON }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.restoreAllMocks(); fetchJSON.mockReset(); });

const defaults = { enabled: true, schedule: "weekly", token_budget: 12000, auto_apply: false };
const button = (host: HTMLElement, text: string) => Array.from(host.querySelectorAll("button")).find(b => b.textContent === text)!;

it("shows and saves the defaults every app inherits, weekly by default", async () => {
  const host = document.createElement("div"); const root = createRoot(host);
  fetchJSON.mockImplementation(async (_path: string, init?: RequestInit) =>
    ({ settings: init ? { ...defaults, ...JSON.parse(String(init.body)) } : defaults }));
  await act(async () => root.render(<GlobalImprovements profile="personal" />));
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="Review schedule"]')!;
  expect(select.value).toBe("weekly");
  expect(host.textContent).toContain("Weekly, Sunday 20:00");
  expect(host.textContent).toContain("Automatic changes are off");
  await act(async () => { select.value = "daily"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => button(host, "Save").click());
  expect(fetchJSON).toHaveBeenLastCalledWith("/api/apps-improvements?profile=personal",
    expect.objectContaining({ method: "PUT", body: JSON.stringify({ enabled: true, schedule: "daily", token_budget: 12000 }) }));
  expect(host.textContent).toContain("Saved.");
  await act(async () => root.unmount());
});

it("lists evidence-backed suggestions, approves into the draft and reports the run's token use", async () => {
  const host = document.createElement("div"); const root = createRoot(host); const drafted = vi.fn();
  const suggestion = { id: "s1", status: "pending", title: "Default due date to 15 days", reason: "You change it every time.",
    evidence: { "top_interactions:change: due-days": 9 }, edit: { path: "index.html", before: "30", after: "15" } };
  const state = { settings: defaults, override: null, request: null, suggestions: [suggestion],
    runs: [{ id: "r1", at: 1_790_000_000, status: "done", budget: 12000, total_tokens: 3100 }] };
  fetchJSON.mockImplementation(async (path: string) => path.endsWith("/approve?profile=personal")
    ? { ...state, suggestions: [{ ...suggestion, status: "applied" }] } : state);
  await act(async () => root.render(<AppImprovements profile="personal" slug="invoices" onDraftChanged={drafted} />));
  expect(host.textContent).toContain("Default due date to 15 days");
  expect(host.textContent).toContain("change: due-days: 9");
  expect(host.textContent).toContain("3,100 of 12,000 tokens");
  expect(host.textContent).toContain("Weekly, Sunday 20:00, up to 12,000 tokens per run.");
  await act(async () => button(host, "Approve").click());
  expect(fetchJSON).toHaveBeenCalledWith("/api/apps/invoices/improvements/s1/approve?profile=personal", expect.objectContaining({ method: "POST" }));
  expect(drafted).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("No suggestions waiting.");
  expect(host.textContent).toContain("Preview the draft, then publish");
  await act(async () => root.unmount());
});

it("runs a review on demand and shows a stopped-at-cap run honestly", async () => {
  const host = document.createElement("div"); const root = createRoot(host);
  const state = { settings: defaults, override: null, request: null, suggestions: [],
    runs: [{ id: "r2", at: 1_790_000_000, status: "budget_exhausted", budget: 12000, total_tokens: 50000,
      error: "The review used 50000 tokens, over the 12000 token cap, so its suggestions were discarded." }] };
  fetchJSON.mockImplementation(async (path: string) => path.endsWith("/run?profile=personal")
    ? { request: { id: "q", status: "queued", at: 1 } } : state);
  await act(async () => root.render(<AppImprovements profile="personal" slug="invoices" />));
  expect(host.textContent).toContain("Stopped at the token cap");
  expect(host.textContent).toContain("suggestions were discarded");
  await act(async () => button(host, "Run review now").click());
  expect(fetchJSON).toHaveBeenCalledWith("/api/apps/invoices/improvements/run?profile=personal", expect.objectContaining({ method: "POST" }));
  await act(async () => root.unmount());
});
