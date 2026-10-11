export function questionSessionStatus(status: string): string {
  return status === "draft" || status === "question_generation" ? "in_progress" : status;
}

export function canShowBriefing(status: string): boolean {
  return status === "completed";
}
