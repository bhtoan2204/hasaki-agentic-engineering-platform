import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { createUser, type PublicUser } from "../src/auth/users.ts";
import { getUserSecret } from "../src/auth/secrets.ts";
import { registerInstance } from "../src/instances.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { startRun, beginAttempt, finishAttempt, cancelRun } from "../src/workflow/engine.ts";
import { claimJob } from "../src/workflow/scheduler.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { createBinding, disconnect, savePreferences, bindingStatus, preferences } from "../src/telegram/store.ts";
import { botKey } from "../src/telegram/client.ts";
import { ingestUpdate, processInbox } from "../src/telegram/updates.ts";
import { deliverOutbox, expireActions, claimConsumer, releaseConsumer, persistPollingBatch, startTelegramTransport } from "../src/telegram/transport.ts";
import { handle } from "../src/http/app.ts";
let owner:PublicUser,other:PublicUser,bot:Server,http:Server,base:string;
const calls:any[]=[],pollUpdates:any[]=[];let messageId=100,updateId=1000,sequence=0,failMethod="",failCount=0;
const TOKEN="12345:TEST_PRIVATE_TOKEN_never_log_this";
function message(user:number,text:string,replyTo?:number){return {update_id:++updateId,message:{message_id:++messageId,from:{id:user,is_bot:false},chat:{id:user,type:"private"},text,...(replyTo?{reply_to_message:{message_id:replyTo}}:{})}};}
function callback(a:any,user=101,chat=user){return {update_id:++updateId,callback_query:{id:`cb-${updateId}`,data:`a:${a.action_id}`,from:{id:user,is_bot:false},message:{message_id:a.message_id,chat:{id:chat,type:"private"}}}};}
async function pump(update:any){await ingestUpdate(update);await processInbox();await settleBackground();await deliverOutbox();}
async function bind(user:PublicUser,id:number){const link=await createBinding(user.id);const token=new URL(link.url).searchParams.get("start")!;await pump(message(id,`/start ${token}`));return link;}
async function gate(extra:Record<string,unknown>={},user=owner){
 const key=`tg-gate-${++sequence}`;await definitions.create({key,spec:{name:key,steps:[{key:"gate",type:"command",requires_approval:true,config:{command:"true",...extra}}]}});
 const run=await startRun({definitionKey:key,title:"Private approval password=do-not-send-this",ownerId:user.id});await settleBackground();await deliverOutbox();
 return {run,step:(await one(pool,"SELECT * FROM workflow_steps WHERE run_id=$1",[run.id]))!};
}
async function action(runId:number,type:string,questionId?:number){return (await one(pool,`SELECT * FROM telegram_actions WHERE run_id=$1 AND action_type=$2 AND ($3::bigint IS NULL OR question_id=$3) ORDER BY created_at DESC LIMIT 1`,[runId,type,questionId??null]))!;}
async function waitingQuestions(options:string[][]=[['Balance','Bank transfer'],[]],extra:Record<string,unknown>={}){
 const key=`tg-questions-${++sequence}`;await definitions.create({key,spec:{name:key,steps:[{key:"ask",type:"human_input",config:extra}]}});
 const run=await startRun({definitionKey:key,title:"Refund choice",ownerId:owner.id});
 const job=(await claimJob("tg-test",30,["human_input"]))!;assert.equal(job.run_id,run.id);
 const begun=(await beginAttempt(job,"tg-test"))!;assert.ok(begun);
 await finishAttempt(job.id,job.fencing_token,begun.attempt.id,{kind:"waiting_input",questions:options.map((values,i)=>({question:`Refund question ${i+1}?`,options:values}))});
 await settleBackground();await deliverOutbox();
 return {run,step:(await one(pool,"SELECT * FROM workflow_steps WHERE run_id=$1",[run.id]))!,questions:await q(pool,"SELECT * FROM workflow_questions WHERE run_id=$1 ORDER BY id",[run.id])};
}
before(async()=>{
 await migrate();await registerInstance();
 owner=await createUser({username:"tg-owner",password:"telegram-test-password",role:"member"});other=await createUser({username:"tg-admin",password:"telegram-test-password",role:"admin"});
 bot=createServer(async(req,res)=>{
  let raw="";for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw||"{}");const method=req.url!.split("/").at(-1)!;calls.push({method,body});
  if(method===failMethod && failCount-->0){res.writeHead(503,{"Content-Type":"application/json"}).end(JSON.stringify({ok:false,error_code:503,description:`secret ${TOKEN}`}));return;}
  const result=method==="getMe"?{id:12345,username:"hasaki_test_bot"}:method==="getWebhookInfo"?{url:""}:method==="getUpdates"?pollUpdates.splice(0):method==="sendMessage"?{message_id:++messageId}:true;
  res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({ok:true,result}));
 });await new Promise<void>(r=>bot.listen(0,"127.0.0.1",r));
 Object.assign(config.telegram,{botToken:TOKEN,apiBase:`http://127.0.0.1:${(bot.address() as any).port}`,mode:"polling",webhookSecret:"telegram-webhook-secret-123456789",webhookUrl:"https://platform.example/api/telegram/webhook"});config.publicUrl="https://platform.example";
 http=createServer(handle);await new Promise<void>(r=>http.listen(0,"127.0.0.1",r));base=`http://127.0.0.1:${(http.address() as any).port}`;
 await bind(owner,101);await bind(other,202);
});
beforeEach(async()=>{
 failMethod="";failCount=0;config.telegram.mode="polling";
 await q(pool,"DELETE FROM telegram_rate_limits");
 await savePreferences(owner.id,{approvals:true,questions:true,failures:true,completions:true,interactive:true,locale:"en"});
});
after(async()=>{await settleBackground();await new Promise<void>(r=>http.close(()=>r()));await new Promise<void>(r=>bot.close(()=>r()));await pool.end();});

test("explicit binding is hashed, private, single-use, expiring and unique across platform accounts",async()=>{
 assert.equal((await bindingStatus(owner.id)).binding!.telegram_user_id,"101");assert.equal(await getUserSecret(owner.id,"telegram_chat"),"101");
 const third=await createUser({username:"tg-third",password:"telegram-test-password",role:"member"});const link=await createBinding(third.id),start=new URL(link.url).searchParams.get("start")!;
 assert.ok(!JSON.stringify(await q(pool,"SELECT * FROM telegram_bind_tokens")).includes(start.slice(5)),"only token hashes stored");
 await pump(message(101,`/start ${start}`));assert.equal((await bindingStatus(third.id)).binding,null,"one Telegram account cannot bind a second platform user");
 const group=message(303,`/start ${start}`);group.message.chat.type="group";await pump(group);assert.equal((await bindingStatus(third.id)).binding,null);
 await pump(message(303,`/start ${start}`));assert.equal((await bindingStatus(third.id)).binding!.telegram_user_id,"303");
 await pump(message(404,`/start ${start}`));assert.equal((await bindingStatus(third.id)).binding!.telegram_user_id,"303","single-use link cannot replace binding");
 await disconnect(third.id);const expired=await createBinding(third.id);await q(pool,"UPDATE telegram_bind_tokens SET expires_at=now()-interval '1 second' WHERE user_id=$1",[third.id]);await pump(message(303,`/start ${new URL(expired.url).searchParams.get('start')}`));assert.equal((await bindingStatus(third.id)).binding,null);
});
test("valid approval uses the existing engine once, edits its message after commit, and records the real owner",async()=>{
 const {run}=await gate();const a=await action(run.id,"approve");assert.ok(a?.message_id);
 const sent=calls.find(c=>c.method==="sendMessage" && c.body.text?.includes(`Run: #${run.id}`));assert.ok(sent);assert.equal(sent.body.chat_id,"101");assert.ok(!sent.body.text.includes("do-not-send-this"));
 for(const b of sent.body.reply_markup.inline_keyboard.flat().filter((b:any)=>b.callback_data)){assert.ok(Buffer.byteLength(b.callback_data)<=64);assert.match(b.callback_data,/^a:[A-Za-z0-9_-]{24}$/);assert.ok(!b.callback_data.includes("gate"));}
 await pump(callback(a));assert.equal((await one(pool,"SELECT status,approval FROM workflow_steps WHERE run_id=$1",[run.id]))!.status,"READY");
 assert.match((await one(pool,"SELECT approval FROM workflow_steps WHERE run_id=$1",[run.id]))!.approval.by,/tg-owner.*Telegram/);
 assert.equal((await one(pool,"SELECT count(*)::int AS n FROM workflow_events WHERE run_id=$1 AND content LIKE '%WAITING_APPROVAL → READY%'",[run.id]))!.n,1);
 assert.ok(calls.some(c=>c.method==="editMessageText" && c.body.message_id===a.message_id && c.body.text.includes("Approved")));
 assert.equal((await one(pool,"SELECT count(*)::int AS n FROM audit_log WHERE actor_id=$1 AND action='telegram.action.applied' AND resource_id=$2",[owner.id,a.action_id]))!.n,1);
});
test("duplicate updates, replayed buttons and concurrent consumers cannot approve twice",async()=>{
 const {run}=await gate();const a=await action(run.id,"approve"),first=callback(a),second=callback(a);
 await ingestUpdate(first);await ingestUpdate(first);await ingestUpdate(second);await Promise.all([processInbox(1),processInbox(2)]);await processInbox();await deliverOutbox();await pump(callback(a));
 assert.equal((await one(pool,"SELECT count(*)::int AS n FROM workflow_events WHERE run_id=$1 AND content LIKE '%WAITING_APPROVAL → READY%'",[run.id]))!.n,1);
 assert.equal((await one(pool,"SELECT count(*)::int AS n FROM telegram_actions WHERE run_id=$1 AND status='consumed'",[run.id]))!.n,1);
 assert.equal((await one(pool,"SELECT count(*)::int AS n FROM telegram_updates WHERE update_id=$1",[first.update_id]))!.n,1);
 for(const update of [first,second])assert.ok(calls.some(c=>c.method==="answerCallbackQuery" && c.body.callback_query_id===update.callback_query.id));
});
test("invalid, wrong-user (including admin), wrong-chat, group and wrong-message callbacks never mutate a run",async()=>{
 const {run}=await gate();const a=await action(run.id,"approve");
 const updates=[callback({...a,action_id:"unknown"}),callback(a,202),callback(a,101,999),callback({...a,message_id:a.message_id+999})];const group=callback(a);group.callback_query.message.chat.type="group";updates.push(group);
 for(const update of updates)await pump(update);
 assert.equal((await one(pool,"SELECT status FROM workflow_steps WHERE run_id=$1",[run.id]))!.status,"WAITING_APPROVAL");
 for(const u of updates)assert.ok(calls.some(c=>c.method==="answerCallbackQuery"&&c.body.callback_query_id===u.callback_query.id));
});
test("expired actions, stale generations, canceled runs and disabled/deactivated accounts are rejected",async()=>{
 for(const kind of ["expired","generation","canceled","disabled","inactive"]){
  const {run}=await gate();const a=await action(run.id,"approve");
  if(kind==="expired")await q(pool,"UPDATE telegram_actions SET expires_at=now()-interval '1 second' WHERE run_id=$1",[run.id]);
  if(kind==="generation")await q(pool,"UPDATE workflow_steps SET generation=generation+1 WHERE run_id=$1",[run.id]);
  if(kind==="canceled")await cancelRun(run.id);
  if(kind==="disabled")await savePreferences(owner.id,{interactive:false});
  if(kind==="inactive")await q(pool,"UPDATE users SET active=false WHERE id=$1",[owner.id]);
  await pump(callback(a));assert.notEqual((await one(pool,"SELECT status FROM workflow_steps WHERE run_id=$1",[run.id]))!.status,"READY",kind);
  await q(pool,"UPDATE users SET active=true WHERE id=$1",[owner.id]);await savePreferences(owner.id,{interactive:true});
 }
 await expireActions();await deliverOutbox();assert.ok(calls.some(c=>c.method==="editMessageReplyMarkup"));
});
test("rejection requires a specific ForceReply reason and preserves on_reject reexecution policy",async()=>{
 const key=`tg-reject-${++sequence}`;await definitions.create({key,spec:{name:key,steps:[{key:"prepare",type:"condition",config:{path:"inputs.ready"}},{key:"review",type:"human_approval",depends_on:["prepare"],requires_approval:true,config:{on_reject:{reexecute:"prepare"}}}]}});
 const run=await startRun({definitionKey:key,title:"Reject review",ownerId:owner.id});const job=(await claimJob("tg-test",30,["condition"]))!;const begun=(await beginAttempt(job,"tg-test"))!;await finishAttempt(job.id,job.fencing_token,begun.attempt.id,{kind:"completed",output:{}});await settleBackground();await deliverOutbox();
 const a=await action(run.id,"reject");await pump(callback(a));const c=(await one(pool,"SELECT * FROM telegram_conversations WHERE action_id=$1",[a.action_id]))!;assert.ok(c.prompt_message_id);
 await pump(message(101,"Wrong review evidence",c.prompt_message_id));
 const rows=await q(pool,"SELECT key,status,generation FROM workflow_steps WHERE run_id=$1 ORDER BY position",[run.id]);assert.equal(rows[0].status,"READY");assert.equal(rows[0].generation,2);assert.equal(rows[1].status,"PENDING");assert.match((await one(pool,"SELECT content FROM workflow_events WHERE run_id=$1 AND content LIKE 'rejected review%'",[run.id]))!.content,/Wrong review evidence/);
});
test("predefined and free-text questions keep exact IDs, real answered_by, and wait for all required answers",async()=>{
 const {run,questions}=await waitingQuestions();const choice=await action(run.id,"answer",questions[0].id);assert.equal(choice.option_value,"Balance");
 await pump(callback(choice));assert.equal((await one(pool,"SELECT status FROM workflow_steps WHERE run_id=$1",[run.id]))!.status,"WAITING_INPUT");
 const reply=await action(run.id,"reply",questions[1].id);await pump(callback(reply));const conversation=(await one(pool,"SELECT * FROM telegram_conversations WHERE action_id=$1",[reply.action_id]))!;
 await pump(message(101,"Do not attach an unrelated message"));assert.equal((await one(pool,"SELECT status FROM workflow_questions WHERE id=$1",[questions[1].id]))!.status,"open");
 await pump(message(101,"Refund to the original payer",conversation.prompt_message_id));const answered=await q(pool,"SELECT * FROM workflow_questions WHERE run_id=$1 ORDER BY id",[run.id]);assert.equal(answered[0].answer,"Balance");assert.equal(answered[1].answer,"Refund to the original payer");assert.ok(answered.every(q=>q.answered_by.includes(`tg-owner (#${owner.id}; Telegram)`)));
 assert.equal((await one(pool,"SELECT status FROM workflow_steps WHERE run_id=$1",[run.id]))!.status,"COMPLETED");
});
test("simultaneous free-text prompts, cancellation and expiration cannot cross-associate runs",async()=>{
 const first=await waitingQuestions([[]]),second=await waitingQuestions([[]]);const a=await action(first.run.id,"reply"),b=await action(second.run.id,"reply");await pump(callback(a));await pump(callback(b));
 const ca=(await one(pool,"SELECT * FROM telegram_conversations WHERE action_id=$1",[a.action_id]))!,cb=(await one(pool,"SELECT * FROM telegram_conversations WHERE action_id=$1",[b.action_id]))!;
 await pump(message(101,"second only",cb.prompt_message_id));assert.equal((await one(pool,"SELECT status FROM workflow_questions WHERE id=$1",[first.questions[0].id]))!.status,"open");assert.equal((await one(pool,"SELECT answer FROM workflow_questions WHERE id=$1",[second.questions[0].id]))!.answer,"second only");
 await pump(message(101,"/cancel",ca.prompt_message_id));await pump(message(101,"too late",ca.prompt_message_id));assert.equal((await one(pool,"SELECT status FROM workflow_questions WHERE id=$1",[first.questions[0].id]))!.status,"open");
 const third=await waitingQuestions([[]]);const c=await action(third.run.id,"reply");await pump(callback(c));const cc=(await one(pool,"SELECT * FROM telegram_conversations WHERE action_id=$1",[c.action_id]))!;await q(pool,"UPDATE telegram_conversations SET expires_at=now()-interval '1 second' WHERE action_id=$1",[c.action_id]);await pump(message(101,"expired",cc.prompt_message_id));assert.equal((await one(pool,"SELECT status FROM workflow_questions WHERE id=$1",[third.questions[0].id]))!.status,"open");
});
test("high-impact approvals require confirmation; provider handoffs remain fenced and link-only",async()=>{
 const {run}=await gate({high_impact:true});const a=await action(run.id,"approve");await pump(callback(a));assert.equal((await one(pool,"SELECT status FROM workflow_steps WHERE run_id=$1",[run.id]))!.status,"WAITING_APPROVAL");const confirm=await action(run.id,"confirm_approve");await pump(callback(confirm));assert.equal((await one(pool,"SELECT status FROM workflow_steps WHERE run_id=$1",[run.id]))!.status,"READY");
 const pending=await waitingQuestions([['Continue','Stop']]);const option=await action(pending.run.id,"answer");await q(pool,"UPDATE workflow_steps SET pending_input=$2 WHERE run_id=$1",[pending.run.id,JSON.stringify({provider_handoff:{id:123}})]);await pump(callback(option));assert.equal((await one(pool,"SELECT status FROM workflow_questions WHERE id=$1",[pending.questions[0].id]))!.status,"open");
});
test("engine failure rolls back action consumption, audit, decision edit and workflow transition together",async()=>{
 const {run,step}=await gate();const a=await action(run.id,"approve");
 await pool.query(`CREATE FUNCTION tg_fail_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=${Number(step.id)} AND NEW.status='READY' THEN RAISE EXCEPTION 'simulated engine outage'; END IF; RETURN NEW; END $$;CREATE TRIGGER tg_fail_transition BEFORE UPDATE ON workflow_steps FOR EACH ROW EXECUTE FUNCTION tg_fail_transition()`);
 const update=callback(a);await pump(update);assert.equal((await one(pool,"SELECT status FROM telegram_actions WHERE action_id=$1",[a.action_id]))!.status,"pending");assert.equal((await one(pool,"SELECT status FROM workflow_steps WHERE id=$1",[step.id]))!.status,"WAITING_APPROVAL");assert.equal((await one(pool,"SELECT count(*)::int AS n FROM telegram_outbox WHERE dedupe_key=$1",[`decision:${a.action_id}`]))!.n,0);
 await pool.query("DROP TRIGGER tg_fail_transition ON workflow_steps;DROP FUNCTION tg_fail_transition()");await q(pool,"UPDATE telegram_updates SET next_at=now() WHERE update_id=$1",[update.update_id]);await processInbox();await deliverOutbox();assert.equal((await one(pool,"SELECT status FROM workflow_steps WHERE id=$1",[step.id]))!.status,"READY");
});
test("Telegram network failure retains delivery for retry and never re-executes a committed approval",async()=>{
 const {run}=await gate();const a=await action(run.id,"approve");failMethod="editMessageText";failCount=1;await pump(callback(a));assert.equal((await one(pool,"SELECT status FROM workflow_steps WHERE run_id=$1",[run.id]))!.status,"READY");assert.equal((await one(pool,"SELECT status FROM telegram_outbox WHERE dedupe_key=$1",[`decision:${a.action_id}`]))!.status,"pending");await q(pool,"UPDATE telegram_outbox SET next_at=now() WHERE dedupe_key=$1",[`decision:${a.action_id}`]);await deliverOutbox();assert.equal((await one(pool,"SELECT status FROM telegram_outbox WHERE dedupe_key=$1",[`decision:${a.action_id}`]))!.status,"delivered");
});
test("PostgreSQL consumer ownership, crash takeover, fencing and offset recovery work across instances",async()=>{
 const c1=await pool.connect(),c2=await pool.connect();const key=botKey();const claim=await claimConsumer(c1,"instance-a","polling");assert.ok(claim);assert.equal(await claimConsumer(c2,"instance-b","polling"),null);
 const update=message(999,"/start");await persistPollingBatch([update],"instance-a",claim.epoch);assert.equal((await one(pool,"SELECT update_offset FROM telegram_consumers WHERE bot_key=$1",[key]))!.update_offset,update.update_id+1);
 c1.release(true);await new Promise(r=>setTimeout(r,20));await q(pool,"UPDATE telegram_consumers SET lease_until=now()-interval '1 second' WHERE bot_key=$1",[key]);const recovered=await claimConsumer(c2,"instance-b","polling");assert.ok(recovered);assert.equal(recovered.update_offset,update.update_id+1);assert.ok(recovered.epoch>claim.epoch);await assert.rejects(persistPollingBatch([message(999,"stale")],"instance-a",claim.epoch),/ownership lost/);await releaseConsumer(c2,"instance-b");c2.release();
});
test("webhook requires its secret and active webhook mode; HTTP ingress is durable and session-independent",async()=>{
 config.telegram.mode="webhook";const c=await pool.connect();assert.ok(await claimConsumer(c,"webhook-owner","webhook"));
 const body=JSON.stringify(message(999,"/start"));assert.equal((await fetch(base+"/api/telegram/webhook",{method:"POST",body,headers:{"content-type":"application/json"}})).status,403);assert.equal((await fetch(base+"/api/telegram/webhook",{method:"POST",body,headers:{"x-telegram-bot-api-secret-token":"wrong"}})).status,403);
 const headers={"content-type":"application/json","x-telegram-bot-api-secret-token":config.telegram.webhookSecret};assert.equal((await fetch(base+"/api/telegram/webhook",{method:"POST",body,headers})).status,200);assert.ok(await one(pool,"SELECT update_id FROM telegram_updates WHERE update_id=$1",[JSON.parse(body).update_id]));
 config.telegram.mode="polling";assert.equal((await fetch(base+"/api/telegram/webhook",{method:"POST",body,headers})).status,403);await releaseConsumer(c,"webhook-owner");c.release();
});
test("private notification preferences, language, disconnect/rebind and rate limiting are enforced",async()=>{
 await savePreferences(owner.id,{approvals:false,locale:"vi"});const muted=await gate();assert.equal(await action(muted.run.id,"approve"),undefined);assert.equal((await preferences(owner.id)).locale,"vi");await savePreferences(owner.id,{approvals:true});const {run}=await gate();const a=await action(run.id,"approve");assert.equal(a.locale,"vi");
 await disconnect(owner.id);await pump(callback(a));assert.equal((await one(pool,"SELECT status FROM workflow_steps WHERE run_id=$1",[run.id]))!.status,"WAITING_APPROVAL");assert.equal(await getUserSecret(owner.id,"telegram_chat"),null);await bind(owner,101);
 const fresh=await gate();const button=await action(fresh.run.id,"approve");await q(pool,"INSERT INTO telegram_rate_limits(bot_key,subject,minute,hits) VALUES($1,'101',date_trunc('minute',now()),30) ON CONFLICT(bot_key,subject,minute) DO UPDATE SET hits=30",[botKey()]);await pump(callback(button));assert.equal((await one(pool,"SELECT status FROM workflow_steps WHERE run_id=$1",[fresh.run.id]))!.status,"WAITING_APPROVAL");
});
test("long-polling runtime starts, uses allowed update types and stops gracefully without a public endpoint",async()=>{
 const {run}=await gate();const a=await action(run.id,"approve");pollUpdates.push(callback(a));const transport=startTelegramTransport();
 for(let n=0;n<100 && (await one(pool,"SELECT status FROM workflow_steps WHERE run_id=$1",[run.id]))!.status!=="READY";n++)await new Promise(r=>setTimeout(r,20));
 await transport.stop();assert.equal((await one(pool,"SELECT status FROM workflow_steps WHERE run_id=$1",[run.id]))!.status,"READY");const poll=calls.find(c=>c.method==="getUpdates");assert.ok(poll);assert.deepEqual(poll.body.allowed_updates,["message","callback_query"]);assert.ok(calls.some(c=>c.method==="getWebhookInfo"));
});
test("approval context changes invalidate capabilities; worker ownership and paused-run policy are preserved",async()=>{
 const changed=await gate();const old=await action(changed.run.id,"approve");await q(pool,"UPDATE workflow_steps SET approval=approval || '{\"changed\":true}'::jsonb WHERE run_id=$1",[changed.run.id]);await pump(callback(old));assert.equal((await one(pool,"SELECT status FROM workflow_steps WHERE run_id=$1",[changed.run.id]))!.status,"WAITING_APPROVAL");
 const paused=await gate();const a=await action(paused.run.id,"approve");const { pauseRun }=await import("../src/workflow/engine.ts");await pauseRun(paused.run.id);await pump(callback(a));assert.equal((await one(pool,"SELECT status,worker_instance FROM workflow_runs WHERE id=$1",[paused.run.id]))!.status,"PAUSED");assert.equal((await one(pool,"SELECT worker_instance FROM workflow_runs WHERE id=$1",[paused.run.id]))!.worker_instance,config.instanceId);
});
test("canceled conversations can be explicitly restarted and old prompt replies stay invalid",async()=>{
 const {run,questions}=await waitingQuestions([[]]);const a=await action(run.id,"reply");await pump(callback(a));const old=(await one(pool,"SELECT prompt_message_id FROM telegram_conversations WHERE action_id=$1",[a.action_id]))!.prompt_message_id;await pump(message(101,"/cancel",old));await pump(callback(a));const fresh=(await one(pool,"SELECT prompt_message_id FROM telegram_conversations WHERE action_id=$1",[a.action_id]))!.prompt_message_id;assert.notEqual(fresh,old);await pump(message(101,"old message",old));assert.equal((await one(pool,"SELECT status FROM workflow_questions WHERE id=$1",[questions[0].id]))!.status,"open");await pump(message(101,"new message",fresh));assert.equal((await one(pool,"SELECT answer FROM workflow_questions WHERE id=$1",[questions[0].id]))!.answer,"new message");
});
test("HTTP binding/preferences remain session-and-CSRF scoped and never expose the bot token",async()=>{
 assert.equal((await fetch(base+"/api/integrations/telegram/connect",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})).status,401);
 const login=await fetch(base+"/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:owner.username,password:"telegram-test-password"})});const session=await login.json();const cookie=login.headers.get("set-cookie")!.split(";")[0];const headers={cookie,"Content-Type":"application/json","x-csrf-token":session.csrf};
 const status=await (await fetch(base+"/api/integrations/telegram",{headers})).json();assert.ok(!JSON.stringify(status).includes(TOKEN));assert.equal(status.binding.telegram_user_id,"101");assert.equal(status.canManage,false);
 assert.equal((await fetch(base+"/api/integrations/telegram/preferences",{method:"POST",headers:{cookie,"Content-Type":"application/json"},body:JSON.stringify({interactive:false})})).status,403);
 assert.equal((await fetch(base+"/api/integrations/telegram/destination",{method:"POST",headers,body:JSON.stringify({chatId:"202"})})).status,409);
 assert.equal((await fetch(base+"/api/integrations/telegram",{method:"POST",headers,body:JSON.stringify({botToken:TOKEN,chatId:"202"})})).status,403);
});
test("offline assigned workers retain queued approval without transferring ownership or bypassing fencing",async()=>{
 const {run}=await gate();const a=await action(run.id,"approve");await q(pool,"UPDATE platform_instances SET stopped_at=now() WHERE instance_id=$1",[config.instanceId]);
 try{await pump(callback(a));assert.equal((await one(pool,"SELECT status FROM workflow_steps WHERE run_id=$1",[run.id]))!.status,"READY");assert.equal((await one(pool,"SELECT worker_instance FROM workflow_runs WHERE id=$1",[run.id]))!.worker_instance,config.instanceId);assert.ok(await one(pool,"SELECT id FROM workflow_jobs WHERE run_id=$1 AND status='queued'",[run.id]));}finally{await q(pool,"UPDATE platform_instances SET stopped_at=NULL,last_seen_at=now() WHERE instance_id=$1",[config.instanceId]);}
});
test("webhook runtime registers its secret and consumes an authenticated callback end to end",async()=>{
 config.telegram.mode="webhook";const {run}=await gate();const a=await action(run.id,"approve"),update=callback(a),transport=startTelegramTransport();
 try{for(let n=0;n<100 && !calls.some(c=>c.method==="setWebhook");n++)await new Promise(r=>setTimeout(r,20));assert.ok(calls.some(c=>c.method==="setWebhook"&&c.body.secret_token===config.telegram.webhookSecret));
  const response=await fetch(base+"/api/telegram/webhook",{method:"POST",headers:{"Content-Type":"application/json","x-telegram-bot-api-secret-token":config.telegram.webhookSecret},body:JSON.stringify(update)});assert.equal(response.status,200);
  for(let n=0;n<100 && (await one(pool,"SELECT status FROM workflow_steps WHERE run_id=$1",[run.id]))!.status!=="READY";n++)await new Promise(r=>setTimeout(r,20));assert.equal((await one(pool,"SELECT status FROM workflow_steps WHERE run_id=$1",[run.id]))!.status,"READY");
 }finally{await transport.stop();}
});
test("high-impact option answers require explicit confirmation before recording or resuming",async()=>{
 const {run,questions}=await waitingQuestions([['Proceed','Stop']],{high_impact:true});const a=await action(run.id,"answer");await pump(callback(a));assert.equal((await one(pool,"SELECT status FROM workflow_questions WHERE id=$1",[questions[0].id]))!.status,"open");const confirm=await action(run.id,"confirm_answer");assert.ok(confirm);await pump(callback(confirm));assert.equal((await one(pool,"SELECT answer FROM workflow_questions WHERE id=$1",[questions[0].id]))!.answer,"Proceed");
});
test("questions with more than 20 options fall back to a ForceReply answer validated against the exact options",async()=>{
 const many=Array.from({length:25},(_,i)=>`Option ${i+1}`);const {run,questions}=await waitingQuestions([many]);
 assert.ok(!await one(pool,"SELECT 1 FROM telegram_actions WHERE run_id=$1 AND action_type='answer'",[run.id]));
 const reply=await action(run.id,"reply",questions[0].id);await pump(callback(reply));const conversation=(await one(pool,"SELECT * FROM telegram_conversations WHERE action_id=$1",[reply.action_id]))!;
 await pump(message(101,"Option 99",conversation.prompt_message_id));assert.equal((await one(pool,"SELECT status FROM workflow_questions WHERE id=$1",[questions[0].id]))!.status,"open");
 await pump(message(101,"Option 17",conversation.prompt_message_id));const answered=(await one(pool,"SELECT * FROM workflow_questions WHERE id=$1",[questions[0].id]))!;
 assert.equal(answered.status,"answered");assert.equal(answered.answer,"Option 17");
});
test("failing updates back off and dead-letter after a bounded number of attempts; group chatter is not audited",async()=>{
 const {MAX_UPDATE_FAILURES}=await import("../src/telegram/updates.ts");
 const poisoned={update_id:++updateId,message:{message_id:++messageId,from:{id:101,is_bot:false},chat:{id:101,type:"private"},text:"answer",reply_to_message:{message_id:"not-a-number"}}};
 await ingestUpdate(poisoned);await processInbox();
 let row=(await one(pool,"SELECT *,next_at>now()+interval '4 seconds' AS backed_off FROM telegram_updates WHERE update_id=$1",[poisoned.update_id]))!;
 assert.equal(row.failures,1);assert.ok(!row.processed_at);assert.equal(row.backed_off,true);
 for(let n=0;n<MAX_UPDATE_FAILURES+5 && !row.processed_at;n++){await q(pool,"UPDATE telegram_updates SET next_at=now() WHERE update_id=$1",[poisoned.update_id]);await processInbox();row=(await one(pool,"SELECT * FROM telegram_updates WHERE update_id=$1",[poisoned.update_id]))!;}
 assert.ok(row.processed_at);assert.equal(row.failures,MAX_UPDATE_FAILURES);
 assert.ok(await one(pool,"SELECT 1 FROM audit_log WHERE action='telegram.update.dead_lettered' AND resource_id=$1",[String(poisoned.update_id)]));
 const group={update_id:++updateId,message:{message_id:++messageId,from:{id:101,is_bot:false},chat:{id:-500,type:"group",title:"Team"},text:"hello team"}};
 const sent=calls.length;await pump(group);
 assert.ok((await one(pool,"SELECT processed_at FROM telegram_updates WHERE update_id=$1",[group.update_id]))!.processed_at);
 assert.ok(!await one(pool,"SELECT 1 FROM audit_log WHERE detail->>'updateId'=$1",[String(group.update_id)]));
 assert.equal(calls.slice(sent).filter(c=>c.method==="sendMessage").length,0);
});
test("receiver status reflects the shared lease; failures are reported without credentials",async()=>{
 const {consumerFailure}=await import("../src/telegram/transport.ts");const {TelegramApiError}=await import("../src/telegram/client.ts");
 assert.equal((await bindingStatus(owner.id)).receiver.active,false);
 const client=await pool.connect();
 try{assert.ok(await claimConsumer(client,"status-owner","polling"));assert.equal((await bindingStatus(owner.id)).receiver.active,true);}
 finally{await releaseConsumer(client,"status-owner");client.release();}
 assert.equal((await bindingStatus(owner.id)).receiver.active,false);
 config.telegram.mode="off";assert.deepEqual((await bindingStatus(owner.id)).receiver,{active:false,mode:null});config.telegram.mode="polling";
 const leaked=consumerFailure(new Error(`request to https://api.telegram.org/bot${TOKEN}/getUpdates failed`));assert.ok(!leaked.includes(TOKEN));assert.ok(!leaked.includes("TEST_PRIVATE_TOKEN"));
 assert.match(consumerFailure(new TelegramApiError(401)),/token rejected/);assert.match(consumerFailure(new TelegramApiError(409)),/another getUpdates\/webhook consumer/);
 assert.match(consumerFailure(new Error("Remove the existing Telegram webhook before enabling polling")),/Remove the existing Telegram webhook/);
});
test("administrator-managed credentials saved on another instance reach this receiver without a restart",async()=>{
 const {refreshTelegramSettings}=await import("../src/integrations/accounts.ts");const {putSharedSecret}=await import("../src/auth/secrets.ts");
 try{
  assert.equal(await refreshTelegramSettings(),false);
  await putSharedSecret("telegram",JSON.stringify({botToken:"67890:ROTATED_TOKEN",chatId:"-1001"}));
  assert.equal(await refreshTelegramSettings(),true);assert.equal(config.telegram.botToken,"67890:ROTATED_TOKEN");assert.equal(config.telegram.chatId,"-1001");
  assert.equal(await refreshTelegramSettings(),false);
 }finally{await putSharedSecret("telegram","null");await refreshTelegramSettings();config.telegram.botToken=TOKEN;config.telegram.chatId="";}
 assert.equal(botKey(),botKey(TOKEN));
});
test("expiry cleanup deletes old decided capabilities but never pending ones",async()=>{
 const {run}=await gate();const approve=await action(run.id,"approve");const reject=await action(run.id,"reject");
 await pump(callback(approve));
 await q(pool,"UPDATE telegram_actions SET created_at=now()-interval '31 days' WHERE run_id=$1",[run.id]);
 const {run:open}=await gate();const pending=await action(open.id,"approve");await q(pool,"UPDATE telegram_actions SET created_at=now()-interval '31 days',expires_at=now()+interval '1 hour' WHERE action_id=$1",[pending.action_id]);
 await expireActions();
 assert.ok(!await one(pool,"SELECT 1 FROM telegram_actions WHERE action_id=ANY($1)",[[approve.action_id,reject.action_id]]));
 assert.equal((await one(pool,"SELECT status FROM telegram_actions WHERE action_id=$1",[pending.action_id]))!.status,"pending");
});

test("an unreachable Telegram API is reported as a network failure with its system code, never as a Telegram 503", async () => {
  const { telegramCall, TelegramApiError } = await import("../src/telegram/client.ts");
  const { consumerFailure } = await import("../src/telegram/transport.ts");
  const saved = config.telegram.apiBase;
  // A port that was free a moment ago: nothing listens there (port 1 is refused by fetch itself as a "bad port").
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const closedPort = (probe.address() as any).port;
  await new Promise<void>((r) => probe.close(() => r()));
  config.telegram.apiBase = `http://127.0.0.1:${closedPort}`;
  try {
    const e = await telegramCall("getMe", {}, { token: "123456:SECRET_TOKEN_VALUE", timeout: 3000 }).then(() => null, (x) => x);
    assert.ok(e instanceof TelegramApiError);
    assert.equal(e.code, 503, "still retried like a temporary outage");
    assert.equal(e.network, "ECONNREFUSED");
    const reason = consumerFailure(e);
    assert.match(reason, new RegExp(`cannot reach 127\\.0\\.0\\.1:${closedPort} \\(ECONNREFUSED\\)`));
    assert.doesNotMatch(reason, /SECRET_TOKEN_VALUE|503/);
  } finally {
    config.telegram.apiBase = saved;
  }
  assert.equal(consumerFailure(new TelegramApiError(503)), "Telegram API error 503", "a real 503 from Telegram keeps its wording");
  assert.match(consumerFailure(new TelegramApiError(503, 5, "ETIMEDOUT")), /cannot reach .*\(ETIMEDOUT\)/);
});
