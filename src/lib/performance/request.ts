import { randomUUID } from "node:crypto";

type Category = "auth" | "db" | "storage" | "other";
type Timing = { calls: number; milliseconds: number };

export function createRequestMetrics(scope: "proxy" | "server") {
  const requestId = randomUUID();
  const totals: Record<Category, Timing> = {
    auth: { calls: 0, milliseconds: 0 }, db: { calls: 0, milliseconds: 0 },
    storage: { calls: 0, milliseconds: 0 }, other: { calls: 0, milliseconds: 0 },
  };
  return {
    requestId,
    record(category: Category, milliseconds: number, failed: boolean) {
      const total = totals[category];
      total.calls++;
      total.milliseconds += milliseconds;
      console.info("WHY BOX: request timing", {
        requestId, scope, category, milliseconds: Math.round(milliseconds * 100) / 100,
        calls: total.calls, totalMilliseconds: Math.round(total.milliseconds * 100) / 100, failed,
      });
    },
  };
}

export function instrumentSupabaseFetch(metrics: ReturnType<typeof createRequestMetrics>,
  fetcher: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const category = url.pathname.startsWith("/auth/v1/") ? "auth" :
      url.pathname.startsWith("/rest/v1/") ? "db" :
        url.pathname.startsWith("/storage/v1/") ? "storage" : "other";
    const started = performance.now();
    let failed = true;
    try {
      const response = await fetcher(input, init);
      failed = !response.ok;
      return response;
    } finally {
      metrics.record(category, performance.now() - started, failed);
    }
  };
}
