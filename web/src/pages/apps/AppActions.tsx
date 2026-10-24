import { useEffect, useRef, useState } from "react";
import { Button } from "@nous-research/ui/ui/components/button";
import { fetchJSON, HERMES_BASE_PATH } from "@/lib/api";

interface Props { profile: string; slug: string; onPublished: () => Promise<void>; draftGeneration?: number }
interface Review { revision: string; path: string; expires_at: number }
interface Version { number: number; note: string; published_at: number }
interface Manifest { current_version: number | null; versions: Version[] }
interface Job { id: string; prompt?: string; status: string; question?: unknown }
const post = (body: unknown = {}) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export function AppActions(props: Props) {
  return <ScopedActions key={`${props.profile}/${props.slug}/${props.draftGeneration ?? 0}`} {...props} />;
}
function ScopedActions({ profile, slug, onPublished }: Props) {
  const query = `?profile=${encodeURIComponent(profile)}`;
  const endpoint = `/api/apps/${encodeURIComponent(slug)}`;
  const [preview, setPreview] = useState<Review | null>(null);
  const reviewed = useRef<Review | null>(null);
  const active = useRef(true);
  const locked = useRef(false);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { active.current = true; return () => { active.current = false; reviewed.current = null; }; }, []);
  const clearReview = () => { reviewed.current = null; setPreview(null); };
  async function action(run: () => Promise<void>) {
    if (locked.current || !active.current) return;
    locked.current = true; setBusy(true); setError(""); setNotice("");
    try { await run(); } catch (err) { if (active.current) { clearReview(); setError(String(err)); } }
    finally { locked.current = false; if (active.current) setBusy(false); }
  }
  async function publish() {
    const snapshot = reviewed.current;
    if (!active.current || !snapshot || snapshot !== preview || snapshot.expires_at * 1000 <= Date.now()) {
      clearReview(); setError("Preview expired. Review the draft again before publishing."); return;
    }
    if (!window.confirm("Publish this exact reviewed draft? It replaces the live app on every device. Earlier versions remain available for rollback.")) return;
    reviewed.current = null;
    await action(async () => {
      await fetchJSON(`${endpoint}/publish${query}`, post({ revision: snapshot.revision, note: "Approved from dashboard draft preview" }));
      clearReview(); setNotice("Published. Refreshing the app manifest…");
      await fetchJSON(`${endpoint}${query}`);
      await onPublished();
      if (active.current) setNotice("Published and verified.");
    });
  }
  return <div className="space-y-3">
    <div className="flex flex-wrap gap-2">
      <Button disabled={busy} onClick={() => action(async () => {
        clearReview(); const value = await fetchJSON<Review>(`${endpoint}/review${query}`, post());
        if (!value.revision || !value.path || !value.expires_at) throw new Error("No immutable review returned. Publishing is unavailable.");
        if (active.current) { reviewed.current = value; setPreview(value); }
      })}>Preview draft</Button>
      <Button disabled={busy} onClick={() => action(async () => {
        const response = await fetchJSON<{ jobs: Job[] }>(`${endpoint}/jobs${query}`); if (active.current) setJobs(response.jobs);
      })}>Recent requests</Button>
      <Button disabled={busy} onClick={() => action(async () => {
        const response = await fetchJSON<{ app: Manifest }>(`${endpoint}${query}`);
        if (active.current) { setManifest(response.app); setVersion(response.app.versions.find(v => v.number !== response.app.current_version)?.number ?? 0); }
      })}>Version history</Button>
    </div>
    {preview && <section className="space-y-2" aria-label="Draft preview">
      <div className="flex flex-wrap gap-2 items-center"><h3>Draft preview — not live</h3><a className="underline" href={`${HERMES_BASE_PATH}${preview.path}`} target="_blank" rel="noopener noreferrer">Full-screen preview</a><Button onClick={clearReview}>Close preview</Button></div>
      <p className="text-xs text-muted-foreground break-all">Reviewed revision: {preview.revision}</p>
      <iframe title={`${slug} draft`} src={`${HERMES_BASE_PATH}${preview.path}`} sandbox="allow-scripts allow-forms allow-downloads" referrerPolicy="no-referrer" className="w-full h-[60vh] border rounded-lg" />
      <Button disabled={busy} onClick={() => void publish()}>Publish reviewed draft</Button>
    </section>}
    {manifest && <section aria-label="Version history" className="space-y-2">
      <h3 className="font-semibold">Version history</h3>
      <p>Live: {manifest.current_version ? `v${manifest.current_version}` : "not published"}. Restoring changes the live app, not your draft or saved data.</p>
      {manifest.versions.some(v => v.number !== manifest.current_version) ? <>
        <label className="block">Version to restore <select className="border rounded p-2 max-w-full bg-background" value={version} onChange={e => setVersion(Number(e.target.value))}>{manifest.versions.filter(v => v.number !== manifest.current_version).map(v => <option key={v.number} value={v.number}>v{v.number} — {v.note || new Date(v.published_at * 1000).toLocaleString()}</option>)}</select></label>
        <Button disabled={busy || !version} onClick={() => action(async () => {
          const current = await fetchJSON<{ app: Manifest }>(`${endpoint}${query}`);
          if (!active.current || !current.app.versions.some(v => v.number === version) || current.app.current_version === version) throw new Error("Version history changed. Reload it before restoring.");
          if (!window.confirm(`Restore v${version} on every device? Your draft and saved data stay unchanged.`)) return;
          await fetchJSON(`${endpoint}/rollback${query}`, post({ version })); clearReview();
          const verified = await fetchJSON<{ app: Manifest }>(`${endpoint}${query}`);
          if (active.current) setManifest(verified.app);
          await onPublished();
        })}>Restore version</Button>
      </> : <p>No earlier published version.</p>}
    </section>}
    {jobs && <section aria-label="Recent app requests"><h3 className="font-semibold">Recent requests</h3>{jobs.length ? jobs.map(job => <p key={job.id} className="break-words">{job.prompt || job.id} — {job.status}{["waiting", "needs_input"].includes(job.status) ? " · Open the app to answer its pending question." : ""}</p>) : <p>No requests yet.</p>}</section>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </div>;
}
