import { QUESTION_GENERATION_SCHEMA } from "./question-generation-v2.0";

const {candidate_rank:rank,...properties}=QUESTION_GENERATION_SCHEMA.schema.properties.questions.items.properties;
void rank;
export const QUESTION_REGENERATION_SCHEMA={
  name:"why_box_question_regeneration_v1_0",
  strict:true,
  schema:{
    type:"object",
    properties:{question:{
      type:"object",properties,
      required:Object.keys(properties),additionalProperties:false,
    }},
    required:["question"],additionalProperties:false,
  },
} as const;
