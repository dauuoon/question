import { createHash } from "node:crypto";
import type { BriefingInput } from "./briefing-contract";

type SnapshotAnswer = BriefingInput["answered_questions"][number]["answer"];

export type RefinementTarget = {
  questionId: string;
  sourceText: string;
  sourceHash: string;
  kind: "text" | "choice_other";
};

export function refinementTargets(input: BriefingInput, formKinds: Readonly<Record<string, "text" | "choice">>): RefinementTarget[] {
  const targets: RefinementTarget[] = [];
  function append(questionId: string, answer: SnapshotAnswer) {
    if (answer.current_version !== "original" || !answer.original.trim()) return;

    const formKind = formKinds[questionId];
    if (!formKind) return;
    const choice = answer.choice_selection;
    if ((formKind === "choice") !== !!choice) return;
    if (choice && (choice.selected_options.length > 0 || choice.explanation.trim() ||
      !choice.other.trim() || choice.other !== answer.original)) return;

    targets.push({
      questionId,
      sourceText: answer.original,
      sourceHash: createHash("sha256").update(answer.original, "utf8").digest("hex"),
      kind: choice ? "choice_other" : "text",
    });
  }
  for (const question of input.answered_questions) {
    append(question.question_id, question.answer);
    if (question.followup) append(question.followup.question_id, question.followup.answer);
  }
  return targets;
}
