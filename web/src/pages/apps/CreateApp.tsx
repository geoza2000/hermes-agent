import { useState } from "react";
import { Input } from "@nous-research/ui/ui/components/input";
import { Button } from "@nous-research/ui/ui/components/button";
import { fetchJSON } from "@/lib/api";

interface Props { profile: string; onCreated: (slug: string) => Promise<void> }
export function CreateApp({ profile, onCreated }: Props) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <form aria-label="Create app" className="rounded-lg border p-4 space-y-3" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await fetchJSON<{ app: { slug: string } }>(`/api/apps?profile=${encodeURIComponent(profile)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, slug }),
      });
      await onCreated(result.app.slug); setName(""); setSlug("");
    } catch (err) { setError(String(err)); } finally { setBusy(false); }
  }}>
    <h2 className="font-semibold">Create a private app</h2>
    <p className="text-sm text-muted-foreground">Creates a starter draft. Ask Hermes in chat to build its functionality; preview it before publishing.</p>
    <div className="flex flex-wrap gap-2">
      <label>Name<Input required maxLength={80} value={name} onChange={e => setName(e.target.value)} /></label>
      <label>App id<Input required pattern="[a-z0-9][a-z0-9-]{0,47}" maxLength={48} value={slug} onChange={e => setSlug(e.target.value)} placeholder="my-app" /></label>
      <Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create draft"}</Button>
    </div>
    {error && <p role="alert">{error}</p>}
  </form>;
}
