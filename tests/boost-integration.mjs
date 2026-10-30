// Local D1 + HTTP integration only. Disposable signing key; no user wallet,
// transactions, production database or persistent fixture scores.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createGame, tick, steerDirection, BOOST_STEPS, CHECKPOINT_STEPS } from '../lib/game.ts';
import { STATIC_ORIGINS } from '../lib/hosting.mjs';

const origin=new URL(process.env.WK_TEST_ORIGIN||'http://127.0.0.1:5173');
if(!['127.0.0.1','localhost'].includes(origin.hostname))throw new Error('This integration check only runs against a local preview.');
const root=fileURLToPath(new URL('../',import.meta.url)),execute=promisify(execFile);
const account=privateKeyToAccount(generatePrivateKey()),address=account.address.toLowerCase();
const eventId=`test-${crypto.randomUUID()}`,seed=2026;let cookie='',token='';
const staticOrigin=process.env.WK_TEST_STATIC==='1'?STATIC_ORIGINS[0]:null;
async function sql(command){
  await execute(process.execPath,['--import','./scripts/sites-env.mjs','./node_modules/wrangler/bin/wrangler.js',
    'd1','execute','DB','--local','--config','wrangler.local.jsonc','--persist-to','.wrangler/state','--command',command,'--json'],{cwd:root});
}
async function request(path,data){
  const response=await fetch(new URL(`/api/${path}`,origin),{method:data?'POST':'GET',headers:{'content-type':'application/json',...(cookie?{cookie}:{}),...(staticOrigin?{origin:staticOrigin}:{}),...(token?{authorization:`Bearer ${token}`}:{})},body:data?JSON.stringify(data):undefined});
  return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')};
}
try{
  assert.equal((await request('runs',{action:'start',mode:'boost',eventId})).status,401);
  assert.equal((await request('runs',{action:'abandon',id:'missing'})).status,401);
  const nonce=await request('auth/nonce',{address:account.address});assert.equal(nonce.status,200);
  const signature=await account.signMessage({message:nonce.data.message});
  const verified=await request('auth/verify',{id:nonce.data.id,signature});assert.equal(verified.status,200);
  if(staticOrigin){assert.equal(verified.cookie,null);token=verified.data.token;assert.ok(token);}else cookie=verified.cookie.split(';')[0];
  const now=Date.now();
  await sql(`INSERT INTO wheel_events (id,seed,rpm,opened_at,join_until) VALUES
    ('${eventId}',${seed},18,${now-1000},${now+90000}),
    ('${eventId}-closed',${seed},18,${now-100000},${now-1000}),
    ('${eventId}-future',${seed},18,${now+100000},${now+200000});`);
  for(const id of [`${eventId}-closed`,`${eventId}-future`,'missing'])assert.equal((await request('runs',{action:'start',mode:'boost',eventId:id})).status,409);
  assert.equal((await request('runs',{action:'start',mode:'unknown'})).status,400);
  const cancelled=await request('runs',{action:'start',mode:'boost',eventId});assert.equal(cancelled.status,200);
  assert.equal((await request('runs',{action:'abandon',id:cancelled.data.id})).status,200);
  assert.equal((await request('runs',{action:'abandon',id:cancelled.data.id})).status,200,'Exit is idempotent');
  assert.equal((await request('runs',{action:'checkpoint',id:cancelled.data.id,sequence:1,throughStep:400,moves:[],finished:false})).status,400,'An exited run cannot submit another checkpoint');
  assert.equal((await request(`leaderboard?event=${eventId}`)).data.me,null,'Exiting does not save an unfinished score');
  console.log('PASS: exiting abandons the run without saving a score and rejects later checkpoints');
  const first=await request('runs',{action:'start',mode:'boost',eventId,rpm:999});
  const start=await request('runs',{action:'start',mode:'boost',eventId,rpm:999}),began=Date.now();
  assert.equal(start.status,200,JSON.stringify(start.data));assert.equal(start.data.seed,first.data.seed);
  assert.equal(start.data.seed,seed);assert.equal(start.data.boost.rpm,18);
  console.log('PASS: guests rejected, closed/future/missing events rejected, shared seed and authoritative RPM');

  const g=createGame(start.data.seed,start.data.boost);let moves=[],direction=0,sequence=0;
  while(!g.ended){
    const target=g.packets.filter(p=>!p.resolved&&p.kind!=='glitch').sort((a,b)=>(a.born+a.travelSteps)-(b.born+b.travelSteps))[0];
    const next=target?steerDirection(g.angle,target.angle):0;
    if(next!==direction){moves.push({step:g.step,direction:next});direction=next;}
    g.direction=next;tick(g);
    if(g.ended||g.step%CHECKPOINT_STEPS===0){
      const payload={action:'checkpoint',id:start.data.id,sequence:++sequence,throughStep:g.step,moves,finished:g.ended,score:999999999,orbits:999,rpm:999};
      if(sequence===1)assert.equal((await request('runs',payload)).status,400,'Fast-forward must be rejected');
      await new Promise(resolve=>setTimeout(resolve,Math.max(0,began+g.step*20+300-Date.now())));
      const saved=await request('runs',payload);assert.equal(saved.status,200,JSON.stringify(saved.data));
      assert.equal(saved.data.score,g.score);assert.equal(saved.data.lives,g.lives);assert.equal(saved.data.finished,g.ended);
      if(sequence===1){
        await sql(`UPDATE wheel_events SET join_until=${Date.now()-1} WHERE id='${eventId}';`);
        assert.equal((await request('runs',{action:'start',mode:'boost',eventId})).status,409);
        console.log('PASS: entry closes while the existing run keeps its stored charge and course');
      }
      if(g.ended){const duplicate=await request('runs',payload);assert.equal(duplicate.status,200);assert.equal(duplicate.data.score,g.score);}
      console.log(`PASS: Boost checkpoint ${sequence}, step ${g.step}, score ${g.score}`);moves=[];
    }
  }
  assert.equal(g.step,BOOST_STEPS);assert.ok(g.boost.orbits>0);
  const board=await request(`leaderboard?event=${eventId}`);assert.equal(board.status,200);
  assert.equal(board.data.me.score,g.score);assert.equal(board.data.me.orbits,g.boost.orbits);assert.equal(board.data.me.played,1);
  assert.equal(board.data.total,1);
  assert.equal((await request('leaderboard')).data.me,null,'Boost scores must never enter the ordinary leaderboard');
  console.log('ALL BOOST INTEGRATION CHECKS PASSED: 75s replay, golden bonus, isolated event board, idempotent final save');
}finally{
  await sql(`DELETE FROM event_records WHERE event_id IN ('${eventId}','${eventId}-closed','${eventId}-future');
    DELETE FROM runs WHERE address='${address}'; DELETE FROM sessions WHERE address='${address}'; DELETE FROM nonces WHERE address='${address}';
    DELETE FROM wheel_events WHERE id IN ('${eventId}','${eventId}-closed','${eventId}-future');`);
  console.log('Cleaned up the disposable local account and event fixtures.');
}
