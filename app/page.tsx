'use client';
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowUpRight, ExternalLink, Heart, Loader2, Play, RotateCcw, Trophy, Volume2, VolumeX, Wallet, X, Zap } from 'lucide-react';
import { createGame, tick, steerDirection, difficultyAt, boostRhythm, BOOST_STEPS, ORBIT_SEEDS, CHECKPOINT_STEPS, STEP_MS, type Game, type Move, type BoostConfig, type WheelEvent } from '@/lib/game';
import { draw, sceneLayout } from '@/lib/draw';
import { hitSamples } from '@/lib/sound';
import { api, gameApi } from '@/lib/api-client';
import type { Pulse } from '@/lib/server';
type Provider = { request: (d: {method: string; params?: unknown[]}) => Promise<any>; on?: (event: string, fn: (...args: any[]) => void) => void; removeListener?: (event: string, fn: (...args: any[]) => void) => void };
type Row = {address: string; score: number; catches: number; played: number};
type RunChannel={id:string;sequence:number;cursor:number;queue:Promise<void>;failed:boolean;error:string};
const short = (s: string) => `${s.slice(0,6)}…${s.slice(-4)}`;
const time = (seconds: number) => `${Math.floor(Math.max(0,seconds)/60)}:${String(Math.max(0,seconds)%60).padStart(2,'0')}`;
function gameHud(g: Game) {
  const pace = g.boost ? boostRhythm(g.boost.rpm) : difficultyAt(g.step);
  return { score:g.score, lives:g.lives, catches:g.catches, combo:g.combo, pace:pace.multiplier,
    stage:difficultyAt(g.step).stage, step:g.step, boost:g.boost?{...g.boost}:null };
}
function Hamster({size=38}: {size?:number}) {
  return <img src="/hamster-mark.svg?v=led-ears" width={size} height={size} alt="" aria-hidden="true"/>;
}
const letters:Record<string,string[]>={W:['10001','10001','10001','10101','10101','11011','10001'],H:['10001','10001','10001','11111','10001','10001','10001'],E:['11111','10000','10000','11110','10000','10000','11111'],L:['10000','10000','10000','10000','10000','10000','11111'],K:['10001','10010','10100','11000','10100','10010','10001'],P:['11110','10001','10001','11110','10000','10000','10000'],R:['11110','10001','10001','11110','10100','10010','10001'],S:['01111','10000','10000','01110','00001','00001','11110']};
function DotTitle(){return <svg className="dot-title" viewBox="0 0 420 158" role="img" aria-label="Wheelkeepers"><defs><linearGradient id="gold-led" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#ffe28a"/><stop offset="1" stopColor="#e8a43a"/></linearGradient><linearGradient id="blue-led" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#a8baff"/><stop offset="1" stopColor="#4460cf"/></linearGradient></defs>{['WHEEL','KEEPERS'].map((word,row)=><g key={word} fill={`url(#${row?'blue':'gold'}-led)`}>{Array.from(word).flatMap((l,i)=>letters[l].flatMap((r,y)=>Array.from(r).map((v,x)=>v==='1'?<g key={`${i}-${x}-${y}`}>{Array.from({length:9},(_,n)=>row?<rect key={n} x={i*60+x*10+1.5+(n%3)*3.15} y={row*82+y*10+2.5+Math.floor(n/3)*3.15} width="2.5" height="2.5"/>:<circle key={n} cx={i*60+x*10+2.8+(n%3)*3.15} cy={y*10+3.8+Math.floor(n/3)*3.15} r="1.3"/>)}</g>:null)))}</g>)}</svg>;}
export default function Home() {
  const canvas=useRef<HTMLCanvasElement>(null),game=useRef<Game>(createGame(48)),moves=useRef<Move[]>([]),playing=useRef(false),runId=useRef<string|null>(null);
  const pointer=useRef<{angle:number;held:boolean}|null>(null);
  const channel=useRef<RunChannel|null>(null),checkpointRef=useRef<(g:Game,finished:boolean)=>void>(()=>{});
  const exitRef=useRef<()=>void>(()=>{}),hitBuffer=useRef<AudioBuffer|null>(null);
  const [saving,setSaving]=useState(false);
  const liveRef=useRef<Pulse|null>(null),providerRef=useRef<Provider|null>(null),finishRef=useRef<(g:Game)=>void>(()=>{}),soundRef=useRef(true),audio=useRef<AudioContext|null>(null);
  const [phase,setPhase]=useState<'ready'|'playing'|'finished'>('ready'),[hud,setHud]=useState(()=>gameHud(game.current));
  const [live,setLive]=useState<Pulse|null>(null),[address,setAddress]=useState<string|null>(null),[rows,setRows]=useState<Row[]>([]),[total,setTotal]=useState(0),[me,setMe]=useState<Row|null>(null);
  const [best,setBest]=useState(0),[busy,setBusy]=useState(false),[walletOpen,setWalletOpen]=useState(false),[wallets,setWallets]=useState<{name:string;provider:Provider}[]>([]);
  const [toast,setToast]=useState(''),[saved,setSaved]=useState(''),[sound,setSound]=useState(true),[help,setHelp]=useState(false),[boardError,setBoardError]=useState(false);
  const [boostBest,setBoostBest]=useState(0),[clock,setClock]=useState(0),serverOffset=useRef(0);
  const [boardMode,setBoardMode]=useState<'arcade'|'boost'>('arcade'),[boardEvent,setBoardEvent]=useState<WheelEvent|null>(null),[boardLoading,setBoardLoading]=useState(true);
  const boardSelection=useRef<{mode:'arcade'|'boost';eventId:string|null}>({mode:'arcade',eventId:null});
  const note=useCallback((s:string)=>setToast(s),[]);
  useEffect(()=>{
    if(!walletOpen&&!help)return;
    const previous=document.activeElement as HTMLElement|null;
    const dialog=document.querySelector('.modal') as HTMLElement|null;
    const buttons=()=>Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]')||[]);
    buttons()[0]?.focus();
    const key=(e:KeyboardEvent)=>{
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();setWalletOpen(false);setHelp(false);}
      if(e.key==='Tab'){const b=buttons(),first=b[0],last=b.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
    };
    document.addEventListener('keydown',key);return()=>{document.removeEventListener('keydown',key);previous?.focus();};
  },[walletOpen,help]);
  const refreshBoard=useCallback(async()=>{
    const selection=boardSelection.current;
    try{const d=await api(`leaderboard${selection.mode==='boost'?`?event=${encodeURIComponent(selection.eventId||'latest')}`:''}`);
      if(boardSelection.current!==selection)return;
      setRows(d.rows);setTotal(d.total);setMe(d.me);setBoardEvent(d.event||null);setBoardError(false);
    }catch{if(boardSelection.current===selection)setBoardError(true);}
    finally{if(boardSelection.current===selection)setBoardLoading(false);}
  },[]);
  function chooseBoard(mode:'arcade'|'boost',eventId:string|null=null){
    boardSelection.current={mode,eventId};setBoardMode(mode);setRows([]);setMe(null);setTotal(0);setBoardEvent(null);setBoardLoading(true);setBoardError(false);refreshBoard();
  }
  useEffect(()=>{if(!toast)return;const t=setTimeout(()=>setToast(''),6500);return()=>clearTimeout(t);},[toast]);
  useEffect(()=>{
    try{setBest(Number(localStorage.getItem('wk-best')||0));setBoostBest(Number(localStorage.getItem('wk-boost-best')||0));}catch{}
    api('auth/session').then(d=>setAddress(d.address)).catch(()=>{});refreshBoard();
    async function poll(){try{const d=await api('pulse');serverOffset.current=typeof d.serverNow==='number'?d.serverNow-Date.now():0;setClock(Date.now()+serverOffset.current);setLive(d);liveRef.current=d;}catch{setLive(null);liveRef.current=null;}}
    poll();const interval=setInterval(()=>{if(!document.hidden){poll();refreshBoard();}},12000);
    const timer=setInterval(()=>setClock(Date.now()+serverOffset.current),1000);
    const discover=(e:Event)=>{const d=(e as CustomEvent).detail;if(d?.info?.name&&d?.provider?.request)setWallets(old=>old.some(w=>w.provider===d.provider)?old:[...old,{name:String(d.info.name),provider:d.provider}]);};
    window.addEventListener('eip6963:announceProvider',discover);window.dispatchEvent(new Event('eip6963:requestProvider'));
    const eth=(window as any).ethereum;if(eth)setWallets(old=>old.length?old:[{name:eth.isMetaMask?'MetaMask':eth.isRabby?'Rabby':'Browser wallet',provider:eth}]);
    return()=>{clearInterval(interval);clearInterval(timer);window.removeEventListener('eip6963:announceProvider',discover);};
  },[refreshBoard]);
  const direction=useCallback((v:-1|0|1)=>{
    if(!playing.current||game.current.direction===v)return;game.current.direction=v;
    const m={step:game.current.step,direction:v};if(moves.current.at(-1)?.step===m.step)moves.current[moves.current.length-1]=m;else moves.current.push(m);
  },[]);
  function aim(e:ReactPointerEvent<HTMLCanvasElement>,held=false){
    if(!playing.current||!e.isPrimary)return;
    if(e.pointerType!=='mouse'&&!held&&!pointer.current?.held)return;
    const r=e.currentTarget.getBoundingClientRect(),layout=sceneLayout(r.width,r.height,true);
    const x=e.clientX-r.left-layout.cx,y=e.clientY-r.top-layout.cy;
    if(Math.hypot(x,y)<20){if(held)pointer.current={angle:game.current.angle,held:true};return;}
    pointer.current={angle:Math.atan2(y,x),held:held||!!pointer.current?.held};
  }
  const releasePointer=useCallback(()=>{pointer.current=null;direction(0);},[direction]);
  useEffect(()=>{
    const held=new Set<string>();
    const keyboardDirection=()=>{const left=['ArrowLeft','a','A'].some(k=>held.has(k)),right=['ArrowRight','d','D'].some(k=>held.has(k));direction(left===right?0:left?-1:1);};
    const down=(e:KeyboardEvent)=>{if(e.defaultPrevented||!playing.current||document.querySelector('[role="dialog"]'))return;if(e.key==='Escape'){e.preventDefault();held.clear();exitRef.current();return;}if(['ArrowLeft','a','A','ArrowRight','d','D'].includes(e.key)){e.preventDefault();pointer.current=null;held.add(e.key);keyboardDirection();}};
    const up=(e:KeyboardEvent)=>{if(held.delete(e.key)&&!pointer.current)keyboardDirection();};
    const blur=()=>{held.clear();releasePointer();};
    window.addEventListener('keydown',down);window.addEventListener('keyup',up);window.addEventListener('blur',blur);
    const visibility=()=>{if(document.hidden)blur();};document.addEventListener('visibilitychange',visibility);
    return()=>{window.removeEventListener('keydown',down);window.removeEventListener('keyup',up);window.removeEventListener('blur',blur);document.removeEventListener('visibilitychange',visibility);};
  },[direction,releasePointer]);
  function beep(hz:number){if(!soundRef.current)return;try{audio.current||=new AudioContext();const ac=audio.current,o=ac.createOscillator(),gain=ac.createGain();o.frequency.value=hz;gain.gain.setValueAtTime(.045,ac.currentTime);gain.gain.exponentialRampToValueAtTime(.001,ac.currentTime+.1);o.connect(gain);gain.connect(ac.destination);o.start();o.stop(ac.currentTime+.1);}catch{}}
  function hit(){
    if(!soundRef.current)return;
    try{const ac=audio.current||=new AudioContext();
      if(!hitBuffer.current){const samples=hitSamples(ac.sampleRate),buffer=ac.createBuffer(1,samples.length,ac.sampleRate);buffer.getChannelData(0).set(samples);hitBuffer.current=buffer;}
      const source=ac.createBufferSource();source.buffer=hitBuffer.current;source.connect(ac.destination);source.start();
    }catch{}
  }
  function toggleSound(){
    const enabled=!soundRef.current;soundRef.current=enabled;setSound(enabled);
    if(enabled&&!resumeAudio()){soundRef.current=false;setSound(false);}
  }
  function resumeAudio(){
    try{audio.current||=new AudioContext();audio.current.resume().catch(()=>{});return true;}catch{return false;}
  }
  checkpointRef.current=(g,finished)=>{
    const active=channel.current;
    if(!active||active.failed){
      moves.current=[];
      if(finished)setSaved(active?.error||(g.boost?'Boost practice · saved on this device':'Practice result · saved on this device'));
      return;
    }
    if(g.step<=active.cursor)return;
    const from=active.cursor,through=g.step;
    const chunk=moves.current.filter(m=>m.step>=from&&m.step<through);
    moves.current=moves.current.filter(m=>m.step>=through);
    const payload={action:'checkpoint',id:active.id,sequence:++active.sequence,throughStep:through,moves:chunk,finished};
    const expected={score:g.score,catches:g.catches,lives:g.lives};active.cursor=through;
    if(finished){setSaving(true);setSaved('Verifying your final checkpoint…');}
    active.queue=active.queue.then(async()=>{
      if(active.failed)return;
      let result:any;
      for(let attempt=0;attempt<2;attempt++){
        try{result=await api('runs',payload);break;}
        catch(e){if(attempt===1)throw e;await new Promise(resolve=>setTimeout(resolve,700));}
      }
      if(result.step!==through||result.score!==expected.score||result.catches!==expected.catches||result.lives!==expected.lives)throw new Error('The server could not verify this run. Practice continues.');
      if(finished&&channel.current===active){setSaving(false);setSaved(`Verified · ${result.score.toLocaleString()} points saved to the board`);refreshBoard();}
    }).catch((e:Error)=>{
      active.failed=true;active.error=e.message||'Run verification was interrupted. This result stays on your device.';
      if(channel.current===active){runId.current=null;setSaving(false);setSaved(active.error);note(active.error);}
    });
  };
  finishRef.current=g=>{
    setPhase('finished');setHud(gameHud(g));
    const update=g.boost?setBoostBest:setBest,key=g.boost?'wk-boost-best':'wk-best';
    update(old=>{const n=Math.max(old,g.score);try{localStorage.setItem(key,String(n));}catch{}return n;});
    checkpointRef.current(g,true);
  };
  useEffect(()=>{
    const el=canvas.current;if(!el)return;const ctx=el.getContext('2d');if(!ctx)return;
    let width=680,height=460,frame=0,last=performance.now(),acc=0,motionClock=0;
    const resize=()=>{width=el.clientWidth;height=el.clientHeight;const ratio=Math.min(window.devicePixelRatio||1,2);el.width=width*ratio;el.height=height*ratio;ctx.setTransform(ratio,0,0,ratio,0,0);};
    const observer=new ResizeObserver(resize);observer.observe(el);resize();
    const animate=(now:number)=>{
      const delta=Math.min(100,now-last);last=now;
      const charged=(liveRef.current?.event?.joinUntil||0)>Date.now()+serverOffset.current;
      const wheelPace=playing.current?(game.current.boost?boostRhythm(game.current.boost.rpm).multiplier:difficultyAt(game.current.step).multiplier):charged?boostRhythm(liveRef.current?.rpm||0).multiplier:1;
      motionClock+=delta*wheelPace;
      if(playing.current){acc+=delta;while(acc>=STEP_MS&&playing.current){const c=game.current.catches,l=game.current.lives;if(pointer.current)direction(steerDirection(game.current.angle,pointer.current.angle));tick(game.current);acc-=STEP_MS;if(game.current.catches>c)beep(680);if(game.current.lives<l)hit();
        if(game.current.step%5===0)setHud(gameHud(game.current));
        if(!game.current.ended&&game.current.step%CHECKPOINT_STEPS===0)checkpointRef.current(game.current,false);
        if(game.current.ended){playing.current=false;finishRef.current(game.current);}}}else acc=0;
      draw(ctx,width,height,game.current,playing.current,window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:motionClock,pointer.current?.angle,charged);frame=requestAnimationFrame(animate);
    };frame=requestAnimationFrame(animate);return()=>{cancelAnimationFrame(frame);observer.disconnect();};
  },[direction]);
  async function connect(provider:Provider){
    setBusy(true);try{
      const session=await gameApi().connectWallet(provider);
      providerRef.current=provider;setAddress(session.address);setWalletOpen(false);refreshBoard();note('Signed in. Your next run counts toward the leaderboard.');
    }catch(e:any){note(e?.code===4001?'Sign-in cancelled. Practice is still open.':e?.message||'Could not connect wallet.');}finally{setBusy(false);}
  }
  async function disconnect(){try{await api('auth/session',undefined,'DELETE');setAddress(null);setMe(null);providerRef.current=null;note('Signed out.');}catch(e){note((e as Error).message);}}
  useEffect(()=>{
    const p=providerRef.current||(window as any).ethereum;if(!p?.on)return;
    const change=()=>{api('auth/session',undefined,'DELETE').catch(()=>{});setAddress(null);setMe(null);note('Wallet changed. Sign in again for ranked runs.');};
    p.on('accountsChanged',change);p.on('disconnect',change);return()=>{p.removeListener?.('accountsChanged',change);p.removeListener?.('disconnect',change);};
  },[address,note]);
  async function start(practice=false,boostMode=false,demo=false){
    if(playing.current||busy||saving)return;setBusy(true);setSaved('');
    // Unlock audio during the Play gesture, before a ranked request can delay it.
    if(soundRef.current)resumeAudio();
    try{let seed=live?.seed||Math.floor(Date.now()/86400000),id=null,boost:BoostConfig|undefined;
      if(boostMode){
        const event=liveRef.current?.event;
        if(demo){seed=(seed^0xb0057)>>>0;boost={rpm:12,eventId:null};}
        else if(event&&event.openedAt<=Date.now()+serverOffset.current&&event.joinUntil>Date.now()+serverOffset.current){seed=event.seed;boost={rpm:event.rpm,eventId:event.id};}
        else throw new Error('This Boost has closed. Try a practice Boost.');
      }
      if(address&&!practice){const r=await api('runs',{action:'start',mode:boostMode?'boost':'arcade',eventId:boost?.eventId});seed=r.seed;id=r.id;boost=r.boost||undefined;}
      game.current=createGame(seed,boost);moves.current=[];pointer.current=null;runId.current=id;channel.current=id?{id,sequence:0,cursor:0,queue:Promise.resolve(),failed:false,error:''}:null;setHud(gameHud(game.current));setPhase('playing');playing.current=true;
      if(boost)chooseBoard('boost',boost.eventId);
      if(window.innerWidth<760)document.querySelector('#arcade')?.scrollIntoView({behavior:'smooth',block:'start'});
    }catch(e){note((e as Error).message);}finally{setBusy(false);}
  }
  function startBoost(demo=false){return start(!address||demo,true,demo);}
  function resetArcade(){game.current=createGame(liveRef.current?.seed||48);setHud(gameHud(game.current));setPhase('ready');setSaved('');}
  function exitRun(){
    const active=channel.current,wasBoost=!!game.current.boost;
    playing.current=false;pointer.current=null;channel.current=null;runId.current=null;moves.current=[];setSaving(false);
    resetArcade();if(wasBoost)chooseBoard('arcade');
    if(active){active.failed=true;void api('runs',{action:'abandon',id:active.id}).catch(()=>{});}
  }
  exitRef.current=exitRun;
  const event=live?.event,eventOpen=!!event&&clock>=event.openedAt&&clock<event.joinUntil;
  const activeBest=hud.boost?boostBest:best,golden=!!hud.boost&&hud.step<hud.boost.orbitEnds;
  const charge=hud.boost?(golden?hud.boost.orbitCaught/ORBIT_SEEDS:Math.max(0,1-(hud.boost.nextOrbit-hud.step)/(hud.boost.nextOrbit===600?600:900))):0;
  const isLive=live?.available,label=live?.state==='resting'?'Hamster is resting':live?.state==='running'?'Hamster is running':'Live feed unavailable';
  return <div className="site-shell">
    <header className="topbar"><a href="#" className="brand" aria-label="Wheelkeepers home"><span className="brand-icon"><Hamster size={32}/></span><span>WHEELKEEPERS</span></a><nav><a href="#leaderboard">Leaderboard <ArrowUpRight size={14}/></a><button onClick={()=>setHelp(true)}>How to play</button></nav><button className={`wallet-button ${address?'connected':''}`} disabled={busy||phase==='playing'} onClick={()=>address?disconnect():setWalletOpen(true)}><Wallet size={16}/>{address?short(address):'Connect wallet'}{address&&<i className="status-dot"/>}</button></header>
    <main>
      <section className="intro"><h1><DotTitle/></h1><p>KEEP THE WHEEL ALIVE.</p></section>
      <div className="workspace"><section className={`arcade ${hud.boost?'boost-active':''}`} id="arcade" aria-label="Wheelkeepers game">
        <div className="arcade-header"><div><span className="tiny-label">{hud.boost?'BOOST':'ARCADE'}</span><span className="game-mode">{phase==='playing'?(runId.current?'RANKED RUN':'PRACTICE RUN'):'3 LIVES'}</span></div><div className="game-tools">{phase==='playing'&&<button className="exit-run" aria-label="Exit run" title="Exit run (Esc)" onClick={exitRun}><X size={12}/><span>EXIT</span></button>}<button aria-label={sound?'Mute game sound':'Enable game sound'} aria-pressed={sound} onClick={toggleSound}>{sound?<Volume2 size={17}/>:<VolumeX size={17}/>}</button><button aria-label="Game instructions" onClick={()=>setHelp(true)}>?</button></div></div>
        <div className="game-hud"><div><span>SCORE</span><strong>{String(hud.score).padStart(4,'0')}</strong></div><div className="harvest"><span>SEEDS</span><strong>{hud.catches}</strong></div><div className="pace"><span>{hud.boost?'TIME LEFT':`PACE / ${String(hud.stage).padStart(2,'0')}`}</span><strong>{hud.boost?time(Math.ceil((BOOST_STEPS-hud.step)*STEP_MS/1000)):<>{hud.pace.toFixed(2)}<small>×</small></>}</strong></div><div className="lives"><span>WHEEL HEALTH</span><div>{[0,1,2].map(i=><Heart key={i} size={19} fill={i<hud.lives?'currentColor':'transparent'} className={i>=hud.lives?'lost':''}/>)}</div></div></div>
        {hud.boost&&phase==='playing'&&<div className={`boost-status ${golden?'golden':''}`}><span>{golden?(hud.boost.orbitMissed?'CHAIN BROKEN':`GOLDEN ORBIT ${hud.boost.spin>0?'↻':'↺'}`):runId.current?'LIVE BOOST':'BOOST PRACTICE'}</span><div className="charge-track" role="progressbar" aria-label={golden?'Golden orbit progress':'Wheel energy'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(charge*100)}><i style={{width:`${charge*100}%`}}/></div><span>{golden?`${hud.boost.orbitCaught} / ${ORBIT_SEEDS}`:'+500 / ORBIT'}</span></div>}
        <div className="canvas-wrap"><canvas ref={canvas}
          aria-label="Aim the collector by moving the mouse. On a phone, hold and drag a finger on the wheel. Left and right arrow keys or A and D also work. Catch gold seeds, avoid blue glitches."
          style={{touchAction:phase==='playing'?'none':'pan-y',cursor:phase==='playing'?'crosshair':'default'}}
          onPointerMove={e=>aim(e)}
          onPointerDown={e=>{if(!playing.current||!e.isPrimary||(e.pointerType==='mouse'&&e.button!==0))return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);aim(e,true);}}
          onPointerUp={e=>{if(!e.isPrimary)return;if(e.pointerType==='mouse'&&pointer.current){const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)releasePointer();else pointer.current.held=false;}else releasePointer();}}
          onPointerCancel={e=>{if(e.isPrimary)releasePointer();}}
          onPointerLeave={e=>{if(e.isPrimary&&!pointer.current?.held)releasePointer();}}
          onLostPointerCapture={e=>{if(!e.isPrimary)return;if(e.pointerType!=='mouse')releasePointer();else if(pointer.current)pointer.current.held=false;}}/>
          {phase!=='playing'&&<div className={`game-overlay ${phase==='finished'?'result-overlay':''}`}>
            {phase==='ready'?<><h2>Ready to roll?</h2><p>Catch gold seeds.<br/>Avoid blue glitches.</p></>:<><span className="overlay-kicker">{hud.boost&&hud.lives>0?'BOOST COMPLETE':'GAME OVER'}</span><h2>{hud.score.toLocaleString()}<small> POINTS</small></h2><p>{hud.catches} seeds{hud.boost?` · ${hud.boost.orbits} perfect orbits`:hud.score>=activeBest&&hud.score>0?' · Personal best!':''}</p><div className="save-status" role="status">{saved}</div></>}
            <button className="start-button" onClick={()=>hud.boost?startBoost(!hud.boost.eventId||!eventOpen||event?.id!==hud.boost.eventId):start()} disabled={busy||saving}>{busy||saving?<Loader2 size={18} className="spin"/>:phase==='ready'?<Play size={16} fill="currentColor"/>:<RotateCcw size={16}/>} {phase==='ready'?(address?'PLAY RANKED':'PLAY'):'PLAY AGAIN'}<ArrowUpRight size={19}/></button>
            {!hud.boost&&eventOpen&&<button className="boost-button" onClick={()=>startBoost()} disabled={busy||saving}><Zap size={14}/> LIVE RUN <span>{time(Math.ceil(((event?.joinUntil||0)-clock)/1000))}</span></button>}
            {hud.boost?<button className="practice-link" onClick={resetArcade} disabled={busy||saving}>Back to arcade</button>:address&&<button className="practice-link" onClick={()=>start(true)} disabled={busy||saving}>or play a practice run</button>}
          </div>}{phase==='playing'&&(hud.boost&&hud.step-hud.boost.bonusAt<90?<div className="combo orbit-bonus">PERFECT ORBIT +500 <Zap size={14}/></div>:hud.combo>=3&&<div className="combo">{hud.combo} SEED STREAK <Zap size={14}/></div>)}
        </div>
        <div className="controls-bar"><span className="input-instructions"><span className="mouse-hint">MOVE MOUSE TO AIM</span><span className="finger-hint">HOLD & DRAG TO AIM</span></span><span className="personal-best">{hud.boost?'BOOST BEST':'DEVICE BEST'} <b>{activeBest.toLocaleString()}</b></span></div>
      </section>
      <section className="leaderboard" id="leaderboard" aria-labelledby="board-title"><div className="board-heading"><h2 id="board-title">LEADERBOARD</h2><div className="board-filter"><div className="board-tabs" role="group" aria-label="Leaderboard mode"><button aria-pressed={boardMode==='arcade'} onClick={()=>chooseBoard('arcade')}>ALL TIME</button><button aria-pressed={boardMode==='boost'} onClick={()=>chooseBoard('boost')}><Zap size={11}/> BOOST</button></div><span>{total} {total===1?'KEEPER':'KEEPERS'}</span></div></div>{boardMode==='boost'&&<div className="event-board-label">{boardEvent?`${clock>=boardEvent.openedAt&&clock<boardEvent.joinUntil?'LIVE EVENT':'LAST EVENT'} · ${boardEvent.rpm.toFixed(1)} RPM · 75s`:'BOOST EVENTS'}</div>}<div className="board-table" aria-busy={boardLoading}><div className="board-row table-head"><span>RANK</span><span>KEEPER</span><span>SEEDS</span><span>BEST SCORE</span></div>
        {rows.length?rows.slice(0,7).map((r,i)=><div key={r.address} className={`board-row ${r.address===address?'your-row':''}`}><span className={`rank rank-${i}`}>{i===0?<Trophy size={16}/>:String(i+1).padStart(2,'0')}</span><span className="keeper"><i style={{background:`hsl(${parseInt(r.address.slice(-4),16)%360} 32% 65%)`}}/><b>{short(r.address)}</b>{r.address===address&&<small>YOU</small>}</span><span>{r.catches}</span><strong>{r.score.toLocaleString()}</strong></div>):<div className="empty-board"><Trophy size={25}/><div><h3>{boardLoading?'Loading scores…':boardError?'Scores unavailable':boardMode==='boost'&&!boardEvent?'Waiting for the next Boost':'No ranked scores yet'}</h3><p>{boardLoading?'':boardError?'Refresh to try again.':boardMode==='boost'&&!boardEvent?'Starts when Squeektoshi runs.':address?'Set the first score.':'Connect a wallet to join.'}</p></div>{!boardLoading&&<button onClick={boardError?refreshBoard:boardMode==='boost'&&(!boardEvent||clock>=boardEvent.joinUntil)?()=>startBoost(true):address?()=>boardMode==='boost'?startBoost():start():()=>setWalletOpen(true)} disabled={busy||saving||phase==='playing'}>{boardError?'RETRY':boardMode==='boost'&&(!boardEvent||clock>=boardEvent.joinUntil)?'PRACTICE BOOST':address?'PLAY':'CONNECT WALLET'}<ArrowUpRight size={15}/></button>}</div>}
        {me&&!rows.slice(0,7).some(r=>r.address===me.address)&&<div className="board-row your-row"><span>—</span><span className="keeper"><b>{short(me.address)}</b><small>YOU</small></span><span>{me.catches}</span><strong>{me.score}</strong></div>}</div><div className="board-bottom"><button onClick={refreshBoard}><RotateCcw size={12}/> REFRESH</button></div></section>
      <aside className="side-column" aria-label="Live hamster status"><section className={`pulse-card ${eventOpen?'charged':''}`}><div className="card-top"><span className="tiny-label">SQUEEKCHAIN</span><span className={`live-badge ${isLive?'':'offline'}`}><i/>{isLive?'LIVE':'OFFLINE'}</span></div><div className="pulse-heading"><Hamster size={53}/><div><h2>Squeektoshi</h2><p>{label}</p></div></div><div className="pulse-metrics"><div><span>WHEEL SPEED</span><strong>{live?.rpm==null?'—':live.rpm.toFixed(1)}<small> RPM</small></strong></div><div><span>SETTLED BLOCK</span><strong>{live?.height?`#${Number(live.height).toLocaleString()}`:'—'}</strong></div></div><p className="boost-explanation">When Squeektoshi runs, a 75-second bonus mode opens. Catch all 12 golden seeds for +500.</p><div className="waveform" aria-hidden="true">{Array.from({length:42},(_,i)=><i key={i} style={{height:`${isLive&&(live?.rpm||0)>0?8+Math.abs(Math.sin(i*1.7))*24:3}px`,animationDelay:`${i*.06}s`}}/>)}</div>{eventOpen&&<button className="boost-button" onClick={()=>startBoost()} disabled={busy||saving||phase==='playing'}><Zap size={14}/> JOIN BOOST <span>{time(Math.ceil(((event?.joinUntil||0)-clock)/1000))}</span></button>}<button className="practice-link boost-preview" onClick={()=>startBoost(true)} disabled={busy||saving||phase==='playing'}><Zap size={12}/> Practice Boost</button>{!isLive&&<p className="pulse-note">{eventOpen?'Boost stays open on stored energy.':'Practice available. Ranked runs resume when the feed returns.'}</p>}<a href={live?.transaction?`https://eth-sepolia.blockscout.com/tx/${live.transaction}`:'https://docs.squeekchain.com/developers/api/'} target="_blank" rel="noopener noreferrer">{live?.transaction?'View settlement':'Data source'}<ArrowUpRight size={14}/></a></section></aside></div>
    </main><footer><span>© {new Date().getFullYear()} WHEELKEEPERS</span><a href="https://docs.squeekchain.com/developers/api/" target="_blank" rel="noopener noreferrer">DATA & DOCS <ExternalLink size={10}/></a></footer>
    {toast&&<div className="toast" role="status"><span>{toast}</span><button onClick={()=>setToast('')} aria-label="Dismiss notification"><X size={17}/></button></div>}
    {(walletOpen||help)&&<div className="modal-backdrop" onClick={()=>{setWalletOpen(false);setHelp(false);}}><section className="modal" role="dialog" aria-modal="true" aria-label={help?'How to play':'Connect wallet'} onClick={e=>e.stopPropagation()}><button className="close-modal" onClick={()=>{setWalletOpen(false);setHelp(false);}} aria-label="Close dialog"><X size={19}/></button><span className="eyebrow">{help?'THE KEEPER’S MANUAL':'YOUR WALLET IS YOUR PLAYER ID'}</span><h2>{help?'FIND YOUR ORBIT.':'HELLO, KEEPER.'}</h2>
      {help?<><p>Move the mouse around the wheel to aim the gold collector. On mobile, hold and drag a finger on the game field. You can also hold <kbd>←</kbd> / <kbd>→</kbd>, <kbd>A</kbd> / <kbd>D</kbd> for keyboard control.</p><ol><li>Catch gold seeds at the outer ring: <b>50 points</b> each.</li><li>Every 3 seeds in a streak adds +10 points per catch, up to +50.</li><li>Avoid blue glitches. Each hit costs a heart.</li><li>Keep going as long as you can. The pace keeps climbing: seeds get faster and glitches more frequent. The run ends when all three hearts are gone.</li></ol><p><b>Boost:</b> when Squeektoshi starts running, a 90-second entry window opens. Each run lasts up to 75 seconds. RPM at the start of the event sets the shared wave pattern. Follow all 12 golden seeds around the wheel for a +500 perfect-orbit bonus. Boost scores have their own event board. Practice Boost is always available in the Squeekchain card. Press Exit or Escape to leave a run.</p><p>Courses use the official Squeekchain API’s latest settled block. Ordinary ranked runs add a fresh server seed; Boost participants share one event course. Guest scores stay on your device. Ranked runs require a wallet signature, normal-speed play and server replay verification.</p><p className="fineprint">Replay verification rejects invalid scores and impossible inputs, but cannot eliminate automated play. This independent game does not grant Aura, WL or tokens. Live status and ranked play connect to our server at wheelkeepers.dpdns.org. Fonts are hosted with this site.</p></>:<><p>Sign one message to save your scores.<br/>No transactions. No token approvals. No gas.</p><div className="wallet-list">{wallets.map((w,i)=><button key={i} disabled={busy} onClick={()=>connect(w.provider)}><Wallet size={20}/>{w.name}{busy?<Loader2 size={17} className="spin"/>:<ArrowUpRight size={18}/>}</button>)}</div>{!wallets.length&&<div className="no-wallet"><Wallet size={25}/><b>No browser wallet detected</b><p>Open this site in your wallet’s built-in browser on mobile, or enable an Ethereum wallet extension on desktop.</p></div>}<p className="fineprint">Supports Ethereum wallets with message signing. Your public wallet address and best score appear on the board. Guest runs do not require a wallet.</p><button className="practice-link" onClick={()=>{setWalletOpen(false);start(true);}}>Continue as a guest →</button></>}
    </section></div>}
  </div>;
}
