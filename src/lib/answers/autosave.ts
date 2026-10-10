export type AnswerVersion="original"|"refined";
export type AnswerDraft={
  original_answer:string;refined_answer:string|null;refinement_used:boolean;
  current_answer_version:AnswerVersion;updated_at:string|null;
};
export type AnswerSaveStatus="저장됨"|"저장 중"|"저장 실패";
export type AnswerSaveResult={updated_at:string};
type Entry={
  answer:AnswerDraft;savedText:string;savedVersion:AnswerVersion;
  status:AnswerSaveStatus;timer:ReturnType<typeof setTimeout>|undefined;
  failed:boolean;inFlight:Promise<boolean>|null;
  error:string|undefined;
};
type SaveAnswer=(questionId:string,text:string,version:AnswerVersion,updatedAt:string|null)=>Promise<AnswerSaveResult>;

export class AnswerAutosave {
  private entries=new Map<string,Entry>();
  private disposed=false;
  private lifecycle=0;
  constructor(initial:Record<string,AnswerDraft>,private save:SaveAnswer,
    private notify:(questionId:string,answer:AnswerDraft,status:AnswerSaveStatus,error?:string)=>void) {
    for(const [questionId,answer] of Object.entries(initial)) this.entries.set(questionId,{
      answer:{...answer},savedText:this.currentText(answer),savedVersion:answer.current_answer_version,
      status:"저장됨",timer:undefined,failed:false,inFlight:null,error:undefined,
    });
  }
  private currentText(answer:AnswerDraft) {
    return answer.current_answer_version==="refined"?answer.refined_answer??"":answer.original_answer;
  }
  private dirty(entry:Entry) {
    return entry.savedText!==this.currentText(entry.answer) ||
      entry.savedVersion!==entry.answer.current_answer_version;
  }
  getAnswer(questionId:string) { return this.entries.get(questionId)?.answer; }
  getStatus(questionId:string) { return this.entries.get(questionId)?.status??"저장됨"; }
  get hasPending() {
    return [...this.entries.values()].some(entry=>this.dirty(entry)||entry.status==="저장 중"||entry.failed);
  }
  private publish(questionId:string,entry:Entry,status:AnswerSaveStatus) {
    entry.status=status;
    this.notify(questionId,{...entry.answer},status,entry.error);
  }
  change(questionId:string,text:string,delay=800) {
    const entry=this.entries.get(questionId);
    if(!entry || this.disposed) return;
    entry.answer=entry.answer.current_answer_version==="refined"?
      {...entry.answer,refined_answer:text}:{...entry.answer,original_answer:text};
    clearTimeout(entry.timer);entry.timer=undefined;
    this.publish(questionId,entry,entry.failed?"저장 실패":"저장 중");
    if(!entry.failed) entry.timer=setTimeout(()=>{entry.timer=undefined;void this.flush(questionId);},delay);
  }
  selectVersion(questionId:string,version:AnswerVersion) {
    const entry=this.entries.get(questionId);
    if(!entry || this.disposed || (version==="refined" &&
      (!entry.answer.refinement_used || entry.answer.refined_answer===null))) return;
    entry.answer={...entry.answer,current_answer_version:version};
    clearTimeout(entry.timer);entry.timer=undefined;
    this.publish(questionId,entry,entry.failed?"저장 실패":"저장 중");
    if(!entry.failed) entry.timer=setTimeout(()=>{entry.timer=undefined;void this.flush(questionId);},0);
  }
  applyRefinement(questionId:string,text:string,updatedAt:string,expected?:AnswerDraft) {
    const entry=this.entries.get(questionId);
    if(!entry || this.disposed) return false;
    if(expected && (this.dirty(entry)||entry.inFlight||entry.failed||
      entry.answer.updated_at!==expected.updated_at||
      entry.answer.current_answer_version!==expected.current_answer_version||
      entry.answer.original_answer!==expected.original_answer||
      entry.answer.refined_answer!==expected.refined_answer))return false;
    entry.answer={...entry.answer,refined_answer:text,refinement_used:true,
      current_answer_version:"refined",updated_at:updatedAt};
    entry.savedText=text;entry.savedVersion="refined";entry.failed=false;
    clearTimeout(entry.timer);entry.timer=undefined;
    this.publish(questionId,entry,"저장됨");
    return true;
  }
  retry(questionId:string) {
    const entry=this.entries.get(questionId);
    if(!entry || this.disposed)return Promise.resolve(false);
    entry.failed=false;entry.error=undefined;clearTimeout(entry.timer);entry.timer=undefined;
    return this.flush(questionId);
  }
  flush(questionId:string):Promise<boolean> {
    const entry=this.entries.get(questionId);
    if(!entry || this.disposed)return Promise.resolve(false);
    clearTimeout(entry.timer);entry.timer=undefined;
    if(entry.inFlight)return entry.inFlight;
    if(entry.failed)return Promise.resolve(false);
    if(!this.dirty(entry)) {
      this.publish(questionId,entry,"저장됨");
      return Promise.resolve(true);
    }
    const operation=(async()=>{
      while(!this.disposed && this.dirty(entry)) {
        const text=this.currentText(entry.answer);
        const version=entry.answer.current_answer_version;
        const revision=entry.answer.updated_at;
        this.publish(questionId,entry,"저장 중");
        try {
          const result=await this.save(questionId,text,version,revision);
          if(this.disposed)return false;
          entry.answer={...entry.answer,updated_at:result.updated_at};
          entry.savedText=text;entry.savedVersion=version;
        } catch(error) {
          if(!this.disposed) {
            entry.error=error instanceof Error?error.message:undefined;
            entry.failed=true;this.publish(questionId,entry,"저장 실패");
          }
          return false;
        }
      }
      if(!this.disposed)this.publish(questionId,entry,"저장됨");
      return !this.disposed;
    })();
    entry.inFlight=operation;
    void operation.finally(()=>{if(entry.inFlight===operation)entry.inFlight=null;});
    return operation;
  }
  async flushAll() {
    const ids=[...this.entries.keys()];
    const results=await Promise.all(ids.map(id=>this.flush(id)));
    return results.every(Boolean);
  }
  attach() {
    this.lifecycle++;
    this.disposed=false;
  }
  detach() {
    const lifecycle=++this.lifecycle;
    queueMicrotask(()=>{
      if(lifecycle===this.lifecycle)this.dispose();
    });
  }
  dispose() {
    this.disposed=true;
    for(const entry of this.entries.values()) {clearTimeout(entry.timer);entry.timer=undefined;}
  }
}
