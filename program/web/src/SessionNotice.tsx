import { RefreshCw } from "lucide-react";
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
