"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Toast } from "@/app/toast";
import { LoadingState } from "@/app/loading-state";
import { questionActionResponseSchema, type DisplayImage, type DisplayQuestion, type GenerationView } from "@/lib/question-generation/view-contract";
import { AnswerAutosave, type AnswerDraft, type AnswerSaveStatus, type AnswerVersion } from "@/lib/answers/autosave";
import { answerSaveErrorMessages } from "@/lib/answers/contract";
import { sentenceRefinementErrorMessages,sentenceRefinementResultSchema,SENTENCE_REFINEMENT_REQUEST_MS } from "@/lib/ai/sentence-refinement-contract";
import { questionActionRequestSchema,questionActionMessages } from "@/lib/question-generation/actions-contract";
import {readRegenerationResult,waitForRegeneration,regenerationErrorMessage} from "@/lib/question-generation/regeneration-controller";
import { DiaryPanel } from "./diary-panel";
import { canShowBriefing, questionSessionStatus } from "@/lib/session-completion/display-state";
import { QuestionBubble } from "./question-bubble";
import { layoutQuestionPins } from "@/lib/question-generation/pin-layout";
import { z } from "zod";

const refinementUnavailableMessage="문장 다듬기가 아직 활성화되지 않았거나 설정을 확인할 수 없습니다.";

type AnswerTextSegment={text:string;changed:boolean};
type CompletionRequest={request_id:string;retry_of_request_id:string|null};
type CompletionUIState="idle"|"checking"|"loading"|"pending"|"blocked"|"failed"|"unknown"|"completed";
type BriefingView={
  source:{source_text:string;model_id:string};
  current:string;
  revision:number;
  edited_at:string|null;
};

const completionStorageKey=(sessionId:string)=>`why-box:session-completion:${sessionId}`;
const completionResponseSchema=z.object({
  request_id:z.uuid(),
  state:z.enum(["blocked","ready","dispatch_started","completed","failed","dispatch_unknown"]),
  attempt_number:z.number().int().min(0).max(2),
  retry_of_request_id:z.uuid().nullable(),
  missing_question_ids:z.array(z.uuid()),
  has_answer:z.boolean(),
  replayed:z.boolean(),
  provider_mode:z.enum(["mock","openai"]),
}).strict();
const briefingResponseSchema=z.object({
  source:z.object({
    session_id:z.uuid(),
    participant_id:z.uuid(),
    request_id:z.uuid(),
    source_text:z.string().min(1).max(16000),
    model_id:z.string().min(1).max(200),
    prompt_version:z.string().min(1).max(200),
    schema_version:z.string().min(1).max(200),
    generated_at:z.string(),
  }).strict(),
  current:z.string().min(1),
  revision:z.number().int().nonnegative(),
  edited_at:z.string().nullable(),
}).strict();

function answerTextSegments(original:string,refined:string):AnswerTextSegment[] {
  const tokenize=(text:string)=>text.match(/\s+|[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu)??[];
  const before=tokenize(original),after=tokenize(refined);
  if(before.length*after.length>640_000) {
    let prefix=0;
    while(prefix<before.length&&prefix<after.length&&before[prefix]===after[prefix])prefix++;
    let suffix=0;
    while(suffix<before.length-prefix&&suffix<after.length-prefix&&
      before[before.length-1-suffix]===after[after.length-1-suffix])suffix++;
    return [
      ...after.slice(0,prefix).map(text=>({text,changed:false})),
      ...after.slice(prefix,after.length-suffix).map(text=>({text,changed:true})),
      ...after.slice(after.length-suffix).map(text=>({text,changed:false})),
    ];
  }
  const width=after.length+1;
  const lcs=new Uint32Array((before.length+1)*width);
  for(let i=before.length-1;i>=0;i--)for(let j=after.length-1;j>=0;j--) {
    const cell=i*width+j;
    lcs[cell]=before[i]===after[j]?lcs[(i+1)*width+j+1]+1:
      Math.max(lcs[(i+1)*width+j],lcs[i*width+j+1]);
  }
  const segments:AnswerTextSegment[]=[];
  function append(text:string,changed:boolean) {
    const last=segments.at(-1);
    if(last?.changed===changed)last.text+=text;
    else segments.push({text,changed});
  }
  let i=0,j=0;
  while(j<after.length) {
    if(i<before.length&&before[i]===after[j]) {
      append(after[j],false);i++;j++;
    } else if(i<before.length&&lcs[(i+1)*width+j]>=lcs[i*width+j+1])i++;
    else {append(after[j],true);j++;}
  }
  return segments;
}

function imageRatio(image:DisplayImage) {
  return image.width&&image.height?image.width/image.height:null;
}

function isWholeImageQuestion(question:DisplayQuestion) {
  return question.targets.every(target=>target.x===null);
}

async function persistAnswer(questionId:string,text:string,version:AnswerVersion,updatedAt:string|null) {
  const response=await fetch("/api/question-answer",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({question_id:questionId,answer_text:text,answer_version:version,expected_updated_at:updatedAt}),
  });
  const body=await response.json();
  if(!response.ok || typeof body.updated_at!=="string") {
    const code=typeof body.errorCode==="string"?body.errorCode:"ANSWER-DB";
    throw new Error(answerSaveErrorMessages[code]??answerSaveErrorMessages["ANSWER-DB"]);
  }
  return {updated_at:body.updated_at as string};
}

export function QuestionResult({result,sessionStatus="in_progress"}:{result:GenerationView;sessionStatus?:string}) {
  const [view,setView]=useState(result);
  const [slot,setSlot]=useState(1);
  const [revision,setRevision]=useState(0);
  const [notice,setNotice]=useState("");
  const [status,setStatus]=useState(questionSessionStatus(sessionStatus));
  useEffect(()=>setStatus(questionSessionStatus(sessionStatus)),[sessionStatus]);
  return <QuestionResultEditor key={revision} result={view} initialSlot={slot} sessionStatus={status}
    focusAfterAction={revision>0} initialNotice={notice}
    onSessionStatus={setStatus}
    onResult={(next,nextSlot,activityRecorded,superseded)=>{
      setView(next);setSlot(nextSlot);setRevision(previous=>previous+1);
      setNotice([
        superseded?"다른 화면에서 변경된 최신 질문을 표시했어요.":"",
        activityRecorded?"":"질문은 저장됐지만 최근 사용 기록을 갱신하지 못했습니다.",
      ].filter(Boolean).join(" "));
    }} />;
}

function QuestionResultEditor({result,initialSlot,onResult,focusAfterAction,initialNotice,sessionStatus,onSessionStatus}:{
  result:GenerationView;initialSlot:number;focusAfterAction:boolean;initialNotice:string;
  sessionStatus:string;onSessionStatus:(status:string)=>void;
  onResult:(next:GenerationView,slot:number,activityRecorded:boolean,superseded:boolean)=>void;
}) {
  const questions=[...result.questions].sort((a,b)=>a.slot_index-b.slot_index);
  const imageMap=new Map(result.images.map(image=>[image.id,image]));
  const router=useRouter();
  const [questionIndex,setQuestionIndex]=useState(initialSlot-1);
  const current=questions[questionIndex];
  const [imageId,setImageId]=useState(()=>current&&isWholeImageQuestion(current)?
    result.images[0]?.id??"":current?.targets[0]?.image_id??result.images[0]?.id??"");
  const [answers,setAnswers]=useState<Record<string,AnswerDraft>>(()=>
    Object.fromEntries(questions.map(question=>[question.id,{...question.answer}])));
  const answersRef=useRef(answers);
  answersRef.current=answers;
  const [saveStatus,setSaveStatus]=useState<Record<string,AnswerSaveStatus>>(()=>
    Object.fromEntries(questions.map(question=>[question.id,"저장됨"])));
  const [refinementNotice,setRefinementNotice]=useState<Record<string,{message:string;error:boolean;revision:number}>>({});
  const refinementNoticeSequence=useRef(0);
  const [saveErrors,setSaveErrors]=useState<Record<string,string|undefined>>({});
  const [naturalRatios,setNaturalRatios]=useState<Record<string,number>>({});
  const [questionAction,setQuestionAction]=useState<"skip"|"regenerate"|null>(null);
  const [actionNotice,setActionNotice]=useState(initialNotice);
  const sessionFinished=sessionStatus!=="in_progress";
  const [activeTab,setActiveTab]=useState<"summary"|"question">("question");
  const [briefing,setBriefing]=useState<BriefingView|null>(null);
  const [briefingMessage,setBriefingMessage]=useState("");
  const [briefingLoading,setBriefingLoading]=useState(false);
  const [briefingEditing,setBriefingEditing]=useState(false);
  const [briefingDraft,setBriefingDraft]=useState("");
  const [briefingSaving,setBriefingSaving]=useState(false);
  const [briefingDirtyNotice,setBriefingDirtyNotice]=useState("");
  const [copyNotice,setCopyNotice]=useState<{message:string;error:boolean}|null>(null);
  const [completionState,setCompletionState]=useState<CompletionUIState>("idle");
  const [completionMessage,setCompletionMessage]=useState("");
  const [completionMissing,setCompletionMissing]=useState<string[]>([]);
  const [exitDialog,setExitDialog]=useState(false);
  const [finishDialog,setFinishDialog]=useState(false);
  const [exitDestination,setExitDestination]=useState<string|null>(null);
  const completionBusyRef=useRef(false);
  const completionRequestRef=useRef<CompletionRequest|null>(null);
  const [actionRetry,setActionRetry]=useState(false);
  const actionBusyRef=useRef(false);
  const actionRequestRef=useRef<z.infer<typeof questionActionRequestSchema>|null>(null);
  const recoveryStartedRef=useRef(false);
  const actionAbortRef=useRef<AbortController|null>(null);
  const headerRef=useRef<HTMLDivElement>(null);
  const imageFrameRef=useRef<HTMLDivElement>(null);
  const [bubble,setBubble]=useState<{questionId:string;imageId:string;anchor:HTMLButtonElement}|null>(null);
  const [imageFrameSize,setImageFrameSize]=useState({width:0,height:0});
  const answerDiffRef=useRef<HTMLDivElement>(null);
  const [navigationBusy,setNavigationBusy]=useState(false);
  const navigationBusyRef=useRef(false);
  const refiningQuestionRef=useRef<string|null>(null);
  const refinementAbortRef=useRef<AbortController|null>(null);
  const [refiningQuestion,setRefiningQuestion]=useState<string|null>(null);
  const autosave=useRef<AnswerAutosave|null>(null);
  if(!autosave.current) {
    autosave.current=new AnswerAutosave(answers, persistAnswer, (id,answer,status,error)=>{
      answersRef.current={...answersRef.current,[id]:answer};
      setAnswers(answersRef.current);
      setSaveStatus(previous=>({...previous,[id]:status}));
      setSaveErrors(previous=>({...previous,[id]:error}));
    });
  }
  const currentAnswer=current?answers[current.id]:undefined;
  const answerText=currentAnswer?
    currentAnswer.current_answer_version==="refined"?currentAnswer.refined_answer??"":currentAnswer.original_answer:"";
  const answerDiffSegments=currentAnswer?.current_answer_version==="refined"&&currentAnswer.refined_answer!==null?
    answerTextSegments(currentAnswer.original_answer,currentAnswer.refined_answer):null;
  const shownImage=imageMap.get(imageId)??result.images[0];
  const activeImageId=shownImage?.id??"";
  const shownRatio=shownImage?(imageRatio(shownImage)??naturalRatios[shownImage.id]??1):1;
  const navigationLocked=navigationBusy||refiningQuestion!==null||questionAction!==null;
  const answerWritable=result.answer_editable&&!sessionFinished&&current?.status!=="skipped";
  const hasWrittenAnswer=!!currentAnswer&&!!(currentAnswer.original_answer.trim()||currentAnswer.refined_answer?.trim());
  const apiCapabilities=result.question_actions.regeneration;
  const reserveCount=apiCapabilities?.per_question.find(item=>item.question_id===current?.id)?.reserve_count??
    result.question_actions.reserve_count;
  const regenerationUnavailableMessage=!result.question_actions.ready?questionActionMessages["QA-UNAVAILABLE"]:
    !result.answer_editable?questionActionMessages["QA-STATE"]:
      hasWrittenAnswer?"작성한 답변이 있는 질문은 건너뛰거나 바꿀 수 없습니다.":
        current?.regeneration_index!==undefined&&current.regeneration_index>=2?questionActionMessages["QA-LIMIT"]:
          reserveCount===0&&!apiCapabilities?.ready?questionActionMessages["QA-RESERVE"]:
            reserveCount===0&&apiCapabilities?.calls_remaining===0?regenerationErrorMessage("QR-CALL-LIMIT"):"";

  useLayoutEffect(()=>{
    if(focusAfterAction)headerRef.current?.focus();
  },[focusAfterAction]);

  useEffect(()=>{
    try {
      const stored=window.localStorage.getItem(completionStorageKey(result.session_id));
      if(stored) {
        const parsed=z.object({
          request_id:z.uuid(),retry_of_request_id:z.uuid().nullable(),
          state:z.enum(["checking","loading","pending","blocked","failed","unknown"]),
        }).strict().safeParse(JSON.parse(stored));
        if(parsed.success) {
          const request={request_id:parsed.data.request_id,retry_of_request_id:parsed.data.retry_of_request_id};
          completionRequestRef.current=request;
          setCompletionState(parsed.data.state==="loading"||parsed.data.state==="checking"?"unknown":parsed.data.state);
          if(parsed.data.state==="unknown"||parsed.data.state==="loading"||
            parsed.data.state==="checking"||parsed.data.state==="pending") {
            setCompletionMessage("완료 요청 결과를 확인하지 못했어요. 같은 요청의 상태만 확인할 수 있습니다.");
          }
        }
      }
    } catch {
      setCompletionMessage("완료 요청 상태를 브라우저에 복원하지 못했습니다.");
    }
  },[result.session_id]);

  useEffect(()=>{
    if(!canShowBriefing(sessionStatus))return;
    const controller=new AbortController();
    setBriefingLoading(true);
    void fetchBriefing(controller.signal).finally(()=>setBriefingLoading(false));
    return ()=>controller.abort();
  },[sessionStatus,result.session_id]);

  useEffect(()=>{
    const pending=result.question_actions.regeneration;
    if(!pending?.pending_request_id||!pending.pending_question_id||recoveryStartedRef.current)return;
    recoveryStartedRef.current=true;
    actionRequestRef.current={session_id:result.session_id,question_id:pending.pending_question_id,
      request_id:pending.pending_request_id,action:"regenerate",expected_answer_revision:null};
    setQuestionAction("regenerate");setActionRetry(true);
    setActionNotice("진행 중인 질문 변경 결과를 같은 요청으로 확인해주세요.");
  },[result]);

  useEffect(()=>{
    const controller=autosave.current;
    controller?.attach();
    const warn=(event:BeforeUnloadEvent)=>{
      if((!sessionFinished&&sessionStatus==="in_progress")||controller?.hasPending||
        actionRequestRef.current||completionBusyRef.current||briefingEditing&&briefingDraft!==briefing?.current) {
        event.preventDefault();event.returnValue="";
      }
    };
    const guardNavigation=(event:globalThis.MouseEvent)=>{
      if(!(event.target instanceof Element))return;
      const link=event.target.closest("a[href]");
      if(!(link instanceof HTMLAnchorElement) || link.target==="_blank" || link.hasAttribute("download") ||
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)return;
      const destination=new URL(link.href,window.location.href);
      if(destination.pathname===window.location.pathname && destination.search===window.location.search)return;
      if(sessionFinished||sessionStatus!=="in_progress")return;
      event.preventDefault();event.stopPropagation();
      if(actionBusyRef.current||actionRequestRef.current) {
        setActionNotice("질문 변경 결과를 확인한 뒤 이동해주세요.");
        return;
      }
      if(refiningQuestionRef.current) {
        const activeQuestion=refiningQuestionRef.current;
        if(activeQuestion)notifyRefinement(activeQuestion,"문장 다듬기가 끝난 뒤 이동해주세요.",true);
        return;
      }
      if(navigationBusyRef.current||completionBusyRef.current)return;
      if(briefingEditing&&briefingDraft!==briefing?.current) {
        setBriefingDirtyNotice("저장하지 않은 브리핑 수정이 있어요. 먼저 저장하거나 취소해주세요.");
        return;
      }
      setExitDestination(destination.href);
      setExitDialog(true);
    };
    window.addEventListener("beforeunload",warn);
    document.addEventListener("click",guardNavigation,true);
    return ()=>{
      window.removeEventListener("beforeunload",warn);
      document.removeEventListener("click",guardNavigation,true);
      refinementAbortRef.current?.abort();
      actionAbortRef.current?.abort();
      controller?.detach();
    };
  },[router,sessionFinished,sessionStatus,briefingEditing,briefingDraft,briefing]);

  async function applyQuestionAction(action:"skip"|"regenerate",retry=false) {
    if(!current||sessionFinished||actionBusyRef.current||refiningQuestionRef.current||navigationBusyRef.current||
      (!retry&&(!result.question_actions.ready||!result.answer_editable||hasWrittenAnswer)))return;
    actionBusyRef.current=true;setQuestionAction(action);setActionNotice("");setActionRetry(false);
    try {
      if(!retry) {
        const saved=await autosave.current?.flushAll();
        if(!saved) {setActionNotice("답변을 먼저 저장해주세요. 입력한 내용은 유지되어 있어요.");setQuestionAction(null);return;}
        const answer=autosave.current?.getAnswer(current.id);
        if(!answer)throw new Error("Answer snapshot missing");
        actionRequestRef.current={session_id:result.session_id,question_id:current.id,
          request_id:crypto.randomUUID(),action,expected_answer_revision:answer.updated_at};
      }
      const input=actionRequestRef.current;
      if(!input)throw new Error("Action request missing");
      const controller=new AbortController();
      actionAbortRef.current=controller;
      const timer=setTimeout(()=>controller.abort(),action==="regenerate"&&apiCapabilities?100_000:20_000);
      let response:Response;
      let body;
      try {
        const first=retry&&action==="regenerate"&&apiCapabilities?
          await readRegenerationResult(input.session_id,input.request_id,controller.signal):
          await (async()=>{
            const response=await fetch("/api/question-action",{
              method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input),
              cache:"no-store",signal:controller.signal,
            });
            return {response,body:await response.json()};
          })();
        const resolved=first.response.status===202?
          await waitForRegeneration(input.session_id,input.request_id,input.question_id,controller.signal,first):first;
        response=resolved.response;body=resolved.body;
      } finally {clearTimeout(timer);}
      if(!response.ok) {
        const code=typeof body.errorCode==="string"?body.errorCode:"QA-DB";
        setActionNotice(regenerationErrorMessage(code));
        if(response.status>=500||code==="QA-DB"||code==="QR-RECOVERY")setActionRetry(true);
        else {actionRequestRef.current=null;setQuestionAction(null);}
        return;
      }
      const parsed=questionActionResponseSchema.safeParse(body);
      if(!parsed.success||parsed.data.request_id!==input.request_id||
        parsed.data.question_id!==input.question_id||parsed.data.view.session_id!==result.session_id||
        parsed.data.view.state!=="completed"||
        (action==="skip"&&parsed.data.result_question_id!==input.question_id)||
        (action==="regenerate"&&parsed.data.result_question_id===input.question_id))throw new Error("Invalid action result");
      const committed=parsed.data;
      const next=committed.view;
      const original=questions.find(question=>question.id===input.question_id);
      if(!original)throw new Error("Missing original action question");
      const sameSlot=next.questions.find(question=>question.slot_index===original.slot_index);
      const expectedIndex=original.regeneration_index+(action==="regenerate"?1:0);
      const superseded=!!sameSlot&&sameSlot.id!==committed.result_question_id&&
        sameSlot.regeneration_index>expectedIndex;
      if(!sameSlot||(!superseded&&(sameSlot.id!==committed.result_question_id||
        sameSlot.regeneration_index!==expectedIndex||(action==="skip"&&sameSlot.status!=="skipped")))) {
        throw new Error("Stale action result");
      }
      let nextSlot=original.slot_index;
      if(action==="skip"&&!superseded) {
        const ordered=[...next.questions.slice(original.slot_index),...next.questions.slice(0,original.slot_index-1)];
        nextSlot=ordered.find(question=>question.status==="unprocessed")?.slot_index??nextSlot;
      }
      actionRequestRef.current=null;
      onResult(next,nextSlot,committed.activity_recorded,superseded);
    } catch {
      setActionNotice(questionActionMessages["QA-DB"]);
      if(actionRequestRef.current)setActionRetry(true);
      else setQuestionAction(null);
    } finally {
      actionBusyRef.current=false;
      actionAbortRef.current=null;
    }
  }

  async function selectQuestion(index:number,image?:string) {
    if(navigationLocked || navigationBusyRef.current || actionBusyRef.current || actionRequestRef.current ||
      briefingEditing&&briefingDraft!==briefing?.current || !questions[index] || !current)return;
    navigationBusyRef.current=true;setNavigationBusy(true);
    const saved=await autosave.current?.flush(current.id);
    if(saved) {
      const next=questions[index];
      setBubble(null);
      setQuestionIndex(index);
      setActiveTab("question");
      setImageId(isWholeImageQuestion(next)?result.images[0]?.id??"":image??(next.targets.some(target=>target.image_id===activeImageId)?
        activeImageId:next.targets[0]?.image_id??""));
    }
    navigationBusyRef.current=false;setNavigationBusy(false);
    return !!saved;
  }
  async function selectImage(id:string) {
    if(navigationLocked || navigationBusyRef.current || actionBusyRef.current || actionRequestRef.current || !current)return;
    navigationBusyRef.current=true;setNavigationBusy(true);
    const saved=await autosave.current?.flush(current.id);
    if(saved){setBubble(null);setImageId(id);}
    navigationBusyRef.current=false;setNavigationBusy(false);
  }
  function saveCompletionRequest(request:CompletionRequest,state:CompletionUIState) {
    completionRequestRef.current=request;
    setCompletionState(state);
    try {
      window.localStorage.setItem(completionStorageKey(result.session_id),JSON.stringify({
        ...request,state,
      }));
    } catch {
      setCompletionMessage("완료 요청 ID를 브라우저에 보존할 수 없어 요청을 보내지 않았습니다.");
      throw new Error("Completion request cannot be persisted.");
    }
  }

  async function fetchBriefing(signal?:AbortSignal) {
    try {
      const response=await fetch(`/api/sessions/${result.session_id}/briefing`,{
        cache:"no-store",signal,
      });
      const body=await response.json();
      if(!response.ok)throw new Error("브리핑을 불러오지 못했습니다.");
      const parsed=briefingResponseSchema.safeParse(body);
      if(!parsed.success)throw new Error("브리핑 응답을 확인할 수 없습니다.");
      setBriefing(parsed.data);
      setBriefingDraft(parsed.data.current);
      setBriefingMessage("");
      setActiveTab("summary");
      return true;
    } catch(error) {
      if(signal?.aborted)return false;
      setBriefingMessage(error instanceof Error?error.message:"브리핑을 불러오지 못했습니다.");
      return false;
    }
  }

  function completionText(response:Response,state:string) {
    if(state==="blocked")return "아직 처리하지 않은 질문이 있거나 답변이 부족해 세션을 마무리할 수 없습니다.";
    if(state==="failed")return "브리핑 생성을 완료하지 못했습니다. 확정 실패로 기록되어 명시적으로 한 번 재시도할 수 있습니다.";
    if(state==="dispatch_unknown")return "브리핑 생성 결과를 확인할 수 없습니다. 같은 요청의 상태 확인만 가능하며 새 요청은 보낼 수 없습니다.";
    if(state==="dispatch_started"||state==="ready")return "브리핑 생성이 아직 진행 중입니다.";
    if(!response.ok)return "세션 마무리 요청을 처리하지 못했습니다.";
    return "";
  }

  async function postCompletion(request:CompletionRequest) {
    saveCompletionRequest(request,"loading");
    setCompletionMessage("답변을 확인하고 디자인 브리핑을 생성하고 있어요.");
    setCompletionMissing([]);
    const body={request_id:request.request_id,retry_of_request_id:request.retry_of_request_id};
    let latestState:string|undefined;
    try {
      for(let attempt=0;attempt<5;attempt++) {
        if(attempt>0)await new Promise(resolve=>setTimeout(resolve,1200));
        saveCompletionRequest(request,attempt===0?"loading":"checking");
        const response=await fetch(`/api/sessions/${result.session_id}/complete`,{
          method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),cache:"no-store",
        });
        const raw=await response.json();
        const parsed=completionResponseSchema.safeParse(raw);
        if(!parsed.success||parsed.data.request_id!==request.request_id) {
          throw new Error("완료 응답을 확인할 수 없습니다.");
        }
        const data=parsed.data;
        latestState=data.state;
        setCompletionMissing(data.missing_question_ids);
        if(data.state!=="blocked"&&data.state!=="completed")onSessionStatus("summary_ready");
        if(data.state==="completed") {
          saveCompletionRequest(request,"completed");
          setCompletionMessage("세션을 마무리했어요. 디자인 브리핑을 확인해주세요.");
          onSessionStatus("completed");
          try {window.localStorage.removeItem(completionStorageKey(result.session_id));} catch { /* Storage can be unavailable. */ }
          await fetchBriefing();
          router.refresh();
          setExitDialog(false);
          setFinishDialog(false);
          if(exitDestination) {
            const destination=new URL(exitDestination);
            if(destination.origin===window.location.origin)router.push(destination.pathname+destination.search+destination.hash);
            else window.location.assign(exitDestination);
          }
          return;
        }
        if(data.state==="blocked"||data.state==="failed"||data.state==="dispatch_unknown") {
          const nextState=data.state==="blocked"?"blocked":data.state==="failed"?"failed":"unknown";
          saveCompletionRequest(request,nextState);
          setCompletionMessage(completionText(response,data.state)||
            (!data.has_answer?"실제 답변을 하나 이상 작성해야 세션을 완료할 수 있습니다.":""));
          setFinishDialog(false);
          return;
        }
      }
      if(latestState==="ready"||latestState==="dispatch_started") {
        saveCompletionRequest(request,"pending");
        setCompletionMessage("브리핑 생성이 아직 진행 중입니다. 같은 요청으로 결과를 다시 확인할 수 있어요.");
      } else {
        saveCompletionRequest(request,"unknown");
        setCompletionMessage("완료 요청 결과를 확인하지 못했습니다. 새 요청을 만들지 않고 같은 요청의 상태만 확인해주세요.");
      }
    } catch {
      saveCompletionRequest(request,"unknown");
      setCompletionMessage("완료 요청 결과를 확인하지 못했습니다. 기존 답변은 보존되어 있으며 같은 요청의 상태만 확인할 수 있습니다.");
    } finally {
      completionBusyRef.current=false;
      setNavigationBusy(false);
    }
  }

  async function validateAndComplete(request?:CompletionRequest) {
    if(completionBusyRef.current||sessionStatus==="completed")return;
    completionBusyRef.current=true;
    setNavigationBusy(true);
    setCompletionState("checking");
    setCompletionMessage("답변을 저장하고 확인하고 있어요.");
    const saved=await autosave.current?.flushAll();
    if(!saved) {
      completionBusyRef.current=false;setNavigationBusy(false);
      setCompletionState("blocked");
      setCompletionMessage("답변 저장에 실패했습니다. 저장 상태를 확인하고 다시 시도해주세요.");
      return;
    }
    const missing=questions.filter(question=>{
      if(question.status==="skipped")return false;
      const answer=autosave.current?.getAnswer(question.id);
      const text=answer?.current_answer_version==="refined"?
        answer.refined_answer??"":answer?.original_answer??"";
      return !text.trim();
    });
    const hasAnswer=questions.some(question=>{
      if(question.status==="skipped")return false;
      const answer=autosave.current?.getAnswer(question.id);
      return (answer?.current_answer_version==="refined"?
        answer.refined_answer??"":answer?.original_answer??"").trim().length>0;
    });
    if(missing.length||!hasAnswer) {
      completionBusyRef.current=false;setNavigationBusy(false);
      setCompletionState("blocked");setCompletionMissing(missing.map(question=>question.id));
      setCompletionMessage(missing.length?
        "각 질문에 답하거나 건너뛰어야 합니다. 아래 질문으로 이동해 답변하거나 건너뛰어주세요.":
        "세션을 완료하려면 최소 한 질문에 실제 답변을 작성해야 합니다.");
      setFinishDialog(false);
      if(missing.length) {
        const first=questions.findIndex(question=>question.id===missing[0].id);
        if(first>=0)await selectQuestion(first);
      }
      return;
    }
    setFinishDialog(false);
    const pending=completionRequestRef.current;
    const current= request??pending??{request_id:crypto.randomUUID(),retry_of_request_id:null};
    try {saveCompletionRequest(current,"loading");}
    catch {
      completionBusyRef.current=false;setNavigationBusy(false);return;
    }
    await postCompletion(current);
  }

  async function retryCompletion() {
    const previous=completionRequestRef.current;
    if(!previous||completionState!=="failed"||completionBusyRef.current)return;
    const request={request_id:crypto.randomUUID(),retry_of_request_id:previous.request_id};
    await validateAndComplete(request);
  }

  async function saveAndLeave() {
    const destination=exitDestination;
    if(!destination||navigationBusyRef.current||completionBusyRef.current)return;
    navigationBusyRef.current=true;setNavigationBusy(true);
    const saved=await autosave.current?.flushAll();
    navigationBusyRef.current=false;setNavigationBusy(false);
    if(!saved) {
      setCompletionMessage("답변을 저장하지 못해 이동을 보류했어요. 입력한 내용은 유지되어 있습니다.");
      setCompletionState("blocked");
      setExitDialog(false);
      return;
    }
    setExitDialog(false);
    const url=new URL(destination);
    if(url.origin===window.location.origin)router.push(url.pathname+url.search+url.hash);
    else window.location.assign(destination);
  }

  async function saveBriefing() {
    if(!briefing||briefingSaving||!briefingDraft.trim())return;
    setBriefingSaving(true);setBriefingDirtyNotice("");
    try {
      const response=await fetch(`/api/sessions/${result.session_id}/briefing`,{
        method:"PATCH",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({expected_revision:briefing.revision,briefing_text:briefingDraft}),
      });
      const body=await response.json();
      if(response.status===409) {
        setBriefingDirtyNotice(`다른 버전이 먼저 저장되었습니다 (최신 revision ${body.current_revision}). 작성한 내용은 유지되어 있어요.`);
        return;
      }
      if(!response.ok||body.saved!==true||!Number.isInteger(body.revision)) {
        throw new Error("브리핑을 저장하지 못했습니다. 작성 내용은 유지되어 있습니다.");
      }
      setBriefing({...briefing,current:briefingDraft,revision:body.revision,edited_at:new Date().toISOString()});
      setBriefingEditing(false);
      setBriefingDirtyNotice("수정한 브리핑을 저장했어요.");
    } catch(error) {
      setBriefingDirtyNotice(error instanceof Error?error.message:"브리핑을 저장하지 못했습니다.");
    } finally {setBriefingSaving(false);}
  }

  async function copyBriefing() {
    if(!briefing)return;
    setCopyNotice(null);
    try {
      await navigator.clipboard.writeText(briefing.current);
      setCopyNotice({message:"디자인 브리핑 전체를 복사했어요.",error:false});
    } catch {
      setCopyNotice({message:"클립보드에 복사하지 못했습니다. 브리핑을 선택해 복사해주세요.",error:true});
    }
  }

  async function loadLatestBriefing() {
    setBriefingLoading(true);
    const loaded=await fetchBriefing();
    if(loaded)setBriefingEditing(false);
    setBriefingLoading(false);
  }

  async function selectSummary() {
    if(briefingEditing&&briefingDraft!==briefing?.current) {
      setBriefingDirtyNotice("저장하지 않은 수정이 있어요. 먼저 저장하거나 취소해주세요.");
      return;
    }
    if(navigationLocked||navigationBusyRef.current||!canShowBriefing(sessionStatus))return;
    navigationBusyRef.current=true;setNavigationBusy(true);
    const saved=current?await autosave.current?.flush(current.id):true;
    if(saved)setActiveTab("summary");
    navigationBusyRef.current=false;setNavigationBusy(false);
  }

  function onNavigationKey(event:KeyboardEvent<HTMLElement>) {
    if(event.target instanceof HTMLElement &&
      (event.target.matches("textarea,input") || event.target.isContentEditable))return;
    if(event.key==="ArrowRight" && questionIndex<questions.length-1) {
      event.preventDefault();void selectQuestion(questionIndex+1);
    } else if(event.key==="ArrowLeft" && questionIndex>0) {
      event.preventDefault();void selectQuestion(questionIndex-1);
    }
  }
  async function goToPin(question:DisplayQuestion,image:string,anchor:HTMLButtonElement) {
    const index=questions.findIndex(item=>item.id===question.id);
    if(index>=0&&await selectQuestion(index,image))setBubble({questionId:question.id,imageId:image,anchor});
  }
  async function refineCurrentAnswer() {
    if(!current || !currentAnswer || !answerWritable || actionBusyRef.current || actionRequestRef.current || refiningQuestionRef.current ||
      navigationBusyRef.current || !answerText.trim())return;
    const questionId=current.id;
    const controller=new AbortController();
    refinementAbortRef.current=controller;
    const timer=setTimeout(()=>controller.abort(),SENTENCE_REFINEMENT_REQUEST_MS);
    refiningQuestionRef.current=questionId;setRefiningQuestion(questionId);
    clearRefinementNotice(questionId);
    try {
      const saved=await autosave.current?.flush(questionId);
      if(!saved) {
        notifyRefinement(questionId,"답변을 먼저 저장해주세요. 입력한 내용은 유지되어 있어요.",true);
        return;
      }
      const savedAnswer=autosave.current?.getAnswer(questionId);
      if(!savedAnswer || !savedAnswer.updated_at) throw new Error("Answer snapshot missing");
      const snapshot={...savedAnswer};
      const response=await fetch("/api/sentence-refinement",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({question_id:questionId,expected_updated_at:snapshot.updated_at}),
        signal:controller.signal,
      });
      const body=await response.json();
      if(!response.ok) {
        const code=body&&typeof body.errorCode==="string"?body.errorCode:"REFINE-API";
        notifyRefinement(questionId,code==="REFINE-CONFIG"?refinementUnavailableMessage:
          sentenceRefinementErrorMessages[code]??sentenceRefinementErrorMessages["REFINE-API"],true);
        return;
      }
      const parsed=sentenceRefinementResultSchema.safeParse(body);
      if(!parsed.success)throw new Error("Invalid refinement result");
      if(controller.signal.aborted)throw new Error("Refinement request expired");
      if(refiningQuestionRef.current!==questionId)throw new Error("Refinement question changed");
      const applied=autosave.current?.applyRefinement(questionId,parsed.data.refined_text,parsed.data.updated_at,snapshot);
      if(!applied) {
        notifyRefinement(questionId,sentenceRefinementErrorMessages["REFINE-STALE"],true);
        return;
      }
      notifyRefinement(questionId,"문장을 다듬었어요.");
    } catch {
      notifyRefinement(questionId,"문장을 다듬지 못했어요. 다시 시도해주세요.",true);
    } finally {
      clearTimeout(timer);
      if(refinementAbortRef.current===controller)refinementAbortRef.current=null;
      refiningQuestionRef.current=null;setRefiningQuestion(null);
    }
  }
  async function restoreOriginal() {
    if(!current || refiningQuestionRef.current || navigationBusyRef.current || actionBusyRef.current || actionRequestRef.current)return;
    autosave.current?.selectVersion(current.id,"original");
    notifyRefinement(current.id,"원문으로 되돌렸어요.");
    await autosave.current?.flush(current.id);
  }
  async function showRefined() {
    if(!current || refiningQuestionRef.current || navigationBusyRef.current || actionBusyRef.current || actionRequestRef.current)return;
    autosave.current?.selectVersion(current.id,"refined");
    notifyRefinement(current.id,"다듬은 문장을 다시 표시했어요.");
    await autosave.current?.flush(current.id);
  }
  const pins=questions.flatMap(question=>question.targets
    .filter(target=>target.image_id===activeImageId && target.x!==null)
    .map(target=>({question,target})));
  const wholeImageQuestions=questions.filter(isWholeImageQuestion);
  const status=current?saveStatus[current.id]??"저장됨":"저장됨";
  const refinedAvailable=!!currentAnswer?.refinement_used && currentAnswer.refined_answer!==null;
  const actionToastMessage=actionNotice;
  useEffect(()=>{
    const frame=imageFrameRef.current;
    if(!frame)return;
    const measure=()=>setImageFrameSize(previous=>previous.width===frame.clientWidth&&
      previous.height===frame.clientHeight?previous:{width:frame.clientWidth,height:frame.clientHeight});
    measure();
    if(typeof ResizeObserver==="undefined")return;
    const observer=new ResizeObserver(measure);
    observer.observe(frame);
    return ()=>observer.disconnect();
  },[activeImageId]);
  const pinLayout=layoutQuestionPins(imageFrameSize,pins.map(({question,target})=>({
    id:`${question.id}:${target.sort_order}`,questionId:question.id,slot:question.slot_index,
    x:target.x!+target.width!/2,y:target.y!+target.height!/2,
  })));

  function notifyRefinement(questionId:string,message:string,error=false) {
    const revision=++refinementNoticeSequence.current;
    setRefinementNotice(previous=>({...previous,[questionId]:{message,error,revision}}));
  }

  function clearRefinementNotice(questionId:string) {
    setRefinementNotice(previous=>({...previous,[questionId]:{message:"",error:false,revision:0}}));
  }

  return <section className="content-stack question-result" aria-labelledby="question-result-title">
    <header className="question-result-heading">
      <p className="eyebrow">Reflection · 성찰</p>
      <h1 className="page-title" id="question-result-title">생각을 돌아보는 질문</h1>
    </header>
    <div className="question-result-layout">
      <section className="question-image-column" aria-label="질문과 연결된 디자인 이미지">
        <div className="question-image-stage">
          {shownImage?<div ref={imageFrameRef} className="question-image-frame" style={{
            aspectRatio:shownImage.width&&shownImage.height?`${shownImage.width}/${shownImage.height}`:`${shownRatio}`,
            "--question-image-ratio":shownRatio,
          } as CSSProperties}>
            <img className="question-result-image" src={shownImage.signed_url}
              onLoad={event=>{
                const image=event.currentTarget;
                if(!imageRatio(shownImage) && image.naturalHeight>0) {
                  setNaturalRatios(previous=>({...previous,[shownImage.id]:image.naturalWidth/image.naturalHeight}));
                }
              }}
              alt={`업로드한 디자인 이미지 ${shownImage.sort_order+1}`} />
            <div className="question-image-pins" aria-label="질문 위치">
              {pinLayout.some(pin=>Math.hypot(pin.left-pin.originalX,pin.top-pin.originalY)>3)?
                <svg className="question-pin-connectors" viewBox={`0 0 ${imageFrameSize.width||1} ${imageFrameSize.height||1}`}
                  preserveAspectRatio="none" aria-hidden="true">
                  {pinLayout.filter(pin=>Math.hypot(pin.left-pin.originalX,pin.top-pin.originalY)>3).map(pin=>
                    <g key={pin.id}>
                      <circle cx={pin.originalX} cy={pin.originalY} r="3" />
                      <line x1={pin.originalX} y1={pin.originalY} x2={pin.left} y2={pin.top} />
                    </g>)}
                </svg>:null}
              {wholeImageQuestions.length>0?<div className="question-whole-image-pins">
                {wholeImageQuestions.map(question=><button type="button" key={question.id}
                  className={`question-pin question-whole-image-pin${question.id===current?.id?" is-active":""}`}
                  aria-label={`질문 ${question.slot_index} 전체 이미지 보기`}
                  aria-current={question.id===current?.id?"true":undefined}
                  aria-expanded={bubble?.questionId===question.id&&bubble.imageId===activeImageId}
                  aria-controls={bubble?.questionId===question.id?"question-pin-bubble":undefined}
                  disabled={navigationLocked}
                  onClick={event=>void goToPin(question,activeImageId,event.currentTarget)}>{question.slot_index}</button>)}
              </div>:null}
              {pins.map(({question,target})=>{const display=pinLayout.find(pin=>pin.id===`${question.id}:${target.sort_order}`);return <button type="button" key={`${question.id}:${target.image_id}:${target.sort_order}`}
                className={`question-pin${question.id===current?.id?" is-active":""}`}
                style={display?{left:display.left,top:display.top}:{
                  left:`${(target.x!+target.width!/2)*100}%`,
                  top:`${(target.y!+target.height!/2)*100}%`,
                }}
                aria-label={`질문 ${question.slot_index} 위치 보기`}
                aria-current={question.id===current?.id?"true":undefined}
                aria-expanded={bubble?.questionId===question.id&&bubble.imageId===activeImageId}
                aria-controls={bubble?.questionId===question.id?"question-pin-bubble":undefined}
                disabled={navigationLocked}
                onClick={event=>void goToPin(question,activeImageId,event.currentTarget)}>{question.slot_index}</button>;})}
            </div>
            {bubble&&bubble.imageId===activeImageId&&bubble.questionId===current?.id?
              <QuestionBubble frame={imageFrameRef} anchor={bubble.anchor} question={current}
                obstacles={pinLayout.filter(pin=>pin.questionId!==current.id).map(pin=>({
                  left:pin.left-19,right:pin.left+19,top:pin.top-19,bottom:pin.top+19,
                }))}
                onClose={()=>{setBubble(null);bubble.anchor.focus();}} />:null}
          </div>:<p role="alert">질문에 연결된 이미지를 불러오지 못했습니다. 페이지를 새로고침해주세요.</p>}
        </div>
        {result.images.length>1?<nav className="question-image-thumbnails" aria-label="업로드한 디자인 이미지">
          {result.images.map(image=><button key={image.id} type="button"
            className={`question-image-thumbnail${image.id===activeImageId?" is-active":""}`}
            aria-label={`이미지 ${image.sort_order+1} 보기`} aria-pressed={image.id===activeImageId}
            disabled={navigationLocked}
            onClick={()=>void selectImage(image.id)}>
            <img src={image.signed_url} alt="" />
          </button>)}
        </nav>:null}
      </section>
      <section className="question-panel" aria-label="질문과 나의 생각" tabIndex={0} onKeyDown={onNavigationKey}>
        {current?<>
          <div className="question-panel-header" ref={headerRef} tabIndex={-1}>
            <p className="question-panel-count" aria-live="polite">
              {activeTab==="summary"?"세션 요약":`질문 ${questionIndex+1} / ${questions.length}`}
            </p>
            <nav className="question-panel-navigation" aria-label="질문 이동">
              <div className="question-panel-pagination">
                {canShowBriefing(sessionStatus)&&briefing?<button type="button"
                  className={`question-summary-tab${activeTab==="summary"?" is-active":""}`}
                  aria-label="디자인 브리핑 요약 보기" aria-current={activeTab==="summary"?"page":undefined}
                  disabled={navigationLocked||briefingLoading}
                  onClick={()=>void selectSummary()}>
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M12 3.5 14.5 9l6 .8-4.4 4.1 1.2 5.9-5.3-3-5.3 3 1.2-5.9-4.4-4.1 6-.8L12 3.5Z" />
                  </svg>
                </button>:null}
                {questions.map((question,index)=><button key={question.id} type="button"
                  className={`question-page-button${index===questionIndex?" is-active":""}`}
                  aria-label={`질문 ${index+1} 선택`} aria-current={index===questionIndex?"step":undefined}
                  disabled={navigationLocked||briefingEditing&&briefingDraft!==briefing?.current}
                  onClick={()=>void selectQuestion(index)}><span>{index+1}</span></button>)}
              </div>
            </nav>
          </div>
          {canShowBriefing(sessionStatus)&&!briefing?<div className="briefing-notice" role={briefingMessage?"alert":"status"}>
            {briefingMessage||"저장된 디자인 브리핑을 불러오고 있어요."}
            {briefingMessage?<button type="button" className="button-secondary"
              onClick={()=>void fetchBriefing()}>다시 불러오기</button>:null}
          </div>:null}
          {activeTab==="summary"&&canShowBriefing(sessionStatus)&&briefing?<section className="question-panel-content briefing-panel" aria-labelledby="briefing-title">
            <div className="briefing-heading">
              <h2 id="briefing-title" className="question-panel-text">디자인 브리핑</h2>
              <button type="button" className="briefing-copy-button" aria-label="현재 브리핑 복사"
                title="현재 브리핑 복사" disabled={!briefing||briefingLoading||briefingEditing}
                onClick={()=>void copyBriefing()}>
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <rect x="8" y="8" width="12" height="13" rx="2" />
                  <path d="M16 8V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h2" />
                </svg>
              </button>
            </div>
            {!briefing&&briefingLoading?<LoadingState>저장된 디자인 브리핑을 불러오고 있어요.</LoadingState>:null}
            {!briefing&&briefingMessage?<div role="alert" className="briefing-notice">
              <p>{briefingMessage}</p>
              <button type="button" className="button-secondary" onClick={()=>void fetchBriefing()}>다시 불러오기</button>
            </div>:null}
            {briefing?<>
              {briefingEditing?<label className="briefing-editor-label" htmlFor="design-briefing-editor">
                브리핑 수정 내용
                <textarea id="design-briefing-editor" className="briefing-editor" maxLength={16000}
                  value={briefingDraft} onChange={event=>setBriefingDraft(event.target.value)} />
              </label>:<p className="briefing-text">{briefing.current}</p>}
              <p className="briefing-provenance">
                {briefing.source.model_id==="WHY-BOX-LOCAL-MOCK"?
                  "TEST용 Mock 브리핑":"AI 생성 브리핑"}
                {briefing.revision>0?` · 사용자 수정본 ${briefing.revision}`:" · 원본"}
              </p>
              {briefingDirtyNotice?<p role="status" className="briefing-notice">{briefingDirtyNotice}</p>:null}
              {briefingEditing?<>
                {briefingDirtyNotice.includes("revision")?<button type="button" className="button-secondary"
                  disabled={briefingLoading} onClick={()=>void loadLatestBriefing()}>최신 버전 불러오기</button>:null}
                <div className="briefing-actions">
                <button type="button" className="button-secondary" disabled={briefingSaving}
                  onClick={()=>{setBriefingDraft(briefing.current);setBriefingEditing(false);setBriefingDirtyNotice("");}}>
                  취소
                </button>
                <button type="button" disabled={briefingSaving||!briefingDraft.trim()||
                  briefingDraft===briefing.current} onClick={()=>void saveBriefing()}>
                  {briefingSaving?"저장 중...":"저장"}
                </button>
              </div></>:<button type="button" className="button-secondary briefing-edit-button"
                onClick={()=>{setBriefingDraft(briefing.current);setBriefingEditing(true);setBriefingDirtyNotice("");}}>
                수정하기
              </button>}
              <Toast message={copyNotice?.message??""} error={copyNotice?.error??false} />
            </>:null}
            {briefing?<DiaryPanel sessionId={result.session_id}
              active={activeTab==="summary"&&!briefingLoading&&!briefingEditing} />:null}
          </section>:<>
          <div className="question-panel-content">
          <p className="question-panel-text">{current.question_text}</p>
          <div className="question-actions">
            <button type="button" className="question-text-action" aria-label="현재 질문 재생성"
              title={regenerationUnavailableMessage||undefined}
              aria-busy={questionAction==="regenerate"}
              aria-disabled={!!regenerationUnavailableMessage||navigationLocked}
              disabled={navigationLocked||sessionFinished}
              onClick={()=>{
                if(regenerationUnavailableMessage) {
                  setActionNotice(regenerationUnavailableMessage);
                  return;
                }
                void applyQuestionAction("regenerate");
              }}>
              <span aria-hidden="true">↻</span> {questionAction==="regenerate"?
                <LoadingState variant="button">질문을 바꾸는 중…</LoadingState>:"질문 재생성"}
            </button>
            <button type="button" className="question-text-action" aria-label="현재 질문 건너뛰기"
              aria-busy={questionAction==="skip"}
              disabled={sessionFinished||!result.question_actions.ready||!result.answer_editable||hasWrittenAnswer||
                current.status==="skipped"||navigationLocked}
              onClick={()=>void applyQuestionAction("skip")}>
              <span aria-hidden="true">↪</span> {questionAction==="skip"?
                <LoadingState variant="button">질문을 건너뛰는 중…</LoadingState>:"질문 건너뛰기"}
            </button>
          </div>
          {actionToastMessage?<Toast key={actionToastMessage} message={actionToastMessage}
            error={!!actionNotice} persistent={actionRetry}
            action={actionRetry?<button type="button" className="button-secondary"
              disabled={actionBusyRef.current}
              onClick={()=>void applyQuestionAction(actionRequestRef.current?.action??"skip",true)}>
              같은 요청으로 결과 다시 확인
            </button>:undefined} />:null}
          <div className="question-answer">
            {answerDiffSegments?<div className="question-answer-diff" aria-hidden="true" ref={answerDiffRef}>
              {answerDiffSegments.map((segment,index)=><span key={`${index}-${segment.text}`}
                className={segment.changed?"question-answer-diff-changed":undefined}>{segment.text}</span>)}
            </div>:null}
            <textarea id="question-answer-text"
              className={`question-answer-textarea${answerDiffSegments?" has-answer-diff":""}`}
              aria-label="나의 생각"
              placeholder={current.status==="skipped"?
                "건너뛴 질문이며 답변을 입력할 수 없습니다.":
                "질문을 보고 떠오른 답변을 자유롭게 적어보세요."}
              value={answerText} disabled={!answerWritable || navigationLocked}
              maxLength={20_000}
              onScroll={event=>{
                if(answerDiffRef.current)answerDiffRef.current.scrollTop=event.currentTarget.scrollTop;
              }}
              onChange={event=>autosave.current?.change(current.id,event.target.value)} />
          </div>
          </div>
            <div className="question-answer-actions">
              <div className="question-answer-statuses">
                {refinedAvailable && answerWritable?
                  currentAnswer.current_answer_version==="refined"?
                    <button type="button" className="text-link question-answer-version-button"
                      disabled={navigationLocked} onClick={()=>void restoreOriginal()}>
                      원문으로 되돌리기
                    </button>:
                    <button type="button" className="text-link question-answer-version-button"
                      disabled={navigationLocked} onClick={()=>void showRefined()}>
                      다듬은 문장 다시 보기
                    </button>:null}
                <p className="question-answer-save-status" role="status" aria-live="polite">
                  {status==="저장됨"?"":status}{status==="저장 실패"?" · 입력한 내용은 유지되어 있어요.":""}
                </p>
                {status==="저장 실패" && result.answer_editable?<button type="button" className="text-link"
                  onClick={()=>void autosave.current?.retry(current.id)}>다시 저장</button>:null}
                {status==="저장 실패" && saveErrors[current.id]?<Toast
                  message={Object.values(answerSaveErrorMessages).includes(saveErrors[current.id]!)?
                    saveErrors[current.id]!:answerSaveErrorMessages["ANSWER-DB"]} error />:null}
                {navigationBusy?<p className="question-answer-save-status" role="status">
                  질문을 이동하기 전 답변을 저장하고 있어요.
                </p>:null}
                {refinementNotice[current.id]?.message?<Toast
                  key={`${current.id}-${refinementNotice[current.id].revision}`}
                  message={refinementNotice[current.id].message}
                  error={refinementNotice[current.id].error} />:null}
              </div>
              <div className="question-answer-tools">
                <button type="button" className="question-text-action question-refine-button"
                  aria-busy={refiningQuestion===current.id}
                  disabled={!answerWritable || !answerText.trim() || navigationLocked}
                  onClick={()=>void refineCurrentAnswer()}>
                  <span className="question-refine-icon" aria-hidden="true">✦</span>
                  <span className="question-refine-label">
                    {refiningQuestion===current.id?"문장을 정리하고 있어요...":"문장다듬기"}
                  </span>
                </button>
              </div>
            </div>
          </>}
        </>:null}
      </section>
    </div>
    {sessionStatus==="completed"?
      <p className="question-result-readonly">완료된 질문과 답변은 읽기 전용입니다.</p>:
      <section className="completion-controls" aria-label="세션 종료 상태">
      {sessionStatus==="summary_ready"&&!completionMessage?
        <p className="question-result-readonly">세션 완료를 준비 중입니다. 질문과 답변은 보존되어 있으며 완료 요청의 결과를 확인해주세요.</p>:null}
      {completionMessage&&completionState!=="unknown"&&completionState!=="pending"?
        <div className={`completion-status${completionState==="failed"?" is-error":""}`}
          role={completionState==="failed"?"alert":"status"} aria-live="polite">
        {completionState==="checking"||completionState==="loading"?
          <LoadingState>{completionMessage}</LoadingState>:<p>{completionMessage}</p>}
        {completionMissing.length>0?<ul className="completion-missing-questions">
          {completionMissing.map(id=>{
            const question=questions.find(item=>item.id===id);
            return question?<li key={id}><button type="button" className="text-link"
              onClick={()=>void selectQuestion(questions.indexOf(question))}>
              질문 {question.slot_index}으로 이동
            </button></li>:null;
          })}
        </ul>:null}
        {completionState==="failed"?<button type="button" className="button-secondary"
          disabled={completionBusyRef.current} onClick={()=>void retryCompletion()}>
          명시적으로 한 번 다시 시도
        </button>:null}
        </div>:null}
      </section>}
    <div className="wizard-footer question-result-footer">
      <div className="wizard-footer-inner">
        <div className={`wizard-footer-row${sessionStatus==="in_progress"?"":" is-single-action"}`}>
          <Link href="/history" className="button-link button-secondary">나의기록으로</Link>
          {sessionStatus==="in_progress"?<div className="wizard-actions">
            <button type="button" disabled={navigationBusy||refiningQuestion!==null||questionAction!==null||
              completionBusyRef.current||briefingEditing}
              onClick={()=>setFinishDialog(true)}>세션 종료</button>
          </div>:null}
        </div>
      </div>
    </div>
    {exitDialog?<div className="session-dialog-backdrop">
      <section className="session-dialog session-exit-dialog content-stack" role="dialog" aria-modal="true"
        aria-labelledby="session-exit-title">
        <h2 id="session-exit-title" className="card-title">세션을 나가시겠어요?</h2>
        <p>답변을 저장하고 나가거나, 계속 작성할 수 있습니다.</p>
        <div className="session-dialog-actions">
          <button type="button" className="button-secondary" onClick={()=>setExitDialog(false)}>계속 작성</button>
          <button type="button" className="button-secondary" disabled={navigationBusy}
            onClick={()=>void saveAndLeave()}>{navigationBusy?"저장 중...":"저장 후 나가기"}</button>
        </div>
      </section>
    </div>:null}
    {finishDialog?<div className="session-dialog-backdrop">
      <section className="session-dialog session-finish-dialog content-stack" role="dialog" aria-modal="true"
        aria-labelledby="session-finish-title">
        <h2 id="session-finish-title" className="card-title">세션을 종료할까요?</h2>
        <p>답변을 저장한 뒤 세션을 완료하고 디자인 브리핑을 준비합니다.<br />
          완료 후 질문과 답변은 읽기 전용이 됩니다.</p>
        <div className="session-dialog-actions">
          <button type="button" className="button-secondary" disabled={completionBusyRef.current}
            onClick={()=>setFinishDialog(false)}>계속 작성</button>
          <button type="button" disabled={completionBusyRef.current}
            onClick={()=>void validateAndComplete()}>{completionBusyRef.current?
              <LoadingState variant="button">답변을 저장하고 있어요.</LoadingState>:"세션 종료"}</button>
        </div>
      </section>
    </div>:null}
  </section>;
}
