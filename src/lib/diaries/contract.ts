import { z } from "zod";

export const diaryExperienceChoices = [
  "생각이 더 구체적으로 정리되었다",
  "미처 생각하지 못한 부분을 발견했다",
  "다른 관점이나 가능성을 생각해보았다",
  "내 판단의 이유나 근거를 다시 생각해보았다",
  "현재 디자인을 다시 점검해보게 되었다",
  "다음에 무엇을 할지 생각해보게 되었다",
  "특별한 변화는 없었다",
] as const;

export const diaryFeelingChoices = [
  "흥미로웠어요",
  "새로웠어요",
  "도움이 되었어요",
  "생각하기 어려웠어요",
  "부담스러웠어요",
  "답답했어요",
  "특별한 느낌이 없었어요",
] as const;

export const diarySubmissionSchema = z.object({
  experience_choices: z.array(z.enum(diaryExperienceChoices)).min(1).max(diaryExperienceChoices.length),
  feeling_choices: z.array(z.enum(diaryFeelingChoices)).min(1).max(diaryFeelingChoices.length),
  free_text: z.string().max(20_000).nullable(),
}).strict().superRefine((value, context) => {
  if (new Set(value.experience_choices).size !== value.experience_choices.length) {
    context.addIssue({ code: "custom", path: ["experience_choices"], message: "Duplicate choices are not allowed." });
  }
  if (new Set(value.feeling_choices).size !== value.feeling_choices.length) {
    context.addIssue({ code: "custom", path: ["feeling_choices"], message: "Duplicate choices are not allowed." });
  }
  if (value.experience_choices.includes("특별한 변화는 없었다") && value.experience_choices.length !== 1) {
    context.addIssue({ code: "custom", path: ["experience_choices"], message: "The no-change choice is exclusive." });
  }
  if (value.feeling_choices.includes("특별한 느낌이 없었어요") && value.feeling_choices.length !== 1) {
    context.addIssue({ code: "custom", path: ["feeling_choices"], message: "The no-feeling choice is exclusive." });
  }
});

export const diaryDraftSchema = z.object({
  experience_choices: z.array(z.enum(diaryExperienceChoices)).max(diaryExperienceChoices.length).default([]),
  feeling_choices: z.array(z.enum(diaryFeelingChoices)).max(diaryFeelingChoices.length).default([]),
  free_text: z.string().max(20_000).default(""),
}).strict().superRefine((value, context) => {
  if (new Set(value.experience_choices).size !== value.experience_choices.length) {
    context.addIssue({ code: "custom", path: ["experience_choices"], message: "Duplicate choices are not allowed." });
  }
  if (new Set(value.feeling_choices).size !== value.feeling_choices.length) {
    context.addIssue({ code: "custom", path: ["feeling_choices"], message: "Duplicate choices are not allowed." });
  }
  if (value.experience_choices.includes("특별한 변화는 없었다") && value.experience_choices.length !== 1) {
    context.addIssue({ code: "custom", path: ["experience_choices"], message: "The no-change choice is exclusive." });
  }
  if (value.feeling_choices.includes("특별한 느낌이 없었어요") && value.feeling_choices.length !== 1) {
    context.addIssue({ code: "custom", path: ["feeling_choices"], message: "The no-feeling choice is exclusive." });
  }
});
