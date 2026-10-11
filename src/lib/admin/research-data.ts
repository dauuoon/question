import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { accountTypeSchema } from "@/lib/accounts/type";

export class ResearchDataError extends Error {
  constructor(public readonly code: string, public readonly status = 503) {
    super(code);
  }
}

export const sessionSchema = z.object({
  id: z.uuid(), participant_id: z.uuid(), status: z.string(), created_at: z.string(),
  updated_at: z.string(), completed_at: z.string().nullable(),
  primary_category_id: z.string().nullable(), subcategory_id: z.string().nullable(),
  other_category_text: z.string().nullable(), stage_id: z.string().nullable(),
  additional_context: z.string().nullable(), requested_question_count: z.number().int(),
});
export type ResearchSession = z.infer<typeof sessionSchema>;
export const SESSION_COLUMNS = "id,participant_id,status,created_at,updated_at,completed_at,primary_category_id,subcategory_id,other_category_text,stage_id,additional_context,requested_question_count";
export const profileSchema = z.object({ id: z.uuid(), participant_code: z.string() });
export const accountProfileSchema = z.object({
  id: z.uuid(), participant_code: z.string().nullable(),
  role: z.enum(["participant", "admin"]), account_type: accountTypeSchema.nullable(),
});

export async function readResearchRows<T>(
  client: SupabaseClient, table: string, columns: string, schema: z.ZodType<T>,
  filter?: { column: string; values: string[]; and?: { column: string; values: string[] }[] },
): Promise<T[]> {
  const rows: T[] = [];
  let textBytes = 0;
  for (let offset = 0; ; offset += 500) {
    let query = client.from(table).select(columns).order(table === "session_briefing_sources" ? "session_id" : "id")
      .range(offset, offset + 499);
    if (filter) {
      query = query.in(filter.column, filter.values);
      for (const extra of filter.and ?? []) query = query.in(extra.column, extra.values);
    }
    const result = await query;
    if (result.error) throw new ResearchDataError("RESEARCH-DB");
    const parsed = z.array(schema).safeParse(result.data);
    if (!parsed.success) throw new ResearchDataError("RESEARCH-DB-CONTRACT");
    textBytes += Buffer.byteLength(JSON.stringify(parsed.data), "utf8");
    if (textBytes > 16 * 1024 * 1024) throw new ResearchDataError("RESEARCH-DATA-LIMIT", 413);
    rows.push(...parsed.data);
    if (rows.length > 50_000) throw new ResearchDataError("RESEARCH-DATA-LIMIT", 413);
    if (parsed.data.length < 500) return rows;
  }
}

export function researchDateTime(value: string | null): string {
  if (value === null) return "";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new ResearchDataError("RESEARCH-DATE-CONTRACT");
  return new Date(time + 9 * 60 * 60 * 1000).toISOString().replace("Z", "+09:00");
}

export function adminPage(value: string | undefined): number {
  if (!value || !/^[1-9]\d{0,6}$/.test(value)) return 1;
  return Number(value);
}
