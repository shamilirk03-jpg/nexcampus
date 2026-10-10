import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {open} from './db.js';
import {scoreAttempt} from './scoring.js';
import {weakTopics} from './analytics.js';

export const CATEGORIES=["Quantitative Aptitude","Logical Reasoning","Verbal Ability","Programming Fundamentals","Data Structures and Algorithms","Database Management Systems","Operating Systems","Computer Networks"];
const DIFFS=['Easy','Medium','Hard'];
const DEF_POLICY={on:true,warn:2,max:5,act:'warn',neg:0};
const DEF_WEAK={min:4,threshold:60};
const SESSION_MS=7*864e5;

class HttpError extends Error{constructor(s,m,x){super(m);this.status=s;this.extra=x}}
const bad=(m,s=400,x)=>{throw new HttpError(s,m,x)};
const isInt=(v,a,b)=>Number.isInteger(v)&&v>=a&&v<=b;
const str=(v,a,b,n)=>{if(typeof v!=='string'||v.trim().length<a||v.trim().length>b)bad(`${n} must be ${a}-${b} characters`,422);return v.trim()};
const oneOf=(v,list,n)=>{if(!list.includes(v))bad(`${n} must be one of: ${list.join(', ')}`,422);return v};
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const hashPw=pw=>{const s=crypto.randomBytes(16).toString('hex');return s+':'+crypto.scryptSync(pw,s,64).toString('hex')};
const checkPw=(pw,stored)=>{const[s,h]=stored.split(':');const a=crypto.scryptSync(pw,s,64),b=Buffer.from(h,'hex');return a.length===b.length&&crypto.timingSafeEqual(a,b)};
const DUMMY=hashPw('not-a-real-password');

export function createApp({dbFile=':memory:',frontend=null,secureCookie=false,dedupeMs=1500}={}){
  const db=open(dbFile);
  const q1=(s,...p)=>db.prepare(s).get(...p),qa=(s,...p)=>db.prepare(s).all(...p),qr=(s,...p)=>db.prepare(s).run(...p);
  const now=()=>Date.now();
  const setting=(k,d)=>{const r=q1('SELECT value FROM settings WHERE key=?',k);return r?{...d,...JSON.parse(r.value)}:d};
  const putSetting=(k,v)=>qr('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',k,JSON.stringify(v));
  const audit=(actor,action,ref,detail)=>qr('INSERT INTO audit_logs(actor_id,action,ref,detail,at) VALUES(?,?,?,?,?)',actor,action,ref??null,detail?JSON.stringify(detail):null,now());
  const notify=(uid,cat,msg,rt,rid)=>qr('INSERT INTO notifications(user_id,category,message,related_type,related_id,created_at) VALUES(?,?,?,?,?,?)',uid,cat,msg,rt??null,rid??null,now());
  const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}};

  function createUser(email,name,role,pw){
    const r=qr('INSERT INTO users(email,name,role,pw,created_at) VALUES(?,?,?,?,?)',email,name,role,hashPw(pw),now());
    return Number(r.lastInsertRowid);
  }

  /* ---------- assessment engine ---------- */
  const noticeFor=p=>p.on?`This test records when the page is hidden or loses focus (event type and server time only). Warning after ${p.warn} event(s); limit ${p.max}; action at limit: ${{warn:'warning only',confirm:'acknowledgement required',auto:'automatic submission'}[p.act]}. Nothing else is collected. Browsers cannot prevent tab switching and a focus loss is not proof of misconduct.`:'Focus monitoring is switched off for this test.';

  function finalize(attemptId,reason){
    return tx(()=>{
      const a=q1('SELECT * FROM attempts WHERE id=?',attemptId);
      if(!a||a.status!=='in_progress')return false; // idempotent: already finalized
      const rows=qa('SELECT aa.question_id qid,aa.selected,q.correct_index correct,q.category,q.topic FROM attempt_answers aa JOIN questions q ON q.id=aa.question_id WHERE aa.attempt_id=?',attemptId);
      const s=scoreAttempt(rows,a.neg_mark);
      const upd=db.prepare('UPDATE attempt_answers SET is_correct=? WHERE attempt_id=? AND question_id=?');
      const cat={},top={};
      for(const r of rows){
        upd.run(r.selected==null?null:(r.selected===r.correct?1:0),attemptId,r.qid);
        for(const[m,k]of[[cat,r.category],[top,r.topic]]){const x=(m[k]??={total:0,attempted:0,correct:0});x.total++;if(r.selected!=null){x.attempted++;if(r.selected===r.correct)x.correct++}}
      }
      const t=now(),sub=a.expires_at?Math.min(t,a.expires_at):t,secs=Math.max(0,Math.round((sub-a.started_at)/1000));
      qr('INSERT INTO results(attempt_id,total,attempted,correct,wrong,skipped,score,test_pct,accuracy_pct,secs,breakdown) VALUES(?,?,?,?,?,?,?,?,?,?,?)',attemptId,s.total,s.attempted,s.correct,s.wrong,s.skipped,s.score,s.testPct,s.accuracyPct,secs,JSON.stringify({category:cat,topic:top}));
      qr('UPDATE attempts SET status=?,submitted_at=?,submit_reason=? WHERE id=?',reason==='manual'?'submitted':'auto_submitted',sub,reason,attemptId);
      notify(a.user_id,'placement',`${a.mode==='mock'?'Mock test':'Practice'} result: ${s.correct}/${s.total} correct (${s.testPct}%)`,'attempt',attemptId);
      return true;
    });
  }
  function own(u,id){
    const a=q1('SELECT * FROM attempts WHERE id=? AND user_id=?',Number(id),u.id);
    if(!a)bad('Attempt not found',404);
    if(a.status==='in_progress'&&a.expires_at&&a.expires_at<=now()){finalize(a.id,'time');return q1('SELECT * FROM attempts WHERE id=?',a.id)}
    return a;
  }
  function attemptView(a){
    const qs=qa('SELECT q.id,q.category,q.topic,q.difficulty,q.text,q.options,aa.selected,aa.marked FROM attempt_answers aa JOIN questions q ON q.id=aa.question_id WHERE aa.attempt_id=? ORDER BY aa.pos',a.id).map(x=>({...x,options:JSON.parse(x.options),marked:!!x.marked}));
    const p=JSON.parse(a.policy);
    return{id:a.id,mode:a.mode,status:a.status,startedAt:a.started_at,expiresAt:a.expires_at,serverNow:now(),negMark:a.neg_mark,
      monitoring:a.mode==='mock'?{enabled:p.on,warnAt:p.warn,max:p.max,action:p.act,notice:noticeFor(p)}:null,
      focusEvents:q1('SELECT COUNT(*) c FROM monitoring_events WHERE attempt_id=?',a.id).c,questions:qs};
  }
  function resultOf(id,review){
    const a=q1('SELECT * FROM attempts WHERE id=?',id),r=q1('SELECT * FROM results WHERE attempt_id=?',id);
    const out={attemptId:id,mode:a.mode,status:a.status,reason:a.submit_reason,startedAt:a.started_at,expiresAt:a.expires_at,submittedAt:a.submitted_at,
      total:r.total,attempted:r.attempted,correct:r.correct,wrong:r.wrong,skipped:r.skipped,score:r.score,negMark:a.neg_mark,testPct:r.test_pct,accuracyPct:r.accuracy_pct,secs:r.secs,
      breakdown:JSON.parse(r.breakdown),focusEvents:q1('SELECT COUNT(*) c FROM monitoring_events WHERE attempt_id=?',id).c};
    if(review)out.review=qa('SELECT q.id,q.category,q.topic,q.difficulty,q.text,q.options,q.correct_index,q.explanation,aa.selected,aa.is_correct FROM attempt_answers aa JOIN questions q ON q.id=aa.question_id WHERE aa.attempt_id=? ORDER BY aa.pos',id).map(x=>({id:x.id,category:x.category,topic:x.topic,difficulty:x.difficulty,text:x.text,options:JSON.parse(x.options),selected:x.selected,correct:x.correct_index,isCorrect:!!x.is_correct,explanation:x.explanation}));
    return out;
  }

  /* ---------- validation helpers ---------- */
  function filters(src){
    const f={};
    if(src.category!=null&&src.category!=='')f.category=oneOf(src.category,CATEGORIES,'category');
    if(src.topic!=null&&src.topic!=='')f.topic=str(src.topic,1,60,'topic');
    if(src.difficulty!=null&&src.difficulty!=='')f.difficulty=oneOf(src.difficulty,DIFFS,'difficulty');
    return f;
  }
  const where=f=>{const c=['active=1'],p=[];for(const k of['category','topic','difficulty'])if(f[k]){c.push(k+'=?');p.push(f[k])}return[c.join(' AND '),p]};
  function validQuestion(b){
    const options=b.options;
    if(!Array.isArray(options)||options.length<2||options.length>6)bad('options must be 2-6 strings',422);
    const opts=options.map((o,i)=>str(o,1,200,'option '+(i+1)));
    if(!isInt(b.correct,0,opts.length-1))bad('correct must be a valid option index',422);
    return{category:oneOf(b.category,CATEGORIES,'category'),topic:str(b.topic,1,60,'topic'),difficulty:oneOf(b.difficulty,DIFFS,'difficulty'),text:str(b.text,5,500,'text'),options:opts,correct:b.correct,explanation:typeof b.explanation==='string'?b.explanation.trim().slice(0,500):''};
  }
  function validPolicy(b){
    if(typeof b.on!=='boolean')bad('on must be true or false',422);
    if(!isInt(b.warn,1,100))bad('warn must be 1-100',422);
    if(!isInt(b.max,1,100)||b.max<b.warn)bad('max must be an integer ≥ warn',422);
    if(typeof b.neg!=='number'||b.neg<0||b.neg>1)bad('neg must be a number from 0 to 1',422);
    return{on:b.on,warn:b.warn,max:b.max,act:oneOf(b.act,['warn','confirm','auto'],'act'),neg:b.neg};
  }

  /* ---------- routes ---------- */
  const routes=[];
  const R=(m,p,auth,fn)=>routes.push([m,new RegExp('^'+p.replace(/:(\w+)/g,'(?<$1>[^/]+)')+'$'),auth,fn]);
  const hits=new Map();
  const limited=(key,max,ms)=>{const t=now(),h=(hits.get(key)||[]).filter(x=>t-x<ms);h.push(t);hits.set(key,h);return h.length>max};

  function login(res,uid){
    const tok=crypto.randomBytes(32).toString('hex');
    qr('INSERT INTO user_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)',sha(tok),uid,now()+SESSION_MS);
    res.setHeader('Set-Cookie',`nx_sid=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS/1000}${secureCookie?'; Secure':''}`);
  }
  const pub=u=>({id:u.id,email:u.email,name:u.name,role:u.role});

  R('POST','/api/auth/register','none',({body,res,ip})=>{
    if(limited('reg:'+ip,10,36e5))bad('Too many requests',429);
    const email=str(body.email,5,120,'email').toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))bad('email is not valid',422);
    const name=str(body.name,2,60,'name');
    if(typeof body.password!=='string'||body.password.length<8||body.password.length>128)bad('password must be 8-128 characters',422);
    if(q1('SELECT 1 FROM users WHERE email=?',email))bad('An account with this email already exists',409);
    const id=createUser(email,name,'student',body.password); // role is never taken from the client
    login(res,id);return[201,{user:pub(q1('SELECT * FROM users WHERE id=?',id))}];
  });
  R('POST','/api/auth/login','none',({body,res,ip})=>{
    const email=typeof body.email==='string'?body.email.trim().toLowerCase():'';
    if(limited('login:'+ip+email,10,3e5))bad('Too many attempts. Try again later.',429);
    const u=q1('SELECT * FROM users WHERE email=?',email);
    const ok=checkPw(typeof body.password==='string'?body.password:'',u?u.pw:DUMMY);
    if(!u||!ok)bad('Invalid email or password',401);
    login(res,u.id);return{user:pub(u)};
  });
  R('POST','/api/auth/logout','user',({res,token})=>{
    qr('DELETE FROM user_sessions WHERE token_hash=?',sha(token));
    res.setHeader('Set-Cookie','nx_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return{ok:true};
  });
  R('GET','/api/auth/me','user',({u})=>({user:pub(u)}));

  R('GET','/api/questions','user',({query})=>{ // never includes answer keys
    const f=filters(query),[w,p]=where(f);
    const page=Math.max(1,parseInt(query.page)||1),size=Math.min(50,Math.max(1,parseInt(query.pageSize)||20));
    const total=q1(`SELECT COUNT(*) c FROM questions WHERE ${w}`,...p).c;
    const items=qa(`SELECT id,category,topic,difficulty,text,options FROM questions WHERE ${w} ORDER BY id LIMIT ? OFFSET ?`,...p,size,(page-1)*size).map(x=>({...x,options:JSON.parse(x.options)}));
    return{page,pageSize:size,total,items};
  });
  R('GET','/api/categories','user',()=>({categories:CATEGORIES.map(c=>({name:c,topics:qa('SELECT DISTINCT topic FROM questions WHERE category=? AND active=1 ORDER BY topic',c).map(r=>r.topic)})),difficulties:DIFFS}));
  R('GET','/api/policy','user',()=>({policy:setting('policy',DEF_POLICY)}));

  R('POST','/api/attempts','user',({u,body})=>{
    const mode=oneOf(body.mode,['mock','practice'],'mode');
    const count=body.count==null?10:body.count;
    if(!isInt(count,1,100))bad('count must be 1-100',422);
    let mins=body.durationMinutes??null;
    if(mins!=null&&!isInt(mins,1,180))bad('durationMinutes must be 1-180',422);
    if(mode==='mock'&&mins==null)bad('Mock tests need durationMinutes',422);
    const f=filters(body);
    for(const a of qa("SELECT id FROM attempts WHERE user_id=? AND status='in_progress' AND expires_at IS NOT NULL AND expires_at<=?",u.id,now()))finalize(a.id,'time');
    const active=q1("SELECT * FROM attempts WHERE user_id=? AND mode=? AND status='in_progress'",u.id,mode);
    if(active)return[200,{resumed:true,attempt:attemptView(active)}];
    const[w,p]=where(f);
    const picked=qa(`SELECT id FROM questions WHERE ${w} ORDER BY RANDOM() LIMIT ?`,...p,count);
    if(!picked.length)bad('No questions match those filters',422);
    const policy=setting('policy',DEF_POLICY);
    const id=tx(()=>{
      const t=now();
      const r=qr('INSERT INTO attempts(user_id,mode,started_at,expires_at,neg_mark,policy) VALUES(?,?,?,?,?,?)',u.id,mode,t,mins?t+mins*60000:null,policy.neg,JSON.stringify(policy));
      const aid=Number(r.lastInsertRowid),ins=db.prepare('INSERT INTO attempt_answers(attempt_id,question_id,pos) VALUES(?,?,?)');
      picked.forEach((x,i)=>ins.run(aid,x.id,i));return aid;
    });
    return[201,{resumed:false,attempt:attemptView(q1('SELECT * FROM attempts WHERE id=?',id))}];
  });
  R('GET','/api/attempts/:id','user',({u,params})=>({attempt:attemptView(own(u,params.id))}));
  R('PUT','/api/attempts/:id/answers','user',({u,params,body})=>{
    const a=own(u,params.id);
    if(a.status!=='in_progress')bad('This attempt is closed',409,{code:a.submit_reason==='time'?'expired':'closed'});
    if(!isInt(body.questionId,1,1e9))bad('questionId is required',422);
    const row=q1('SELECT aa.question_id,q.options FROM attempt_answers aa JOIN questions q ON q.id=aa.question_id WHERE aa.attempt_id=? AND aa.question_id=?',a.id,body.questionId);
    if(!row)bad('Question is not part of this attempt',422);
    let sel,marked;
    if(body.selected!==undefined){
      if(body.selected!==null&&!isInt(body.selected,0,JSON.parse(row.options).length-1))bad('selected is not a valid option',422);
      sel=body.selected;
    }
    if(body.marked!==undefined){if(typeof body.marked!=='boolean')bad('marked must be true or false',422);marked=body.marked}
    if(sel===undefined&&marked===undefined)bad('Nothing to save',422);
    if(sel!==undefined)qr('UPDATE attempt_answers SET selected=?,updated_at=? WHERE attempt_id=? AND question_id=?',sel,now(),a.id,row.question_id);
    if(marked!==undefined)qr('UPDATE attempt_answers SET marked=? WHERE attempt_id=? AND question_id=?',marked?1:0,a.id,row.question_id);
    return{saved:true,serverNow:now()};
  });
  R('POST','/api/attempts/:id/submit','user',({u,params})=>{
    const a=own(u,params.id); // expiry is enforced here; late submissions are scored from saved answers only
    if(a.status==='in_progress')finalize(a.id,'manual');
    return{result:resultOf(a.id,true)}; // repeated calls return the same stored result
  });
  R('GET','/api/attempts/:id/result','user',({u,params})=>{
    const a=own(u,params.id);
    if(a.status==='in_progress')bad('Result is available after submission',409);
    return{result:resultOf(a.id,true)};
  });
  R('POST','/api/attempts/:id/events','user',({u,params,body})=>{
    const a=own(u,params.id);
    if(a.status!=='in_progress')bad('This attempt is closed',409);
    const p=JSON.parse(a.policy);
    if(a.mode!=='mock'||!p.on)return{recorded:false,reason:'monitoring_off'};
    const type=oneOf(body.type,['visibilitychange','blur'],'type');
    const last=q1('SELECT at,seq FROM monitoring_events WHERE attempt_id=? ORDER BY seq DESC LIMIT 1',a.id),count=last?last.seq:0;
    if(last&&now()-last.at<dedupeMs)return{recorded:false,deduped:true,count};
    const n=count+1;let action=null,submitted=false;
    if(n>=p.max)action=p.act;else if(n>=p.warn)action='warn';
    qr('INSERT INTO monitoring_events(attempt_id,user_id,type,seq,at,count_after,action) VALUES(?,?,?,?,?,?,?)',a.id,u.id,type,n,now(),n,action);
    if(n>=p.max&&p.act==='auto')submitted=finalize(a.id,'policy');
    return{recorded:true,count:n,warn:n>=p.warn,limitReached:n>=p.max,action,requireAcknowledgement:n>=p.max&&p.act==='confirm',submitted,expiresAt:a.expires_at,serverNow:now(),notice:noticeFor(p)};
  });
  R('GET','/api/attempts/:id/events','user',({u,params})=>{
    const a=own(u,params.id);
    return{events:qa('SELECT seq,type,at,action FROM monitoring_events WHERE attempt_id=? ORDER BY seq',a.id)};
  });

  /* ---------- student analytics ---------- */
  const grp=(rows,key)=>{const m={};for(const r of rows){const x=(m[r[key]]??={attempted:0,correct:0});x.attempted++;x.correct+=r.c}for(const x of Object.values(m))x.accuracyPct=Math.round(x.correct/x.attempted*1000)/10;return m};
  R('GET','/api/students/me/dashboard','user',({u})=>{
    const done=qa("SELECT a.id,a.mode,a.status,a.submitted_at,r.* FROM attempts a JOIN results r ON r.attempt_id=a.id WHERE a.user_id=? AND a.status!='in_progress' ORDER BY a.submitted_at",u.id);
    const rows=qa("SELECT a.submitted_at,q.category,q.topic,q.difficulty,aa.is_correct c FROM attempts a JOIN attempt_answers aa ON aa.attempt_id=a.id JOIN questions q ON q.id=aa.question_id WHERE a.user_id=? AND a.status!='in_progress' AND aa.selected IS NOT NULL",u.id);
    const mocks=done.filter(d=>d.mode==='mock'),att=rows.length,ok=rows.reduce((s,r)=>s+r.c,0),totalQ=done.reduce((s,d)=>s+d.total,0),secs=done.reduce((s,d)=>s+d.secs,0);
    const activity={};for(const r of rows){const d=new Date(r.submitted_at).toISOString().slice(0,10);activity[d]=(activity[d]||0)+1}
    const last=mocks[mocks.length-1],prev=mocks[mocks.length-2];
    return{empty:!done.length,completedMocks:mocks.length,completedPractice:done.length-mocks.length,questionsAttempted:att,
      accuracyPct:att?Math.round(ok/att*1000)/10:0,avgMockScorePct:mocks.length?Math.round(mocks.reduce((s,m)=>s+m.test_pct,0)/mocks.length*10)/10:null,
      avgSecsPerQuestion:totalQ?Math.round(secs/totalQ*10)/10:0,
      latestVsPrevious:last&&prev?Math.round((last.test_pct-prev.test_pct)*10)/10:null,
      mockScores:mocks.map(m=>({attemptId:m.id,at:m.submitted_at,testPct:m.test_pct})),
      recent:done.slice(-8).reverse().map(d=>({attemptId:d.id,mode:d.mode,status:d.status,at:d.submitted_at,correct:d.correct,total:d.total,testPct:d.test_pct,secs:d.secs,focusEvents:q1('SELECT COUNT(*) c FROM monitoring_events WHERE attempt_id=?',d.id).c})),
      byCategory:grp(rows,'category'),byTopic:grp(rows,'topic'),byDifficulty:grp(rows,'difficulty'),activity,
      hint:done.length?null:'No attempts yet. Take a mock test to populate this dashboard.'};
  });
  R('GET','/api/students/me/weak-topics','user',({u})=>{
    const s=setting('weak',DEF_WEAK);
    const rows=qa("SELECT q.category,q.topic,q.difficulty,aa.is_correct correct FROM attempts a JOIN attempt_answers aa ON aa.attempt_id=a.id JOIN questions q ON q.id=aa.question_id WHERE a.user_id=? AND a.status!='in_progress' AND aa.selected IS NOT NULL ORDER BY a.submitted_at,aa.pos",u.id);
    return{...weakTopics(rows,s),method:'Rule-based analysis of your saved answers. Not a trained model.'};
  });
  R('GET','/api/notifications','user',({u})=>({notifications:qa('SELECT id,category,message,related_type,related_id,created_at,read FROM notifications WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 100',u.id)}));
  R('PATCH','/api/notifications/read','user',({u})=>({updated:Number(qr('UPDATE notifications SET read=1 WHERE user_id=? AND read=0',u.id).changes)}));

  /* ---------- administration ---------- */
  R('PUT','/api/admin/policy','admin',({u,body})=>{const p=validPolicy(body);putSetting('policy',p);audit(u.id,'policy.update','policy',p);return{policy:p}});
  R('PUT','/api/admin/settings/weak-topics','admin',({u,body})=>{
    if(!isInt(body.min,1,100))bad('min must be 1-100',422);
    if(typeof body.threshold!=='number'||body.threshold<1||body.threshold>99)bad('threshold must be 1-99',422);
    const s={min:body.min,threshold:body.threshold};putSetting('weak',s);audit(u.id,'settings.weak.update','weak',s);return{settings:s};
  });
  R('GET','/api/admin/questions/:id','admin',({params})=>{
    const x=q1('SELECT * FROM questions WHERE id=?',Number(params.id));if(!x)bad('Question not found',404);
    return{question:{id:x.id,category:x.category,topic:x.topic,difficulty:x.difficulty,text:x.text,options:JSON.parse(x.options),correct:x.correct_index,explanation:x.explanation,active:!!x.active}};
  });
  R('POST','/api/admin/questions','admin',({u,body})=>{
    const v=validQuestion(body);
    const r=qr('INSERT INTO questions(category,topic,difficulty,text,options,correct_index,explanation) VALUES(?,?,?,?,?,?,?)',v.category,v.topic,v.difficulty,v.text,JSON.stringify(v.options),v.correct,v.explanation);
    audit(u.id,'question.create',String(r.lastInsertRowid));return[201,{id:Number(r.lastInsertRowid)}];
  });
  R('PATCH','/api/admin/questions/:id','admin',({u,params,body})=>{
    const x=q1('SELECT * FROM questions WHERE id=?',Number(params.id));if(!x)bad('Question not found',404);
    const v=validQuestion({category:x.category,topic:x.topic,difficulty:x.difficulty,text:x.text,options:JSON.parse(x.options),correct:x.correct_index,explanation:x.explanation,...body});
    qr('UPDATE questions SET category=?,topic=?,difficulty=?,text=?,options=?,correct_index=?,explanation=? WHERE id=?',v.category,v.topic,v.difficulty,v.text,JSON.stringify(v.options),v.correct,v.explanation,x.id);
    audit(u.id,'question.update',String(x.id));return{updated:true};
  });
  R('DELETE','/api/admin/questions/:id','admin',({u,params})=>{ // soft delete keeps past attempts intact
    const r=qr('UPDATE questions SET active=0 WHERE id=? AND active=1',Number(params.id));if(!r.changes)bad('Question not found',404);
    audit(u.id,'question.remove',params.id);return{removed:true};
  });
  R('GET','/api/admin/audit','admin',()=>({entries:qa('SELECT id,actor_id,action,ref,detail,at FROM audit_logs ORDER BY id DESC LIMIT 200')}));

  /* ---------- HTTP plumbing ---------- */
  const send=(res,s,o)=>{res.writeHead(s,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(o))};
  async function readBody(req){
    if(!['POST','PUT','PATCH','DELETE'].includes(req.method))return{};
    const chunks=[];let n=0;
    for await(const c of req){n+=c.length;if(n>100*1024)bad('Request body too large',413);chunks.push(c)}
    if(!n)return{};
    if(!(req.headers['content-type']||'').startsWith('application/json'))bad('Content-Type must be application/json',415);
    try{const b=JSON.parse(Buffer.concat(chunks).toString());if(b===null||typeof b!=='object'||Array.isArray(b))throw 0;return b}catch{bad('Invalid JSON body',400)}
  }
  async function handle(req,res){
    try{
      res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
      const url=new URL(req.url,'http://localhost'),ip=req.socket.remoteAddress||'';
      if(req.method==='GET'&&(url.pathname==='/'||url.pathname==='/index.html')&&frontend&&fs.existsSync(frontend)){
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(fs.readFileSync(frontend));
      }
      if(!url.pathname.startsWith('/api/'))bad('Not found',404);
      if(limited('ip:'+ip,600,6e4))bad('Too many requests',429);
      const origin=req.headers.origin;
      if(req.method!=='GET'&&origin&&new URL(origin).host!==req.headers.host)bad('Cross-origin request blocked',403);
      const body=await readBody(req);
      const route=routes.map(r=>({r,m:r[1].exec(url.pathname)})).find(x=>x.m&&x.r[0]===req.method);
      if(!route)bad('Not found',404);
      const[, ,auth,fn]=route.r;
      let u=null,token=null;
      const ck=Object.fromEntries((req.headers.cookie||'').split(';').map(s=>s.trim().split('=')).filter(a=>a[0]).map(a=>[a[0],a.slice(1).join('=')]));
      if(ck.nx_sid){
        token=ck.nx_sid;
        u=q1('SELECT u.* FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?',sha(token),now())||null;
      }
      if(auth!=='none'&&!u)bad('Sign in required',401);
      if(auth==='admin'&&u.role!=='admin')bad('You do not have permission to do this',403);
      const out=fn({u,body,params:route.m.groups||{},query:Object.fromEntries(url.searchParams),res,ip,token});
      const[status,payload]=Array.isArray(out)?out:[200,out];
      send(res,status,payload);
    }catch(e){
      if(e instanceof HttpError)return send(res,e.status,{error:e.message,...(e.extra||{})});
      console.error(e);send(res,500,{error:'Something went wrong'});
    }
  }
  const server=http.createServer(handle);
  return{server,db,createUser,close:()=>{server.closeAllConnections();server.close();db.close()}};
}
