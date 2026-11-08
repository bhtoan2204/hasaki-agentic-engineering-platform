import { pool, q, one, withTx, type Db } from "../db/pool.ts";
import { config } from "../config.ts";
import { HttpError } from "../http/error.ts";
import { requireOwner } from "../authz/access.ts";
import { execution } from "../auth/execution.ts";
import { approveStep, rejectStep, answerQuestions } from "../workflow/engine.ts";
import { runEvents } from "../workflow/events.ts";
import { botKey, textLimit, safeTelegramText, telegramCall } from "./client.ts";
import { opaqueId, bindFromStart, limited, preferences, queue, telegramAudit } from "./store.ts";
import { contextHash, decisionMessage, makeAction } from "./workflow.ts";

const validId=(v:unknown)=>typeof v==="number" && Number.isSafeInteger(v) && v>0;
const denied="Action unavailable or unauthorized / Thao tác không khả dụng hoặc không được phép.";
function privateIdentity(update:any){
  const callback=update.callback_query, message=callback?.message??update.message,from=callback?.from??message?.from;
  if(!message || message.chat?.type!=="private" || from?.is_bot || !validId(from?.id) || !validId(message.chat.id) || from.id!==message.chat.id)return null;
  return {telegramUser:String(from.id),chat:String(message.chat.id),message,callback};
}
async function actorFor(identity:NonNullable<ReturnType<typeof privateIdentity>>,db:Db=pool){
  return one(db,`SELECT b.*,u.username,u.role,u.active FROM telegram_bindings b JOIN users u ON u.id=b.user_id
    WHERE b.bot_key=$1 AND b.telegram_user_id=$2 AND b.chat_id=$3 AND u.active`,[botKey(),identity.telegramUser,identity.chat]);
}
/** Called only AFTER the engine's run lock (or an equivalent run lock for conversation UI). */
async function validate(db:Db,id:string,identity:NonNullable<ReturnType<typeof privateIdentity>>,expectedUser:number){
  const actor=await one(db,`SELECT b.*,u.username,u.role FROM telegram_bindings b JOIN users u ON u.id=b.user_id AND u.active
    WHERE b.user_id=$1 AND b.bot_key=$2 AND b.telegram_user_id=$3 AND b.chat_id=$4 FOR UPDATE OF b`,[expectedUser,botKey(),identity.telegramUser,identity.chat]);
  if(!actor || !(await preferences(expectedUser,db)).interactive || config.telegram.mode==="off")throw new HttpError(403,denied);
  const a=await one(db,"SELECT *,expires_at>now() AS fresh FROM telegram_actions WHERE action_id=$1 FOR UPDATE",[id]);
  if(!a || a.bot_key!==botKey() || a.user_id!==expectedUser || a.chat_id!==identity.chat || a.telegram_user_id!==identity.telegramUser || !a.fresh || a.status!=="pending")throw new HttpError(409,denied);
  if(identity.callback && Number(a.message_id)!==identity.message.message_id)throw new HttpError(403,denied);
  const run=await one(db,"SELECT * FROM workflow_runs WHERE id=$1",[a.run_id]);
  await requireOwner({id:actor.user_id,username:actor.username,role:actor.role,active:true} as any,run?.owner_id??null,false,"run",String(a.run_id));
  if(!run || !["RUNNING","WAITING","PAUSED"].includes(run.status))throw new HttpError(409,denied);
  const step=await one(db,"SELECT * FROM workflow_steps WHERE id=$1 AND run_id=$2",[a.step_id,a.run_id]);
  if(!step || step.generation!==a.step_generation || step.current_attempt_id!==a.attempt_id || step.pending_input?.provider_handoff)throw new HttpError(409,denied);
  const question=a.question_id?await one(db,"SELECT * FROM workflow_questions WHERE id=$1 AND run_id=$2 AND step_id=$3 AND attempt_id IS NOT DISTINCT FROM $4",[a.question_id,a.run_id,a.step_id,a.attempt_id]):null;
  if(a.question_id ? step.status!=="WAITING_INPUT" || question?.status!=="open" : step.status!=="WAITING_APPROVAL")throw new HttpError(409,denied);
  if(!a.question_id && (step.config.select_repositories || step.config.ask_branch))throw new HttpError(409,"This approval needs the run form");
  if(a.context_hash!==contextHash(step,question) || !a.question_id && step.approval?.generation!==step.generation)throw new HttpError(409,denied);
  if(["answer","confirm_answer"].includes(a.action_type) && (!Array.isArray(question.options) || !question.options.includes(a.option_value)))throw new HttpError(409,denied);
  return {a,actor,step,question};
}
async function consume(id:string,identity:NonNullable<ReturnType<typeof privateIdentity>>,userId:number,answer?:string){
  const action=await one(pool,"SELECT * FROM telegram_actions WHERE action_id=$1",[id]);
  if(!action)throw new HttpError(409,denied);
  const byUser=await one(pool,"SELECT username FROM users WHERE id=$1 AND active",[userId]);
  if(!byUser)throw new HttpError(403,denied);
  const by=`${byUser.username} (#${userId}; Telegram)`;
  const guard=async(db:Db)=>{
    const {a,actor,step,question}=await validate(db,id,identity,userId);
    if(a.action_type!==action.action_type)throw new HttpError(409,denied);
    if(["reject","reply"].includes(a.action_type)){
      const conversation=await one(db,"SELECT * FROM telegram_conversations WHERE action_id=$1 AND status='pending' AND expires_at>now() FOR UPDATE",[id]);
      if(!conversation || Number(conversation.prompt_message_id)!==identity.message.reply_to_message?.message_id || !answer?.trim() || answer.length>4000)throw new HttpError(400,"Reply to the specific prompt with a non-empty answer (max 4000 characters)");
      if(a.action_type==="reply" && Array.isArray(question.options) && question.options.length && !question.options.includes(answer))throw new HttpError(400,"Select a valid option");
      await q(db,"UPDATE telegram_conversations SET status='completed' WHERE action_id=$1",[id]);
      await queue(db,`prompt_done:${id}`,"editMessageText",{chat_id:a.chat_id,message_id:conversation.prompt_message_id,text:a.locale==="en"?"Response saved.":"Đã lưu phản hồi.",reply_markup:{inline_keyboard:[]}},[id]);
    }
    if(a.action_type==="answer" && a.requires_confirmation || a.action_type==="approve" && a.option_value==="confirm")throw new HttpError(409,"Confirmation required");
    await q(db,"UPDATE telegram_actions SET status=CASE WHEN action_id=$1 THEN 'consumed' ELSE 'canceled' END,consumed_at=CASE WHEN action_id=$1 THEN now() ELSE consumed_at END WHERE bot_key=$2 AND step_id=$3 AND step_generation=$4 AND question_id IS NOT DISTINCT FROM $5 AND status='pending'",[id,botKey(),a.step_id,a.step_generation,a.question_id]);
    await telegramAudit(db,userId,"action.applied",id,{type:a.action_type,runId:a.run_id,stepId:a.step_id,questionId:a.question_id});
    await runEvents.add(db,a.run_id,"user",`Telegram ${a.action_type} decision by ${actor.username} (#${userId})`,a.step_id,a.attempt_id,{telegram_action_id:id,actor_id:userId});
    const label=a.action_type==="reject"?(a.locale==="en"?"❌ Rejected":"❌ Đã từ chối"):question?(a.locale==="en"?"✅ Answer saved":"✅ Đã lưu câu trả lời"):(a.locale==="en"?"✅ Approved":"✅ Đã duyệt");
    await decisionMessage(db,{...a,step_key:step.key},label);
  };
  await execution.run({userId,kind:"user"},async()=>{
    const step=await one(pool,"SELECT key FROM workflow_steps WHERE id=$1",[action.step_id]);
    if(!step)throw new HttpError(409,denied);
    if(["approve","confirm_approve"].includes(action.action_type))await approveStep(action.run_id,step.key,{by,guard});
    else if(action.action_type==="reject")await rejectStep(action.run_id,step.key,{by,comment:answer!,guard});
    else if(["answer","confirm_answer","reply"].includes(action.action_type))await answerQuestions({[action.question_id]:["answer","confirm_answer"].includes(action.action_type)?action.option_value:answer!},by,guard);
    else throw new HttpError(409,denied);
  });
}
async function prompt(id:string,identity:NonNullable<ReturnType<typeof privateIdentity>>,userId:number){
  await withTx(async db=>{
    const original=await one(db,"SELECT run_id FROM telegram_actions WHERE action_id=$1",[id]);
    if(!original)throw new HttpError(409,denied);
    await q(db,"SELECT id FROM workflow_runs WHERE id=$1 FOR UPDATE",[original.run_id]);
    const {a,question,step}=await validate(db,id,identity,userId),en=a.locale==="en";
    if(a.action_type==="approve" && a.option_value==="confirm" || a.action_type==="answer" && a.requires_confirmation){
      await q(db,"UPDATE telegram_actions SET status='consumed',consumed_at=now() WHERE action_id=$1",[id]);
      const buttons=[await makeAction(db,a,a.action_type==="answer"?"confirm_answer":"confirm_approve",a.option_value),await makeAction(db,a,"cancel")];
      await queue(db,`confirm:${id}`,"editMessageText",{chat_id:a.chat_id,message_id:a.message_id,text:en?`Confirm ${a.question_id?"answer":"approval"} for Run #${a.run_id}${a.question_id?`: ${textLimit(safeTelegramText(a.option_value),120)}`:""}?`:`Xác nhận ${a.question_id?"trả lời":"duyệt"} Run #${a.run_id}${a.question_id?`: ${textLimit(safeTelegramText(a.option_value),120)}`:""}?`,reply_markup:{inline_keyboard:[buttons]}},buttons.map(b=>b.callback_data.slice(2)));
    }else if(a.action_type==="cancel"){
      await q(db,"UPDATE telegram_actions SET status='canceled' WHERE step_id=$1 AND step_generation=$2 AND question_id IS NOT DISTINCT FROM $3 AND status='pending'",[a.step_id,a.step_generation,a.question_id]);
      await queue(db,`cancel:${id}`,"editMessageText",{chat_id:a.chat_id,message_id:a.message_id,text:en?"Canceled. No workflow decision was recorded. Open the run to continue.":"Đã hủy. Chưa ghi quyết định workflow. Mở run để tiếp tục.",reply_markup:{inline_keyboard:[]}},[id]);
    }else{
      if(!await one(db,"INSERT INTO telegram_conversations(action_id) VALUES($1) ON CONFLICT(action_id) DO UPDATE SET status='pending',prompt_message_id=NULL,expires_at=now()+interval '15 minutes' WHERE telegram_conversations.status<>'pending' OR telegram_conversations.expires_at<=now() RETURNING action_id",[id])){await telegramAudit(db,userId,"action.prompt_replayed",id);return;}
      const context=textLimit(safeTelegramText(question?.question??step.name),180);
      const text=`${context}\n`+(a.action_type==="reject"?(en?`Run #${a.run_id}: reply to this message with a reason to CONFIRM rejection. /cancel to cancel.`:`Run #${a.run_id}: trả lời tin nhắn này với lý do để XÁC NHẬN từ chối. /cancel để hủy.`):(en?`Run #${a.run_id}: reply to this specific message with your answer. /cancel to cancel.`:`Run #${a.run_id}: trả lời đúng tin nhắn này với câu trả lời. /cancel để hủy.`));
      await queue(db,`prompt:${id}:${opaqueId()}`,"sendMessage",{chat_id:a.chat_id,text,reply_markup:{force_reply:true,selective:true}},[id],id);
    }
    await telegramAudit(db,userId,"action.prompted",id,{type:a.action_type});
  });
}
async function handleUpdate(update:any,retry=false){
  const identity=privateIdentity(update),callback=update.callback_query;
  let result="Saved / Đã lưu",actorId:number|null=null,actionId="";
  try{
    if(!identity)throw new HttpError(403,denied);
    if(!retry && !await limited(identity.telegramUser))throw new HttpError(429,"Too many requests / Quá nhiều yêu cầu");
    const actor=await actorFor(identity);actorId=actor?.user_id??null;
    if(callback){
      if(typeof callback.data!=="string" || !/^a:[A-Za-z0-9_-]{24}$/.test(callback.data) || !actor)throw new HttpError(403,denied);
      actionId=callback.data.slice(2);
      const a=await one(pool,"SELECT * FROM telegram_actions WHERE action_id=$1",[actionId]);
      if(!a || a.user_id!==actorId)throw new HttpError(403,denied);
      if(["reject","reply","cancel"].includes(a.action_type) || a.action_type==="approve" && a.option_value==="confirm" || a.action_type==="answer" && a.requires_confirmation){
        await prompt(actionId,identity,actorId!);result="Follow the prompt / Làm theo hướng dẫn";
      }else await consume(actionId,identity,actorId!);
    }else{
      const text=String(identity.message.text??"").trim();
      const start=/^\/start(?:@[A-Za-z0-9_]+)? bind_([A-Za-z0-9_-]{24})$/.exec(text);
      if(start){await bindFromStart(start[1],identity.telegramUser,identity.chat);return;}
      if(!actor)throw new HttpError(403,denied);
      if(/^\/cancel(?:@[A-Za-z0-9_]+)?$/.test(text)){
        await withTx(async db=>{
          await q(db,`UPDATE telegram_conversations c SET status='canceled' FROM telegram_actions a
            WHERE c.action_id=a.action_id AND a.user_id=$1 AND a.bot_key=$2 AND c.status='pending'
            AND ($3::bigint IS NULL OR c.prompt_message_id=$3)`,[actorId,botKey(),identity.message.reply_to_message?.message_id??null]);
          await telegramAudit(db,actorId,"conversation.canceled",String(actorId));
          await queue(db,`cancel_reply:${update.update_id}`,"sendMessage",{chat_id:identity.chat,text:"Canceled / Đã hủy. No workflow decision changed."});
        });return;
      }
      const conversation=await one(pool,`SELECT a.action_id FROM telegram_conversations c JOIN telegram_actions a ON a.action_id=c.action_id
        WHERE c.prompt_message_id=$1 AND a.bot_key=$2 AND a.user_id=$3 AND a.telegram_user_id=$4 AND a.chat_id=$5 AND c.status='pending' AND c.expires_at>now()`,[identity.message.reply_to_message?.message_id??null,botKey(),actorId,identity.telegramUser,identity.chat]);
      if(!conversation)throw new HttpError(409,"Reply to the specific question prompt / Hãy trả lời đúng tin nhắn câu hỏi");
      actionId=conversation.action_id;await consume(actionId,identity,actorId!,text);
      return;
    }
  }catch(e){
    // txThenRun may commit and then fail while reading the refreshed run. Registry is the source of truth.
    const committed=actionId && await one(pool,"SELECT status FROM telegram_actions WHERE action_id=$1 AND user_id=$2",[actionId,actorId]);
    if(committed && committed.status==="consumed"){result="Already processed / Đã xử lý";await telegramAudit(pool,actorId,"action.replayed",actionId,{updateId:update.update_id});}
    else{
      const status=(e as any).code==="23505"?409:Number((e as any).status)||500;
      result=status===429?"Too many requests / Quá nhiều yêu cầu":denied;
      await telegramAudit(pool,actorId,"action.denied",actionId||"update",{updateId:update.update_id,status,telegramUser:identity?.telegramUser??null});
      if(status>=500){result="Temporarily unavailable; retry / Tạm thời lỗi; hãy thử lại";throw e;}
      if(!callback && identity)await queue(pool,`notice:${update.update_id}`,"sendMessage",{chat_id:identity.chat,text:result});
    }
  }finally{
    if(callback && typeof callback.id==="string"){
      const answer={callback_query_id:callback.id,text:textLimit(result,190),show_alert:result===denied};
      try{await queue(pool,`ack:${callback.id}`,"answerCallbackQuery",answer);}
      catch{await telegramCall("answerCallbackQuery",{...answer,text:"Temporarily unavailable; retry / Tạm thời lỗi; hãy thử lại",show_alert:true}).catch(()=>{});throw new HttpError(503,"Telegram response persistence unavailable");}
    }
  }
}
/** Trusted transports persist first. The HTTP route never accepts unauthenticated updates. */
export async function ingestUpdate(update:any,key=botKey()){
  if(!Number.isSafeInteger(update?.update_id) || update.update_id<0 || typeof update!=="object")throw new HttpError(400,"Invalid Telegram update");
  await q(pool,"INSERT INTO telegram_updates(bot_key,update_id,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[key,update.update_id,JSON.stringify(update)]);
}
export async function processInbox(limit=50){
  for(let i=0;i<limit;i++){
    const token=opaqueId(),key=botKey();
    const current=await one(pool,`UPDATE telegram_updates SET processing_token=$2,processing_until=now()+interval '30 seconds'
      WHERE (bot_key,update_id)=(SELECT bot_key,update_id FROM telegram_updates WHERE bot_key=$1 AND processed_at IS NULL
        AND next_at<=now() AND (processing_until IS NULL OR processing_until<now()) ORDER BY update_id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`,[key,token]);
    if(!current)break;
    try{
      await handleUpdate(current.payload,current.failures>0);
      await q(pool,"UPDATE telegram_updates SET processed_at=now(),processing_token=NULL,processing_until=NULL WHERE bot_key=$1 AND update_id=$2 AND processing_token=$3",[key,current.update_id,token]);
    }catch{
      await q(pool,"UPDATE telegram_updates SET failures=failures+1,next_at=now()+interval '5 seconds',processing_token=NULL,processing_until=NULL WHERE bot_key=$1 AND update_id=$2 AND processing_token=$3",[key,current.update_id,token]);
    }
  }
}
