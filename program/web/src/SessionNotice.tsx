import { useEffect, useState } from "react";
import { LogOut, RefreshCw } from "lucide-react";
import { Button, Feedback } from "@tealbrick/ui";

/** Shown when the instance edge reports that the Portal browser session ended mid-use. */
export function SessionEndedBanner({ onReload }: { onReload: () => void }) {
  return (
    <div className="notice session-ended-banner" role="alert">
      <div>
        <strong>Your session ended</strong>
        <p>
          Reopen Knowledge from Teal Brick Portal to continue. Changes that were
          not saved before the session ended may need to be entered again.
        </p>
      </div>
      <Button size="small" onClick={onReload}>
        <RefreshCw size={14} />
        Reload
      </Button>
    </div>
  );
}

/** Full-page state when the app cannot load because no Portal session is active. */
export function SessionEndedSplash({ onReload }: { onReload: () => void }) {
  return (
    <div className="splash">
      <Feedback
        state="forbidden"
        title="Your session ended"
        action={<Button onClick={onReload}>Reload</Button>}
      >
        Reopen Knowledge from Teal Brick Portal to continue. Your documents and
        settings are unchanged.
      </Feedback>
    </div>
  );
}

/**
 * Shown for the whole time a break-glass (emergency code) session is active. The edge audits the sign-in and ends the
 * session by itself after a short time; this banner tells the person that Portal is not part of this session.
 */
export function EmergencyAccessBanner({ banner, onSignOut }: { banner: string; onSignOut: () => void }) {
  return (
    <div className="notice emergency-banner" role="status">
      <div>
        <strong>Emergency access</strong>
        <p>{banner}</p>
      </div>
      <Button size="small" onClick={onSignOut}>
        <LogOut size={14} />
        Sign out
      </Button>
    </div>
  );
}

/** Reads the emergency session state from the edge; renders nothing for a normal Portal session. */
export function EmergencyAccess() {
  const [banner, setBanner] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/auth/emergency/session", { credentials: "same-origin", headers: { accept: "application/json" } })
      .then((response) => (response.ok ? response.json() : null))
      .then((state: { active?: unknown; banner?: unknown } | null) => {
        if (!cancelled && state?.active === true && typeof state.banner === "string") setBanner(state.banner);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  if (!banner) return null;
  const signOut = () => {
    fetch("/auth/emergency/logout", { method: "POST", credentials: "same-origin" })
      .catch(() => undefined)
      .finally(() => window.location.assign("/"));
  };
  return <EmergencyAccessBanner banner={banner} onSignOut={signOut} />;
}
