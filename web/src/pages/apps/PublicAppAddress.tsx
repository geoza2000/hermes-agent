import { useEffect, useState } from "react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Input } from "@nous-research/ui/ui/components/input";
import { fetchJSON } from "@/lib/api";
import { validatePublicBase } from "@/lib/apps-links";

interface AppsConfig { apps?: { public_base_url?: string } }
interface Props { onChange: (base: string) => void; profile: string }
export function PublicAppAddress({ onChange, profile }: Props) {
  const endpoint = `/api/config?profile=${encodeURIComponent(profile)}`;
  const [address, setAddress] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let active = true;
    fetchJSON<AppsConfig>(endpoint).then(config => {
      if (active) { const value = config.apps?.public_base_url || ""; setAddress(value); onChange(value); }
    }).catch(err => { if (active) setStatus(String(err)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [onChange, endpoint]);
  async function save() {
    setBusy(true); setStatus("");
    try {
      const value = validatePublicBase(address);
      await fetchJSON(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config: { apps: { public_base_url: value } } }) });
      const saved = await fetchJSON<AppsConfig>(endpoint);
      if ((saved.apps?.public_base_url || "") !== value) throw new Error("The saved address could not be verified. Reload and try again.");
      setAddress(value); onChange(value); setStatus("Address saved.");
    } catch (err) { setStatus(String(err)); } finally { setBusy(false); }
  }
  return <section className="rounded-lg border p-4 space-y-3" aria-label="Phone links">
    <label htmlFor="apps-public-base" className="font-semibold">Public Hermes address</label>
    <p className="text-sm text-muted-foreground">Your existing HTTPS dashboard address, including any proxy prefix. This does not create a tunnel or make apps public. Phone links require the same sign-in as your dashboard.</p>
    <div className="flex flex-wrap gap-2"><Input id="apps-public-base" type="url" placeholder="https://hermes.example" value={address} onChange={e => setAddress(e.target.value)} disabled={busy} /><Button disabled={busy} onClick={save}>Save address</Button></div>
    {status && <p role="status">{status}</p>}
  </section>;
}
