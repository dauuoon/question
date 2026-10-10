export const ACTIVITY_INTERVAL_MS = 5 * 60 * 1000;

export function researchScreenSession(path: string): string | null | undefined {
  if (["/", "/history", "/sessions/new"].includes(path)) return null;
  const match = /^\/sessions\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(path);
  return match?.[1];
}

export function formatResearchDate(value: string | null): string {
  return value === null ? "사용 기록 없음" :
    new Date(value).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" });
}
