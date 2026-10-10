"use client";

import { useEffect, useState } from "react";
import { ACTIVITY_INTERVAL_MS } from "@/lib/activity/screen";
import { errorCatalog } from "@/lib/errors/catalog";
import { Toast } from "@/app/toast";

let lastPath: string | undefined;
let lastParticipantId: string | undefined;
let lastSentAt = 0;
let inFlight = false;

export function ActivityMarker({ path, participantId }: { path: string; participantId: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    // Only a successfully rendered, visible page sends a navigation event; no polling/prefetch/RSC writes.
    if (lastParticipantId !== participantId) {
      lastParticipantId = participantId;
      lastPath = undefined;
      lastSentAt = 0;
    }
    if (lastPath === path) return;
    const isReload = performance.getEntriesByType("navigation")
      .some((entry) => entry instanceof PerformanceNavigationTiming && entry.type === "reload");
    if (lastPath === undefined && isReload) { lastPath = path; return; }
    function record() {
      if (document.visibilityState !== "visible" || lastPath === path) return;
      lastPath = path;
      if (inFlight || Date.now() - lastSentAt < ACTIVITY_INTERVAL_MS) return;
      inFlight = true;
      lastSentAt = Date.now();
      void fetch("/api/participant-activity", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      }).then((response) => {
        if (!response.ok) { lastSentAt = 0; setFailed(true); }
      }).catch(() => { lastSentAt = 0; setFailed(true); })
        .finally(() => { inFlight = false; });
    }
    record();
    document.addEventListener("visibilitychange", record);
    return () => document.removeEventListener("visibilitychange", record);
  }, [path, participantId]);
  return failed ? <Toast error message={`${errorCatalog["SAVE-002"].participantMessage} (SAVE-002)`} /> : null;
}
