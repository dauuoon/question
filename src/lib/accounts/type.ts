import { z } from "zod";

export const accountTypeSchema = z.enum(["P", "T"]);
export type AccountType = z.infer<typeof accountTypeSchema>;
export const accountTypeLabels = {
  P: "P · 연구 참여자",
  T: "T · 검토·테스트",
};

export function accountTypeLabel(type: AccountType | null): string {
  return type === null ? "미분류 · 연구 통계 제외" : accountTypeLabels[type];
}

export function accountTypeFilter(value: string | undefined): AccountType | "all" | "unclassified" {
  return value === "T" || value === "all" || value === "unclassified" ? value : "P";
}
