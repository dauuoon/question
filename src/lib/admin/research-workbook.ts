import "server-only";
import ExcelJS from "exceljs";
import { createWriteStream } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  accountProfileSchema, readResearchRows, researchDateTime, ResearchDataError,
  sessionSchema, SESSION_COLUMNS,
} from "./research-data";

export const EXPORT_MAX_ROWS = 20_000;
export const EXPORT_MAX_TEXT_BYTES = 16 * 1024 * 1024;
export const EXPORT_MAX_FILE_BYTES = 4 * 1024 * 1024;
export type ResearchExport = { kind: "sessions" | "session" | "diaries" | "participant"; id?: string };
const text = z.string().nullable();
const questionSchema = z.object({
  id: z.uuid(), session_id: z.uuid(), slot_index: z.number(), question_text: z.string(),
  status: z.string(), question_kind: z.string(), content_principle: text, detail_type: text,
  root_question_id: z.uuid(), parent_question_id: z.uuid().nullable(),
  regeneration_index: z.number().nullable(), followup_index: z.number().nullable(),
  is_active_version: z.boolean(), skip_reason: text, generated_at: z.string(),
});
const answerSchema = z.object({
  id: z.uuid(), question_id: z.uuid(), original_answer: z.string(), refined_answer: text,
  current_answer_version: z.enum(["original", "refined"]), updated_at: z.string(),
});
const sourceSchema = z.object({
  session_id: z.uuid(), source_text: z.string(), model_id: z.string(),
  prompt_version: z.string(), schema_version: z.string(), generated_at: z.string(),
});
const versionSchema = z.object({
  id: z.uuid(), session_id: z.uuid(), revision: z.number(), briefing_text: z.string(), edited_at: z.string(),
});
const diarySchema = z.object({
  id: z.uuid(), session_id: z.uuid(), participant_id: z.uuid(), status: z.string(),
  experience_choices_json: z.array(z.string()), feeling_choices_json: z.array(z.string()),
  free_text: text, submitted_at: text,
});
const contextSchema = z.object({ id: z.uuid(), session_id: z.uuid(), context_id: z.string() });
const eventSchema = z.object({
  id: z.uuid(), session_id: z.uuid(), question_id: z.uuid().nullable(), event_type: z.string(), created_at: z.string(),
});

export function excelText(value: unknown): string | number | boolean {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return value;
  const result = typeof value === "string" ? value : JSON.stringify(value);
  if (result.length > 32_767) throw new ResearchDataError("EXPORT-CELL-LIMIT", 413);
  // ExcelJS writes primitive strings as text cells, never as formula objects.
  return result;
}

export async function writeResearchWorkbook(client: SupabaseClient, selection: ResearchExport, filename: string) {
  const queriedProfiles = await readResearchRows(client, "profiles", "id,participant_code,role,account_type", accountProfileSchema,
    { column: "role", values: ["participant"], and: [{ column: "account_type", values: ["P"] }] });
  const profiles = queriedProfiles.filter(p => p.role === "participant" && p.account_type === "P");
  if (selection.kind === "participant" && !profiles.some(p => p.id === selection.id)) {
    throw new ResearchDataError("EXPORT-RESEARCH-ONLY", 403);
  }
  let eligible = selection.kind === "participant" ? profiles.filter(p => p.id === selection.id) : profiles;
  // A direct session identifier never bypasses explicit P classification.
  if (selection.kind === "session") {
    const selected = await readResearchRows(client, "sessions", SESSION_COLUMNS, sessionSchema,
      { column: "id", values: [selection.id!] });
    if (selected.length !== 1) throw new ResearchDataError("EXPORT-NOT-FOUND", 404);
    eligible = profiles.filter(p => p.id === selected[0].participant_id);
    if (!eligible.length) throw new ResearchDataError("EXPORT-RESEARCH-ONLY", 403);
  }
  const participantIds = eligible.map(p => p.id);
  const sessions: z.infer<typeof sessionSchema>[] = [];
  const allDiaries: z.infer<typeof diarySchema>[] = [];
  let selectedBytes = 0;
  for (let start = 0; start < participantIds.length; start += 100) {
    const ids = participantIds.slice(start, start + 100);
    const filter = { column: "participant_id", values: ids,
      and: selection.kind === "session" ? [{ column: "id", values: [selection.id!] }] : [] };
    const table = selection.kind === "diaries" ? "diaries" : "sessions";
    let query = client.from(table).select("id", { count: "exact", head: true }).in("participant_id", ids);
    if (selection.kind === "session") query = query.eq("id", selection.id!);
    const count = await query;
    if (count.error || count.count === null) throw new ResearchDataError("EXPORT-DB");
    if (count.count + sessions.length + allDiaries.length > (table === "diaries" ? EXPORT_MAX_ROWS : 2_000)) {
      throw new ResearchDataError("EXPORT-SESSION-LIMIT", 413);
    }
    if (table === "diaries") {
      const selected = await readResearchRows(client, table,
        "id,session_id,participant_id,status,experience_choices_json,feeling_choices_json,free_text,submitted_at",
        diarySchema, filter);
      selectedBytes += Buffer.byteLength(JSON.stringify(selected), "utf8");
      allDiaries.push(...selected);
    } else {
      const selected = await readResearchRows(client, table, SESSION_COLUMNS, sessionSchema, filter);
      selectedBytes += Buffer.byteLength(JSON.stringify(selected), "utf8");
      sessions.push(...selected);
    }
    if (selectedBytes > EXPORT_MAX_TEXT_BYTES) throw new ResearchDataError("EXPORT-TEXT-LIMIT", 413);
    if (sessions.length > 2_000 || allDiaries.length > EXPORT_MAX_ROWS) {
      throw new ResearchDataError("EXPORT-SESSION-LIMIT", 413);
    }
  }
  const codes = new Map(eligible.map(p => [p.id, p.participant_code]));
  const participantCode = (id: string) => {
    const code = codes.get(id);
    if (!code) throw new ResearchDataError("EXPORT-PARTICIPANT-CONTRACT");
    return code;
  };
  const output = createWriteStream(filename, { mode: 0o600 });
  let outputError: Error | undefined;
  output.on("error", (error: Error) => { outputError = error; });
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: output, useStyles: true, useSharedStrings: false });
  workbook.creator = "WHY BOX";
  let rowCount = 0, textBytes = 0;
  const sheet = (name: string, headers: string[]) => {
    const s = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
    s.columns = headers.map(header => ({ header, width: header.includes("text") || header.includes("answer") ? 55 : 26 }));
    s.getRow(1).font = { bold: true };
    s.autoFilter = { from: "A1", to: { row: 1, column: headers.length } };
    return s;
  };
  const add = (s: ExcelJS.Worksheet, values: unknown[]) => {
    if (outputError) throw new ResearchDataError("EXPORT-FILE-WRITE");
    const cells = values.map(excelText);
    if (++rowCount > EXPORT_MAX_ROWS) throw new ResearchDataError("EXPORT-ROW-LIMIT", 413);
    textBytes += Buffer.byteLength(JSON.stringify(cells), "utf8");
    if (textBytes > EXPORT_MAX_TEXT_BYTES) throw new ResearchDataError("EXPORT-TEXT-LIMIT", 413);
    const row = s.addRow(cells);
    row.alignment = { vertical: "top", wrapText: true };
    row.commit();
  };
  const diarySheet = sheet("Diaries", ["session_id", "participant_code", "diary_id", "status",
    "Q1_choices_JSON", "Q2_choices_JSON", "Q3_free_text", "submitted_at_Asia_Seoul"]);
  const addDiary = (d: z.infer<typeof diarySchema>) => add(diarySheet, [
    d.session_id, participantCode(d.participant_id), d.id, d.status, d.experience_choices_json,
    d.feeling_choices_json, d.free_text, researchDateTime(d.submitted_at),
  ]);
  try {
    if (selection.kind === "diaries") {
      for (const diary of allDiaries) addDiary(diary);
    } else {
      if (selection.kind === "session" && sessions.length !== 1) throw new ResearchDataError("EXPORT-NOT-FOUND", 404);
      const sessionsSheet = sheet("Sessions", ["session_id", "participant_code", "created_at_Asia_Seoul",
        "completed_at_Asia_Seoul", "status", "primary_category_id", "subcategory_id", "other_category_text",
        "stage_id", "confirmed_context", "context_ids_JSON", "requested_question_count"]);
      const questionsSheet = sheet("Questions", ["session_id", "participant_code", "question_id", "slot",
        "question_text", "status", "question_kind", "content_principle", "detail_type", "root_question_id",
        "parent_question_id", "regeneration_index", "followup_index", "is_active_version", "skip_reason",
        "generated_at_Asia_Seoul"]);
      const answersSheet = sheet("Answers", ["session_id", "participant_code", "question_id", "answer_id",
        "original_answer", "refined_answer", "current_answer_version", "final_selected_answer", "saved_at_Asia_Seoul"]);
      const briefingsSheet = sheet("Briefings", ["session_id", "participant_code", "record_kind", "revision",
        "briefing_text", "model_id", "prompt_version", "schema_version", "saved_at_Asia_Seoul"]);
      const eventsSheet = sheet("QuestionEvents", ["session_id", "participant_code", "question_id", "event_type", "created_at_Asia_Seoul"]);
      for (let start = 0; start < sessions.length; start += 100) {
        const batch = sessions.slice(start, start + 100);
        const ids = batch.map(s => s.id), byId = new Map(batch.map(s => [s.id, s]));
        const scoped = { column: "session_id", values: ids };
        const [contexts, questions, sources, versions, diaries, events] = await Promise.all([
          readResearchRows(client, "session_contexts", "id,session_id,context_id", contextSchema, scoped),
          readResearchRows(client, "questions", "id,session_id,slot_index,question_text,status,question_kind,content_principle,detail_type,root_question_id,parent_question_id,regeneration_index,followup_index,is_active_version,skip_reason,generated_at", questionSchema, scoped),
          readResearchRows(client, "session_briefing_sources", "session_id,source_text,model_id,prompt_version,schema_version,generated_at", sourceSchema, scoped),
          readResearchRows(client, "session_briefing_versions", "id,session_id,revision,briefing_text,edited_at", versionSchema, scoped),
          readResearchRows(client, "diaries", "id,session_id,participant_id,status,experience_choices_json,feeling_choices_json,free_text,submitted_at", diarySchema, scoped),
          readResearchRows(client, "question_events", "id,session_id,question_id,event_type,created_at", eventSchema, scoped),
        ]);
        const code = (id: string) => {
          const session = byId.get(id);
          if (!session) throw new ResearchDataError("EXPORT-SESSION-CONTRACT");
          return participantCode(session.participant_id);
        };
        for (const s of batch) add(sessionsSheet, [
          s.id, participantCode(s.participant_id), researchDateTime(s.created_at), researchDateTime(s.completed_at),
          s.status, s.primary_category_id, s.subcategory_id, s.other_category_text, s.stage_id,
          s.additional_context, contexts.filter(c => c.session_id === s.id).map(c => c.context_id),
          s.requested_question_count,
        ]);
        for (const q of questions) add(questionsSheet, [
          q.session_id, code(q.session_id), q.id, q.slot_index, q.question_text, q.status, q.question_kind,
          q.content_principle, q.detail_type, q.root_question_id, q.parent_question_id,
          q.regeneration_index, q.followup_index, q.is_active_version, q.skip_reason, researchDateTime(q.generated_at),
        ]);
        const questionMap = new Map(questions.map(q => [q.id, q]));
        // Chunk IDs so PostgREST URL size remains bounded even with regeneration history.
        const questionIds = questions.map(q => q.id);
        for (let qStart = 0; qStart < questionIds.length; qStart += 100) {
          const answers = await readResearchRows(client, "answers",
            "id,question_id,original_answer,refined_answer,current_answer_version,updated_at", answerSchema,
            { column: "question_id", values: questionIds.slice(qStart, qStart + 100) });
          for (const a of answers) {
            const q = questionMap.get(a.question_id)!;
            add(answersSheet, [q.session_id, code(q.session_id), a.question_id, a.id,
              a.original_answer, a.refined_answer, a.current_answer_version,
              a.current_answer_version === "refined" ? a.refined_answer : a.original_answer,
              researchDateTime(a.updated_at)]);
          }
        }
        for (const s of sources) add(briefingsSheet, [s.session_id, code(s.session_id), "AI_original", 0,
          s.source_text, s.model_id, s.prompt_version, s.schema_version, researchDateTime(s.generated_at)]);
        for (const v of versions) add(briefingsSheet, [v.session_id, code(v.session_id), "participant_revision", v.revision,
          v.briefing_text, "", "", "", researchDateTime(v.edited_at)]);
        for (const diary of diaries) addDiary(diary);
        for (const event of events) add(eventsSheet, [event.session_id, code(event.session_id),
          event.question_id, event.event_type, researchDateTime(event.created_at)]);
      }
    }
    if (outputError) throw new ResearchDataError("EXPORT-FILE-WRITE");
    // Fail closed if classification changed while generating the extract.
    for (let start = 0; start < participantIds.length; start += 100) {
      const ids = participantIds.slice(start, start + 100);
      const current = await readResearchRows(client, "profiles", "id,participant_code,role,account_type", accountProfileSchema,
        { column: "id", values: ids });
      if (current.length !== ids.length || current.some(p => p.role !== "participant" || p.account_type !== "P")) {
        throw new ResearchDataError("EXPORT-RESEARCH-ONLY", 403);
      }
    }
    await workbook.commit();
    return { rowCount, textBytes };
  } catch (error) {
    output.destroy();
    throw error;
  }
}
