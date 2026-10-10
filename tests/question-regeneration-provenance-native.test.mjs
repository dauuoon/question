import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {URL} from "node:url";
import {createServer} from "node:net";
import {randomUUID} from "node:crypto";
import process from "node:process";
import {initialize,populate,owner} from "./question-regeneration-fixture.mjs";

test("native PostgreSQL dispatch provenance is atomic, private, immutable and retained on unknown failure",async()=>{
  const directory=mkdtempSync("/tmp/why-box-rg-meta-");
  const bin="/opt/homebrew/opt/postgresql@17/bin";
  const env={...process.env,LC_ALL:"C",LANG:"C"};
  const probe=createServer();
  await new Promise(resolve=>probe.listen(0,"127.0.0.1",resolve));
  const port=probe.address().port;
  await new Promise(resolve=>probe.close(resolve));
  let started=false;
  const execute=sql=>execFileSync(join(bin,"psql"),["-X","-v","ON_ERROR_STOP=1","-h","127.0.0.1",
    "-p",String(port),"-U","postgres","-d","postgres","-At","-c",sql],{env,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  try {
    execFileSync(join(bin,"initdb"),["-D",directory,"-U","postgres","-A","trust","--no-locale","--encoding=UTF8"],{env,stdio:"pipe"});
    execFileSync(join(bin,"pg_ctl"),["-D",directory,"-l",join(directory,"server.log"),
      "-o",`-h 127.0.0.1 -p ${port} -k ${directory} -c shared_memory_type=mmap -c dynamic_shared_memory_type=mmap`,"-w","start"],{env,stdio:"pipe"});
    started=true;
    await initialize(execute);
    await populate(execute,sql=>JSON.parse(execute(sql).split("\n").at(-1)));
    execute(readFileSync(new URL("../supabase/migrations/20261010002000_regeneration_dispatch_provenance.sql",import.meta.url),"utf8"));
    const question=JSON.parse(execute("select json_build_object('id',id,'session_id',session_id) from questions where is_active_version order by slot_index limit 1"));
    const request=randomUUID();
    const auth=`set request.jwt.claim.role='service_role';`;
    const begin=JSON.parse(execute(`${auth} select begin_question_regeneration('${question.session_id}','${question.id}','${request}','${owner}',null,true);`).split("\n").at(-1));
    const args=`'${begin.attempt_id}','${request}','${owner}','mock-native','question-regeneration-v1.0','why_box_question_regeneration_v1_0'`;
    assert.equal(execute(`${auth} select authorize_question_regeneration_dispatch(${args});`).split("\n").at(-1),"t");
    assert.equal(execute(`${auth} select authorize_question_regeneration_dispatch(${args});`).split("\n").at(-1),"f");
    execute(`${auth} select fail_question_regeneration('${begin.attempt_id}','${request}','${owner}','QR-TIMEOUT',true);`);
    assert.equal(execute("select count(*) from question_regeneration_dispatch_metadata"),"1");
    assert.equal(execute("select model_id from question_regeneration_dispatch_metadata"),"mock-native");
    assert.throws(()=>execute("set role authenticated;select * from question_regeneration_dispatch_metadata"),/permission denied/);
    assert.throws(()=>execute("truncate question_regeneration_dispatch_metadata"),/immutable/);
    assert.throws(()=>execute("update question_regeneration_dispatch_metadata set model_id='changed'"),/immutable/);
  } catch(error) {
    if(!started)throw new Error(readFileSync(join(directory,"server.log"),"utf8"),{cause:error});
    throw error;
  } finally {
    if(started)execFileSync(join(bin,"pg_ctl"),["-D",directory,"-m","immediate","-w","stop"],{env,stdio:"pipe"});
    rmSync(directory,{recursive:true,force:true});
  }
});
