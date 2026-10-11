import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ResearchDataError } from "./research-data";
import { accountTypeSchema, type AccountType } from "@/lib/accounts/type";

const participantsSchema = z.object({
  rows: z.array(z.object({
    id: z.uuid(), participant_code: z.string().min(1), account_type: accountTypeSchema.nullable(),
    status: z.enum(["active", "deactivated"]), created_at: z.string(),
    last_activity_at: z.string().nullable(),
    completed: z.number().int().nonnegative(), diaries: z.number().int().nonnegative(),
  })).max(20),
  page: z.number().int().positive(), pages: z.number().int().positive(),
  filter: z.enum(["P", "T", "all", "unclassified"]),
});

export async function readAdminParticipants(client: SupabaseClient, requestedPage: number,
  filter: AccountType | "all" | "unclassified" = "all") {
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0
    ? Math.min(requestedPage, 2147483647) : 1;
  const { data, error } = await client.rpc("admin_participants_read", { p_page: page, p_filter: filter });
  if (error) throw new ResearchDataError("RESEARCH-DB");
  const parsed = participantsSchema.safeParse(data);
  if (!parsed.success) throw new ResearchDataError("RESEARCH-DB-CONTRACT");
  return parsed.data;
}
