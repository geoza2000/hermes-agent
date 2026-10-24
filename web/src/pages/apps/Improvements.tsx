import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@nous-research/ui/ui/components/button";
import { fetchJSON } from "@/lib/api";

export type Schedule = "weekly" | "daily" | "after-session" | "manual";
export interface ImprovementSettings { enabled: boolean; schedule: Schedule; token_budget: number; auto_apply: boolean }
interface Suggestion {
  id: string; status: "pending" | "applying" | "applied" | "dismissed"; title: string; reason: string;
  evidence: Record<string, number>; edit: { path: string; before: string; after: string };
}
interface Run { id: string; at: number; status: string; budget: number; total_tokens: number; error?: string; suggestions?: number }
interface ReviewRequest { id: string; status: string; at: number; error?: string }
interface AppState {
  settings: ImprovementSettings; override: Partial<ImprovementSettings> | null;
  suggestions: Suggestion[]; runs: Run[]; request?: ReviewRequest | null;
}

const SCHEDULE_LABELS: Record<Schedule, string> = {
  weekly: "Weekly, Sunday 20:00",
  daily: "Daily, 20:00",
  "after-session": "After each app request",
  manual: "Only when I run it",
};
const RUN_LABELS: Record<string, string> = {
  done: "Finished", running: "Running", failed: "Failed", budget_exhausted: "Stopped at the token cap",
  no_evidence: "Skipped: no usage recorded yet",
};
const put = (body: unknown) => ({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const post = { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" };

function SettingsFields({ value, onChange, disabled }: {
  value: ImprovementSettings; onChange: (next: ImprovementSettings) => void; disabled?: boolean;
}) {
  return <div className="grid gap-3 sm:grid-cols-3">
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={value.enabled} disabled={disabled}
        onChange={e => onChange({ ...value, enabled: e.target.checked })} /> Review usage and suggest improvements
    </label>
    <label className="grid gap-1 text-sm">When
      <select aria-label="Review schedule" className="border rounded p-2 bg-background" value={value.schedule}
        disabled={disabled || !value.enabled} onChange={e => onChange({ ...value, schedule: e.target.value as Schedule })}>
        {(Object.keys(SCHEDULE_LABELS) as Schedule[]).map(key => <option key={key} value={key}>{SCHEDULE_LABELS[key]}</option>)}
      </select>
    </label>
    <label className="grid gap-1 text-sm">Token cap per run
      <input aria-label="Token cap per run" type="number" min={512} max={100000} step={500}
        className="border rounded p-2 bg-background" value={value.token_budget} disabled={disabled || !value.enabled}
        onChange={e => onChange({ ...value, token_budget: Number(e.target.value) })} />
    </label>
  </div>;
}

/** Defaults every app inherits: shown at the top of the Apps page. */
export function GlobalImprovements({ profile }: { profile: string }) {
  const query = `?profile=${encodeURIComponent(profile)}`;
  const [value, setValue] = useState<ImprovementSettings | null>(null);
  const [status, setStatus] = useState("");
  useEffect(() => {
    let live = true;
    fetchJSON<{ settings: ImprovementSettings }>(`/api/apps-improvements${query}`)
      .then(r => {
        if (!r?.settings) throw new Error("Improvement settings are unavailable on this Hermes version.");
        if (live) setValue(r.settings);
      }).catch(err => { if (live) setStatus(String(err)); });
    return () => { live = false; };
  }, [query]);
  if (!value) return status ? <p role="alert">{status}</p> : null;
  const save = async () => {
    setStatus("");
    try {
      const { enabled, schedule, token_budget } = value;
      const saved = await fetchJSON<{ settings: ImprovementSettings }>(`/api/apps-improvements${query}`, put({ enabled, schedule, token_budget }));
      setValue(saved.settings); setStatus("Saved. Every app without its own setting follows this.");
    } catch (err) { setStatus(String(err)); }
  };
  return <section aria-label="Improvement reviews" className="rounded-lg border p-4 space-y-3">
    <div><h2 className="font-semibold">Improvements</h2>
      <p className="text-sm text-muted-foreground">Hermes looks at how you use each app and suggests up to three small changes, with the evidence. Nothing changes until you approve it, and you still publish yourself.</p></div>
    <SettingsFields value={value} onChange={setValue} />
    <p className="text-xs text-muted-foreground">Automatic changes are off: every suggestion waits for your approval. What you type into apps is never sent to the review.</p>
    <Button onClick={() => void save()}>Save</Button>
    {status && <p role="status" className="text-sm">{status}</p>}
  </section>;
}

/** One app: its own schedule (or the defaults), the last runs, and suggestions to approve or dismiss. */
export function AppImprovements({ profile, slug, onDraftChanged }: { profile: string; slug: string; onDraftChanged?: () => void }) {
  const query = `?profile=${encodeURIComponent(profile)}`;
  const endpoint = `/api/apps/${encodeURIComponent(slug)}/improvements`;
  const [state, setState] = useState<AppState | null>(null);
  const [custom, setCustom] = useState<ImprovementSettings | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  const load = useCallback(async () => {
    const next = await fetchJSON<AppState>(`${endpoint}${query}`);
    if (!next?.settings || !Array.isArray(next.suggestions) || !Array.isArray(next.runs)) {
      throw new Error("Improvements are unavailable for this app.");
    }
    if (live.current) { setState(next); setCustom(next.override ? next.settings : null); }
    return next;
  }, [endpoint, query]);
  useEffect(() => { load().catch(err => { if (live.current) setNotice(String(err)); }); }, [load]);

  const pendingRequest = state?.request && ["queued", "running"].includes(state.request.status);
  useEffect(() => {
    if (!pendingRequest) return;
    const timer = window.setInterval(() => { load().catch(() => undefined); }, 3000);
    return () => window.clearInterval(timer);
  }, [pendingRequest, load]);

  async function act(run: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setNotice("");
    try { await run(); } catch (err) { if (live.current) setNotice(String(err)); } finally { if (live.current) setBusy(false); }
  }
  if (!state) return notice ? <p role="alert">{notice}</p> : null;
  const pending = state.suggestions.filter(s => s.status === "pending");
  const lastRun = state.runs.at(-1);

  return <section aria-label={`${slug} improvements`} className="rounded-lg border p-3 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-semibold">Improvements</h3>
      <Button disabled={busy || Boolean(pendingRequest)} onClick={() => act(async () => {
        await fetchJSON(`${endpoint}/run${query}`, post); await load(); setNotice("Review started. Suggestions appear here when it finishes.");
      })}>{pendingRequest ? "Reviewing…" : "Run review now"}</Button>
    </div>
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={custom !== null} disabled={busy} onChange={e => act(async () => {
        if (e.target.checked) { setCustom(state.settings); return; }
        await fetchJSON(`${endpoint}${query}`, put({ inherit: true })); await load(); setNotice("Following the defaults.");
      })} /> Use a different schedule for this app
    </label>
    {custom ? <div className="space-y-2">
      <SettingsFields value={custom} onChange={setCustom} disabled={busy} />
      <Button disabled={busy} onClick={() => act(async () => {
        const { enabled, schedule, token_budget } = custom;
        await fetchJSON(`${endpoint}${query}`, put({ enabled, schedule, token_budget })); await load(); setNotice("Saved for this app.");
      })}>Save for this app</Button>
    </div> : <p className="text-sm text-muted-foreground">
      {state.settings.enabled ? `${SCHEDULE_LABELS[state.settings.schedule]}, up to ${state.settings.token_budget.toLocaleString()} tokens per run.` : "Reviews are off."}
    </p>}
    {lastRun && <p className="text-sm" data-run-status={lastRun.status}>
      Last review: {RUN_LABELS[lastRun.status] ?? lastRun.status}, {new Date(lastRun.at * 1000).toLocaleString()}
      {lastRun.total_tokens ? ` · ${lastRun.total_tokens.toLocaleString()} of ${lastRun.budget.toLocaleString()} tokens` : ""}
      {lastRun.error ? ` · ${lastRun.error}` : ""}
    </p>}
    {pending.length === 0 ? <p className="text-sm text-muted-foreground">No suggestions waiting.</p> : pending.map(s => <article key={s.id} className="rounded border p-3 space-y-2" data-suggestion={s.id}>
      <h4 className="font-medium">{s.title}</h4>
      <p className="text-sm">{s.reason}</p>
      <ul className="text-xs text-muted-foreground list-disc pl-4">{Object.entries(s.evidence).map(([key, count]) => <li key={key}>{key.replace(/^top_interactions:|^errors:/, "")}: {count}</li>)}</ul>
      <details className="text-xs"><summary>Change in {s.edit.path}</summary>
        <pre className="whitespace-pre-wrap break-words bg-muted/40 p-2 rounded">- {s.edit.before}{"\n"}+ {s.edit.after}</pre></details>
      <div className="flex gap-2">
        <Button disabled={busy} onClick={() => act(async () => {
          const next = await fetchJSON<AppState>(`${endpoint}/${encodeURIComponent(s.id)}/approve${query}`, post);
          if (live.current) setState(prev => prev && { ...prev, ...next });
          setNotice("Applied to the draft. Preview the draft, then publish when you're happy."); onDraftChanged?.();
        })}>Approve</Button>
        <Button disabled={busy} onClick={() => act(async () => {
          const next = await fetchJSON<AppState>(`${endpoint}/${encodeURIComponent(s.id)}/dismiss${query}`, post);
          if (live.current) setState(prev => prev && { ...prev, ...next });
        })}>Dismiss</Button>
      </div>
    </article>)}
    {notice && <p role="status" className="text-sm">{notice}</p>}
  </section>;
}
