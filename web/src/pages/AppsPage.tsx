import { useEffect, useState } from "react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent } from "@nous-research/ui/ui/components/card";
import { AppActions } from "./apps/AppActions";
import { CreateApp } from "./apps/CreateApp";
import { PublicAppAddress } from "./apps/PublicAppAddress";
import { phoneLink } from "@/lib/apps-links";
import { fetchJSON, HERMES_BASE_PATH } from "@/lib/api";
import { useProfileScope } from "@/contexts/useProfileScope";

interface AppSummary {
  slug: string;
  name: string;
  icon: string;
  description?: string;
  current_version: number | null;
  entry_path: string;
}
interface AppList { profile: string; apps: AppSummary[] }

function InstallHelp() {
  const agent = navigator.userAgent;
  const mobileApple = /iPad|iPhone|iPod/.test(agent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const instruction = mobileApple
    ? "In Safari, tap Share, then Add to Home Screen."
    : /Android/.test(agent)
      ? "In Chrome, open the menu and choose Install app or Add to Home Screen."
      : /Safari/.test(agent) && !/Chrome|Chromium/.test(agent)
        ? "In Safari on Mac, choose File → Add to Dock."
        : "In Chrome or Edge, use the install icon in the address bar, or the browser menu's Install page as app option.";
  return <aside className="rounded-lg border p-4 space-y-2" aria-label="Install instructions">
    <p>{instruction}</p>
    <p>Open the app first, then install it from its signed-in page. On iPhone or iPad, use Share → Add to Home Screen.</p>
    <p className="text-sm text-muted-foreground">Private apps still require Hermes authentication. You may need to sign in again when your session expires. Installation does not extend a temporary app link or provide offline access.</p>
  </aside>;
}

export default function AppsPage() {
  const { profile } = useProfileScope();
  return <ProfileApps key={profile} />;
}

function ProfileApps() {
  const { profile } = useProfileScope();
  const [publicBase, setPublicBase] = useState("");
  const [notice, setNotice] = useState("");
  const [listing, setListing] = useState<AppList | null>(null);
  const [error, setError] = useState("");
  const [help, setHelp] = useState<string | null>(null);
  const [installSuggestion, setInstallSuggestion] = useState(false);
  useEffect(() => {
    let active = true;
    fetchJSON<AppList>("/api/apps").then(value => { if (active) { setListing(value); setError(""); } })
      .catch(err => { if (active) setError(String(err)); });
    return () => { active = false; };
  }, [profile]);
  return <section className="p-4 md:p-6 space-y-4 max-w-5xl mx-auto" aria-label="Hermes Apps">
    <header><h1 className="text-2xl font-semibold">Apps</h1><p className="text-muted-foreground">Your personal apps, powered by your existing Hermes sessions and connections.</p></header>
    {listing && <PublicAppAddress key={listing.profile} profile={listing.profile} onChange={setPublicBase} />}
    {listing && <CreateApp profile={listing.profile} onCreated={async () => {
      const refreshed = await fetchJSON<AppList>(`/api/apps?profile=${encodeURIComponent(listing.profile)}`);
      setListing(refreshed); setNotice("Draft created. Build and publish it before installing.");
      setInstallSuggestion(!window.matchMedia?.("(display-mode: standalone)").matches);
    }} />}
    {installSuggestion && <aside className="rounded-lg border p-4 space-y-2" aria-label="Install suggestion">
      <p>When your app is ready, you can keep it on this device's home screen or dock.</p>
      <InstallHelp /><Button onClick={() => setInstallSuggestion(false)}>Maybe later</Button>
    </aside>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    {!listing && !error && <p role="status">Loading apps…</p>}
    {listing?.apps.length === 0 && <Card><CardContent className="p-5">No apps yet. Ask Hermes to build an app in chat, or use <code>hermes apps create</code>.</CardContent></Card>}
    {listing?.apps.map(app => <Card key={`${listing.profile}/${app.slug}`}><CardContent className="p-5 space-y-3">
      <h2 className="text-lg font-semibold">{app.icon} {app.name}</h2>
      <p>{app.description}</p>
      <p className="text-sm text-muted-foreground">{app.current_version ? `Published version ${app.current_version}` : "Draft — not published"}</p>
      <div className="flex flex-wrap gap-3 items-center">
        <a data-app-open href={`${HERMES_BASE_PATH}${app.entry_path}`} target="_blank" rel="noopener noreferrer" className="underline">Open app</a>
        <Button disabled={!publicBase} onClick={async () => {
          try { await navigator.clipboard.writeText(phoneLink(publicBase, app.entry_path)); setNotice("Signed-in phone link copied."); }
          catch (err) { setNotice(String(err)); }
        }}>Copy phone link</Button>
        <Button onClick={() => setHelp(help === app.slug ? null : app.slug)}>Install on this device</Button>
      </div>
      <AppActions profile={listing.profile} slug={app.slug} onPublished={async () => {
        setListing(await fetchJSON<AppList>(`/api/apps?profile=${encodeURIComponent(listing.profile)}`));
      }} />
      {help === app.slug && <InstallHelp />}
    </CardContent></Card>)}
  </section>;
}
