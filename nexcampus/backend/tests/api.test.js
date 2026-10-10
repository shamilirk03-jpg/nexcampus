import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {boot} from './helpers.js';
import {createApp} from '../src/app.js';

const mock=(c,o={})=>c.post('/api/attempts',{mode:'mock',count:8,durationMinutes:10,...o});
async function answerAll(c,t,correctOf,mode){ // answer every question right (mode 'right') or wrong
  for(const q of t.body.attempt.questions){
    const ok=correctOf(q.id);
    await c.put(`/api/attempts/${t.body.attempt.id}/answers`,{questionId:q.id,selected:mode==='right'?ok:(ok+1)%q.options.length});
  }
}

test('auth: register, me, logout, wrong password; role cannot be set by client',async()=>{
  const b=await boot();const c=b.client();
  const r=await c.post('/api/auth/register',{email:'a@x.io',name:'Asha',password:'password123',role:'admin'});
  assert.equal(r.status,201);assert.equal(r.body.user.role,'student');
  assert.equal((await c.get('/api/auth/me')).body.user.email,'a@x.io');
  assert.equal((await c.post('/api/auth/logout')).status,200);
  assert.equal((await c.get('/api/auth/me')).status,401);
  assert.equal((await b.client().post('/api/auth/login',{email:'a@x.io',password:'wrongwrong'})).status,401);
  assert.equal((await b.client().post('/api/auth/login',{email:'a@x.io',password:'password123'})).status,200);
  assert.equal((await b.client().post('/api/auth/register',{email:'bad',name:'A',password:'x'})).status,422);
  const row=b.app.db.prepare('SELECT pw FROM users WHERE email=?').get('a@x.io');
  assert.ok(!row.pw.includes('password123'));
  b.close();
});

test('unauthenticated requests are rejected',async()=>{
  const b=await boot();const c=b.client();
  for(const u of['/api/questions','/api/students/me/dashboard','/api/attempts/1','/api/notifications'])assert.equal((await c.get(u)).status,401,u);
  b.close();
});

test('answer keys are never exposed before submission',async()=>{
  const b=await boot();const c=await b.student('s1@x.io');
  const list=await c.get('/api/questions?pageSize=50');
  assert.equal(list.body.total,32);
  assert.ok(!JSON.stringify(list.body).match(/"(correct|correct_index|explanation|answer)"\s*:/i));
  const t=await mock(c);
  assert.ok(!JSON.stringify(t.body).match(/"(correct|correct_index|explanation|answer)"\s*:/i));
  const id=t.body.attempt.id;
  assert.ok(!JSON.stringify((await c.get(`/api/attempts/${id}`)).body).match(/"(correct|correct_index|explanation|answer)"\s*:/i));
  assert.equal((await c.get(`/api/attempts/${id}/result`)).status,409);
  b.close();
});

test('backend scoring matches the database answer key; submit is idempotent',async()=>{
  const b=await boot();const c=await b.student('s2@x.io');
  const t=await mock(c,{count:6});const id=t.body.attempt.id,qs=t.body.attempt.questions;
  assert.equal(qs.length,6);
  // 3 right, 2 wrong, 1 unanswered
  for(let i=0;i<5;i++){const ok=b.correctOf(qs[i].id);await c.put(`/api/attempts/${id}/answers`,{questionId:qs[i].id,selected:i<3?ok:(ok+1)%qs[i].options.length})}
  const s1=await c.post(`/api/attempts/${id}/submit`);
  const r=s1.body.result;
  assert.deepEqual([r.correct,r.wrong,r.skipped,r.attempted,r.total],[3,2,1,5,6]);
  assert.equal(r.testPct,50);assert.equal(r.accuracyPct,60);
  assert.equal(r.review.length,6);assert.ok(r.review.every(x=>typeof x.correct==='number'&&x.explanation!==undefined));
  const s2=await c.post(`/api/attempts/${id}/submit`);
  assert.deepEqual(s2.body.result,s1.body.result);
  assert.equal(b.app.db.prepare('SELECT COUNT(*) c FROM results WHERE attempt_id=?').get(id).c,1);
  assert.equal(b.app.db.prepare("SELECT COUNT(*) c FROM notifications WHERE related_id=?").get(id).c,1);
  // answers cannot be changed after submission
  assert.equal((await c.put(`/api/attempts/${id}/answers`,{questionId:qs[5].id,selected:0})).status,409);
  assert.equal(b.app.db.prepare('SELECT COUNT(*) c FROM attempts').get().c,1);
  b.close();
});

test('client-sent score or answers in submit body are ignored',async()=>{
  const b=await boot();const c=await b.student('s3@x.io');
  const t=await mock(c,{count:4});const id=t.body.attempt.id;
  const r=await c.post(`/api/attempts/${id}/submit`,{score:100,correct:4,testPct:100,answers:[0,0,0,0]});
  assert.equal(r.body.result.correct,0);assert.equal(r.body.result.testPct,0);assert.equal(r.body.result.accuracyPct,0);
  b.close();
});

test('refresh/resume returns the same attempt with saved answers and unchanged expiry',async()=>{
  const b=await boot();const c=await b.student('s4@x.io');
  const t=await mock(c);const a=t.body.attempt;
  await c.put(`/api/attempts/${a.id}/answers`,{questionId:a.questions[0].id,selected:1,marked:true});
  const again=await mock(c,{count:20,durationMinutes:60});
  assert.equal(again.status,200);assert.equal(again.body.resumed,true);
  assert.equal(again.body.attempt.id,a.id);assert.equal(again.body.attempt.expiresAt,a.expiresAt);
  assert.equal(again.body.attempt.questions[0].selected,1);assert.equal(again.body.attempt.questions[0].marked,true);
  assert.equal(b.app.db.prepare('SELECT COUNT(*) c FROM attempts').get().c,1);
  b.close();
});

test('server enforces expiry even if the browser timer is changed',async()=>{
  const b=await boot();const c=await b.student('s5@x.io');
  const t=await mock(c,{count:4});const a=t.body.attempt;
  assert.ok(a.expiresAt-a.startedAt===600000);
  const ok=b.correctOf(a.questions[0].id);
  await c.put(`/api/attempts/${a.id}/answers`,{questionId:a.questions[0].id,selected:ok});
  b.app.db.prepare('UPDATE attempts SET expires_at=? WHERE id=?').run(Date.now()-1000,a.id); // time runs out
  const late=await c.put(`/api/attempts/${a.id}/answers`,{questionId:a.questions[1].id,selected:0});
  assert.equal(late.status,409);assert.equal(late.body.code,'expired');
  const sub=await c.post(`/api/attempts/${a.id}/submit`,{answers:'ignored'});
  assert.equal(sub.body.result.status,'auto_submitted');assert.equal(sub.body.result.reason,'time');
  assert.equal(sub.body.result.correct,1);assert.equal(sub.body.result.skipped,3);
  assert.ok(sub.body.result.submittedAt<=sub.body.result.expiresAt);
  b.close();
});

test('students cannot access or modify another student\'s attempts, results or history',async()=>{
  const b=await boot();const a=await b.student('a1@x.io'),o=await b.student('b1@x.io');
  const t=await mock(a,{count:3});const id=t.body.attempt.id,q=t.body.attempt.questions[0].id;
  await a.post(`/api/attempts/${id}/submit`);
  for(const r of[await o.get(`/api/attempts/${id}`),await o.get(`/api/attempts/${id}/result`),await o.post(`/api/attempts/${id}/submit`),await o.put(`/api/attempts/${id}/answers`,{questionId:q,selected:0}),await o.post(`/api/attempts/${id}/events`,{type:'blur'}),await o.get(`/api/attempts/${id}/events`)])assert.equal(r.status,404);
  const d=await o.get('/api/students/me/dashboard');assert.equal(d.body.empty,true);assert.equal(d.body.questionsAttempted,0);
  assert.equal((await o.get('/api/notifications')).body.notifications.length,0);
  assert.equal((await a.get('/api/notifications')).body.notifications.length,1);
  b.close();
});

test('only admins can edit questions or exam policy; admin actions are audited',async()=>{
  const b=await boot();const s=await b.student('s6@x.io'),ad=await b.admin();
  const pol={on:true,warn:1,max:2,act:'warn',neg:0};
  assert.equal((await s.put('/api/admin/policy',pol)).status,403);
  const nq={category:'Verbal Ability',topic:'Grammar',difficulty:'Easy',text:'Pick the noun.',options:['run','dog'],correct:1,explanation:'Dog is a noun.'};
  assert.equal((await s.post('/api/admin/questions',nq)).status,403);
  assert.equal((await b.client().post('/api/admin/questions',nq)).status,401);
  assert.equal((await s.patch('/api/admin/questions/1',{text:'hacked question'})).status,403);
  assert.equal((await s.del('/api/admin/questions/1')).status,403);
  assert.equal((await s.get('/api/admin/audit')).status,403);
  assert.equal((await ad.put('/api/admin/policy',pol)).status,200);
  assert.equal((await ad.put('/api/admin/policy',{...pol,max:0})).status,422);
  const c=await ad.post('/api/admin/questions',nq);assert.equal(c.status,201);
  assert.equal((await ad.post('/api/admin/questions',{...nq,correct:5})).status,422);
  assert.equal((await ad.patch(`/api/admin/questions/${c.body.id}`,{text:'Which word is a noun?'})).status,200);
  assert.equal((await ad.del(`/api/admin/questions/${c.body.id}`)).status,200);
  const actions=(await ad.get('/api/admin/audit')).body.entries.map(e=>e.action);
  for(const a of['policy.update','question.create','question.update','question.remove'])assert.ok(actions.includes(a),a);
  assert.equal((await s.get('/api/questions?pageSize=50')).body.total,32);
  b.close();
});

test('monitoring: records events, de-duplicates overlapping signals, keeps timer running',async()=>{
  const b=await boot({dedupeMs:200});const c=await b.student('m1@x.io');
  const t=await mock(c,{count:3});const a=t.body.attempt;
  assert.equal(a.monitoring.enabled,true);assert.equal(a.monitoring.action,'warn');
  const e1=await c.post(`/api/attempts/${a.id}/events`,{type:'visibilitychange'});
  assert.equal(e1.body.recorded,true);assert.equal(e1.body.count,1);
  const dup=await c.post(`/api/attempts/${a.id}/events`,{type:'blur'});
  assert.equal(dup.body.recorded,false);assert.equal(dup.body.deduped,true);assert.equal(dup.body.count,1);
  await new Promise(r=>setTimeout(r,250));
  const e2=await c.post(`/api/attempts/${a.id}/events`,{type:'blur'});
  assert.equal(e2.body.count,2);assert.equal(e2.body.warn,true);assert.equal(e2.body.submitted,false);
  assert.equal(e2.body.expiresAt,a.expiresAt); // timer is not paused or extended
  assert.equal((await c.post(`/api/attempts/${a.id}/events`,{type:'mouse'})).status,422);
  const ev=await c.get(`/api/attempts/${a.id}/events`);
  assert.deepEqual(ev.body.events.map(e=>e.seq),[1,2]);
  const stored=b.app.db.prepare('SELECT user_id FROM monitoring_events WHERE attempt_id=?').all(a.id);
  const me=(await c.get('/api/auth/me')).body.user.id;assert.ok(stored.length===2&&stored.every(x=>x.user_id===me));
  b.close();
});

test('monitoring: warning-only never submits; auto-submit only when configured; never zero marks',async()=>{
  const b=await boot({dedupeMs:0});const ad=await b.admin();
  let c=await b.student('m2@x.io');
  await ad.put('/api/admin/policy',{on:true,warn:1,max:2,act:'warn',neg:0});
  let t=await mock(c,{count:4});let a=t.body.attempt;
  const q0=a.questions[0];await c.put(`/api/attempts/${a.id}/answers`,{questionId:q0.id,selected:b.correctOf(q0.id)});
  for(let i=0;i<5;i++)await c.post(`/api/attempts/${a.id}/events`,{type:'blur'});
  assert.equal((await c.get(`/api/attempts/${a.id}`)).body.attempt.status,'in_progress');
  await c.post(`/api/attempts/${a.id}/submit`);
  const c2=await b.student('m3@x.io');
  await ad.put('/api/admin/policy',{on:true,warn:1,max:2,act:'auto',neg:0});
  t=await mock(c2,{count:4});a=t.body.attempt;
  const k=a.questions[0];await c2.put(`/api/attempts/${a.id}/answers`,{questionId:k.id,selected:b.correctOf(k.id)});
  await c2.post(`/api/attempts/${a.id}/events`,{type:'blur'});
  const last=await c2.post(`/api/attempts/${a.id}/events`,{type:'visibilitychange'});
  assert.equal(last.body.submitted,true);
  const r=(await c2.get(`/api/attempts/${a.id}/result`)).body.result;
  assert.equal(r.reason,'policy');assert.equal(r.correct,1); // answers preserved, not zeroed
  assert.equal(r.focusEvents,2);
  assert.equal((await c2.post(`/api/attempts/${a.id}/events`,{type:'blur'})).status,409);
  b.close();
});

test('policy with monitoring off records nothing; confirm mode asks for acknowledgement',async()=>{
  const b=await boot({dedupeMs:0});const ad=await b.admin();
  await ad.put('/api/admin/policy',{on:false,warn:1,max:2,act:'warn',neg:0});
  let c=await b.student('m4@x.io');let a=(await mock(c)).body.attempt;
  assert.equal((await c.post(`/api/attempts/${a.id}/events`,{type:'blur'})).body.recorded,false);
  assert.equal(b.app.db.prepare('SELECT COUNT(*) c FROM monitoring_events').get().c,0);
  await c.post(`/api/attempts/${a.id}/submit`);
  await ad.put('/api/admin/policy',{on:true,warn:1,max:2,act:'confirm',neg:0});
  a=(await mock(c)).body.attempt;
  await c.post(`/api/attempts/${a.id}/events`,{type:'blur'});
  const e=await c.post(`/api/attempts/${a.id}/events`,{type:'blur'});
  assert.equal(e.body.requireAcknowledgement,true);assert.equal(e.body.submitted,false);
  b.close();
});

test('negative marking is explicit and configurable (default off)',async()=>{
  const b=await boot();const ad=await b.admin();const c=await b.student('n1@x.io');
  let a=(await mock(c,{count:2})).body.attempt;
  await answerAll(c,{body:{attempt:a}},b.correctOf,'wrong');
  assert.equal((await c.post(`/api/attempts/${a.id}/submit`)).body.result.score,0);
  await ad.put('/api/admin/policy',{on:true,warn:2,max:5,act:'warn',neg:0.5});
  a=(await mock(c,{count:2})).body.attempt;
  await answerAll(c,{body:{attempt:a}},b.correctOf,'wrong');
  const r=(await c.post(`/api/attempts/${a.id}/submit`)).body.result;
  assert.equal(r.score,-1);assert.equal(r.testPct,0);assert.equal(r.negMark,0.5);
  b.close();
});

test('dashboard uses persisted results only; empty state first',async()=>{
  const b=await boot();const c=await b.student('d1@x.io');
  const e=(await c.get('/api/students/me/dashboard')).body;
  assert.equal(e.empty,true);assert.equal(e.completedMocks,0);assert.equal(e.avgMockScorePct,null);assert.ok(e.hint);
  let a=(await mock(c,{count:4})).body.attempt;await answerAll(c,{body:{attempt:a}},b.correctOf,'right');await c.post(`/api/attempts/${a.id}/submit`);
  a=(await mock(c,{count:4})).body.attempt;await answerAll(c,{body:{attempt:a}},b.correctOf,'wrong');await c.post(`/api/attempts/${a.id}/submit`);
  const d=(await c.get('/api/students/me/dashboard')).body;
  assert.equal(d.completedMocks,2);assert.equal(d.questionsAttempted,8);assert.equal(d.accuracyPct,50);
  assert.equal(d.avgMockScorePct,50);assert.equal(d.latestVsPrevious,-100);
  assert.deepEqual(d.mockScores.map(m=>m.testPct),[100,0]);
  assert.equal(d.recent.length,2);assert.equal(Object.values(d.activity).reduce((x,y)=>x+y,0),8);
  const sumCat=Object.values(d.byCategory).reduce((x,y)=>x+y.attempted,0);assert.equal(sumCat,8);
  b.close();
});

test('weak-topic analysis uses real attempts and minimum evidence',async()=>{
  const b=await boot();const c=await b.student('w1@x.io');
  let w=(await c.get('/api/students/me/weak-topics')).body;
  assert.equal(w.weak.length,0);assert.match(w.message,/No attempted questions/);
  const topic='Normalization',cat='Database Management Systems';
  const run=async()=>{const a=(await c.post('/api/attempts',{mode:'practice',count:5,category:cat,topic})).body.attempt;await answerAll(c,{body:{attempt:a}},b.correctOf,'wrong');await c.post(`/api/attempts/${a.id}/submit`);return a};
  const first=await run(); // 2 questions only
  assert.equal(first.questions.length,2);
  w=(await c.get('/api/students/me/weak-topics')).body;
  assert.equal(w.weak.length,0);assert.equal(w.insufficient[0].topic,topic);assert.equal(w.insufficient[0].needed,2);
  await run();
  w=(await c.get('/api/students/me/weak-topics')).body;
  assert.equal(w.weak.length,1);const x=w.weak[0];
  assert.deepEqual([x.topic,x.attempts,x.correct,x.accuracyPct],[topic,4,0,0]);
  assert.deepEqual(x.recommendation.practice,{category:cat,topic,difficulty:'Easy'});
  assert.match(x.reason,/0 of 4/);
  // the recommendation's filters open a matching practice set
  const pq=x.recommendation.practice;
  const list=await c.get(`/api/questions?category=${encodeURIComponent(pq.category)}&topic=${encodeURIComponent(pq.topic)}`);
  assert.ok(list.body.total>0&&list.body.items.every(i=>i.topic===topic));
  // admin-configurable thresholds change the outcome
  const ad=await b.admin();await ad.put('/api/admin/settings/weak-topics',{min:10,threshold:60});
  assert.equal((await c.get('/api/students/me/weak-topics')).body.weak.length,0);
  b.close();
});

test('invalid input is rejected with clear errors',async()=>{
  const b=await boot();const c=await b.student('v1@x.io');
  assert.equal((await c.post('/api/attempts',{mode:'exam'})).status,422);
  assert.equal((await c.post('/api/attempts',{mode:'mock',count:0,durationMinutes:5})).status,422);
  assert.equal((await c.post('/api/attempts',{mode:'mock',count:5})).status,422);
  assert.equal((await c.post('/api/attempts',{mode:'practice',category:'Nope'})).status,422);
  assert.equal((await c.post('/api/attempts',{mode:'practice',count:5,topic:'No such topic'})).status,422);
  const a=(await mock(c,{count:2})).body.attempt;
  assert.equal((await c.put(`/api/attempts/${a.id}/answers`,{questionId:a.questions[0].id,selected:9})).status,422);
  assert.equal((await c.put(`/api/attempts/${a.id}/answers`,{questionId:99999,selected:0})).status,422);
  assert.equal((await c.put(`/api/attempts/${a.id}/answers`,{selected:0})).status,422);
  assert.equal((await c.get('/api/attempts/abc')).status,404);
  const raw=await fetch(b.base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{bad'});
  assert.equal(raw.status,400);
  b.close();
});

test('rate limiting blocks repeated failed logins',async()=>{
  const b=await boot();const c=b.client();let last;
  for(let i=0;i<12;i++)last=await c.post('/api/auth/login',{email:'x@x.io',password:'whatever1'});
  assert.equal(last.status,429);
  b.close();
});

test('data persists after restarting the application',async()=>{
  const f=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'nx-')),'t.db');
  let b=await boot({dbFile:f});let c=await b.student('p1@x.io');
  const a=(await mock(c,{count:3})).body.attempt;await c.post(`/api/attempts/${a.id}/submit`);
  b.close();
  b=await boot({dbFile:f});c=b.client();
  assert.equal((await c.post('/api/auth/login',{email:'p1@x.io',password:'password123'})).status,200);
  const d=(await c.get('/api/students/me/dashboard')).body;
  assert.equal(d.completedMocks,1);
  assert.equal((await c.get(`/api/attempts/${a.id}/result`)).body.result.total,3);
  assert.equal(b.app.db.prepare('SELECT COUNT(*) c FROM questions').get().c,32); // seed is not duplicated
  b.close();
});
