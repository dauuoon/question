import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { TEST_REF,TEST_PORT,testRuntimeEnvironment } from "../scripts/test-runtime.mjs";

const token=(ref,role)=>`header.${Buffer.from(JSON.stringify({ref,role})).toString("base64url")}.signature`;
const config={
  SUPABASE_TEST_URL:`https://${TEST_REF}.supabase.co`,
  SUPABASE_TEST_PUBLISHABLE_KEY:"sb_publishable_test-only",
  SUPABASE_TEST_SERVICE_ROLE_KEY:token(TEST_REF,"service_role"),
};

test("TEST launcher overrides Production environment, removes secrets, disables external AI and enables briefing Mock",()=>{
  const env=testRuntimeEnvironment(config,{
    PATH:"TEST path",HOME:"TEST home",OPENAI_API_KEY:"TEST forbidden key",
    OPENAI_SENTENCE_REFINEMENT_ENABLED:"true",OPENAI_SENTENCE_REFINEMENT_MODEL:"TEST forbidden model",
    OPENAI_CONTEXT_DRAFT_ENABLED:"true",OPENAI_QUESTION_GENERATION_MODEL:"TEST forbidden model",
    OPENAI_QUESTION_REGENERATION_ENABLED:"true",OPENAI_QUESTION_REGENERATION_MODEL:"TEST forbidden model",
    OPENAI_SESSION_BRIEFING_ENABLED:"true",OPENAI_SESSION_BRIEFING_MODEL:"TEST forbidden model",
    NEXT_PUBLIC_SUPABASE_URL:"https://jaqyzbrvufknpsbcuqzw.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY:"TEST production secret",SUPABASE_TEST_DATABASE_URL:"TEST database secret",
    NEXT_PUBLIC_UNRELATED:"TEST inherited",__NEXT_PRIVATE_ORIGIN:"TEST inherited",
  });
  assert.equal(env.NEXT_PUBLIC_SUPABASE_URL,config.SUPABASE_TEST_URL);
  assert.equal(env.SUPABASE_SERVICE_ROLE_KEY,config.SUPABASE_TEST_SERVICE_ROLE_KEY);
  assert.equal(env.OPENAI_API_KEY,"");
  assert.equal(env.OPENAI_SENTENCE_REFINEMENT_ENABLED,"false");
  assert.equal(env.OPENAI_CONTEXT_DRAFT_ENABLED,"false");
  assert.equal(env.OPENAI_QUESTION_GENERATION_MODEL,"");
  assert.equal(env.OPENAI_QUESTION_REGENERATION_ENABLED,"false");
  assert.equal(env.OPENAI_QUESTION_REGENERATION_MODEL,"");
  assert.equal(env.SESSION_BRIEFING_MOCK_ENABLED,"true");
  assert.equal(env.OPENAI_SESSION_BRIEFING_ENABLED,"false");
  assert.equal(env.OPENAI_SESSION_BRIEFING_MODEL,"");
  assert.equal(env.SUPABASE_TEST_DATABASE_URL,undefined);
  assert.equal(env.NEXT_PUBLIC_UNRELATED,undefined);
  assert.equal(env.__NEXT_PRIVATE_ORIGIN,undefined);
  assert.equal(env.PATH,"TEST path");
  assert.equal(TEST_PORT,3001);
});

test("TEST launcher refuses wrong project, missing keys and mismatched JWT project or role",()=>{
  for(const invalid of [
    {...config,SUPABASE_TEST_URL:"https://jaqyzbrvufknpsbcuqzw.supabase.co"},
    {...config,SUPABASE_TEST_PUBLISHABLE_KEY:""},
    {...config,SUPABASE_TEST_SERVICE_ROLE_KEY:""},
    {...config,SUPABASE_TEST_SERVICE_ROLE_KEY:token("jaqyzbrvufknpsbcuqzw","service_role")},
    {...config,SUPABASE_TEST_SERVICE_ROLE_KEY:token(TEST_REF,"anon")},
    {...config,SUPABASE_TEST_PUBLISHABLE_KEY:token("jaqyzbrvufknpsbcuqzw","anon")},
    {...config,SUPABASE_TEST_SERVICE_ROLE_KEY:"invalid-secret"},
  ])assert.throws(()=>testRuntimeEnvironment(invalid,{}));
});
