import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ResearchDataError } from "./research-data";
import { accountTypeSchema, type AccountType } from "@/lib/accounts/type";

const count = z.number().int().nonnegative();
const dashboardSchema = z.object({
  research: z.object({
    participants: count, sessions: count, completed: count, diaries: count,
    achieved: count, achievementRate: z.number().min(0).max(100),
  }),
  service: z.object({ sessions: count, p: count, t: count, unclassified: count }),
  rows: z.array(z.object({
    id: z.uuid(), participant_id: z.uuid(), participant_code: z.string().min(1),
    account_type: accountTypeSchema.nullable(), is_participant: z.literal(true),
    created_at: z.string(), updated_at: z.string(), last_activity_at: z.string(),
    status: z.string(), requested_question_count: count,
    questions: count, answered: count, skipped: count,
  })).max(20),
  page: z.number().int().positive(), pages: z.number().int().positive(),
  filter: z.enum(["P", "T", "all", "unclassified"]),
});

export async function readAdminDashboard(client: SupabaseClient, requestedPage: number,
  filter: AccountType | "all" | "unclassified" = "P") {
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0
    ? Math.min(requestedPage, 2147483647) : 1;
  const { data, error } = await client.rpc("admin_dashboard_read", { p_page: page, p_filter: filter });
  if (error) throw new ResearchDataError("RESEARCH-DB");
  const parsed = dashboardSchema.safeParse(data);
  if (!parsed.success) throw new ResearchDataError("RESEARCH-DB-CONTRACT");
  return parsed.data;
}
