import { useState } from "react";
import { Button } from "@nous-research/ui/ui/components/button";
import { fetchJSON, HERMES_BASE_PATH } from "@/lib/api";

interface Props { profile: string; slug: string; onPublished: () => Promise<void> }
interface Job { id: string; prompt?: string; status: string; question?: unknown }
export function AppActions({ profile, slug, onPublished }: Props) {
  const query = `?profile=${encodeURIComponent(profile)}`;
  const endpoint = `/api/apps/${encodeURIComponent(slug)}`;
  const [preview, setPreview] = useState("");
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function action(run: () => Promise<void>) {
    setBusy(true); setError("");
    try { await run(); } catch (err) { setError(String(err)); } finally { setBusy(false); }
  }
  return <div className="space-y-3">
    <div className="flex flex-wrap gap-2">
      <Button disabled={busy} onClick={() => action(async () => {
        const link = await fetchJSON<{ path: string }>(`${endpoint}/link${query}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preview: true }) });
        setPreview(`${HERMES_BASE_PATH}${link.path}`);
      })}>Preview draft</Button>
      <Button disabled={busy} onClick={() => action(async () => {
        const response = await fetchJSON<{ jobs: Job[] }>(`${endpoint}/jobs${query}`); setJobs(response.jobs);
      })}>Recent requests</Button>
    </div>
    {preview && <section className="space-y-2" aria-label="Draft preview">
      <div className="flex flex-wrap gap-2 items-center"><h3>Draft preview — not live</h3><a className="underline" href={preview} target="_blank" rel="noopener noreferrer">Full-screen preview</a><Button onClick={() => setPreview("")}>Close preview</Button></div>
      <iframe title={`${slug} draft`} src={preview} sandbox="allow-scripts allow-forms allow-popups allow-downloads allow-modals" referrerPolicy="no-referrer" className="w-full h-[60vh] border rounded-lg" />
      <Button disabled={busy} onClick={() => {
        if (!window.confirm("Publish the current draft? This replaces the live app for every device. Earlier versions remain available for rollback.")) return;
        void action(async () => {
          await fetchJSON(`${endpoint}/publish${query}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note: "Approved from dashboard draft preview" }) });
          await onPublished(); setPreview("");
        });
      }}>Approve and publish draft</Button>
    </section>}
    {jobs && <section aria-label="Recent app requests"><h3 className="font-semibold">Recent requests</h3>{jobs.length ? jobs.map(job => <p key={job.id} className="break-words">{job.prompt || job.id} — {job.status}{["waiting", "needs_input"].includes(job.status) ? " · Open the app to answer its pending question." : ""}</p>) : <p>No requests yet.</p>}</section>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
