import {TypingJob, validateSettings, withDeadline} from './core.js';
import {pageGuard} from './guard.js';

let session = null;
let lastStatus = {state:'idle',index:0,total:0,message:'准备好 SQL 后，点击开始。'};
const sleep = ms=>new Promise(resolve=>setTimeout(resolve,ms));
const terminal = state=>['completed','stopped','error'].includes(state);

function status() {
  if(!session) return lastStatus;
  const s=session;
  return {...(s.job?s.job.snapshot():{state:s.state,index:0,total:s.total,message:s.message}),
    ...(s.state==='countdown'?{state:'countdown',message:s.message}:{}),
    tabId:s.tabId,title:s.title,kind:s.kind,verified:s.verified,remaining:s.remaining};
}
function publish() {
  const snapshot=status();
  const labels={running:snapshot.index?`${Math.floor(snapshot.index/(snapshot.total||1)*100)}%`:'0',countdown:String(snapshot.remaining??''),paused:'暂停',completed:'完成',error:'!'};
  chrome.action.setBadgeText({text:labels[snapshot.state]||''}).catch(()=>{});
  chrome.action.setBadgeBackgroundColor({color:snapshot.state==='error'?'#be4949':'#246b58'}).catch(()=>{});
}
async function evaluate(s, operation, char='') {
  const expression=`(${pageGuard.toString()})(${JSON.stringify(operation)},${JSON.stringify(s.key)},${JSON.stringify(char)})`;
  let response;
  try {response=await withDeadline(chrome.debugger.sendCommand({tabId:s.tabId},'Runtime.evaluate',{expression,returnByValue:true}),5000,'读取编辑区');}
  catch(error) {error.fatal=true;throw error;}
  const result=response.result?.value;
  if(response.exceptionDetails || !result?.ok) throw Error(result?.message||'无法读取编辑区，请停止后重新开始。');
  return result;
}
async function guard(s,char) {
  const [tab,window]=await Promise.all([chrome.tabs.get(s.tabId),chrome.windows.get(s.windowId)]);
  if(!tab.active || !window.focused) throw Error('标签页或窗口失去焦点，请返回原页面后继续。');
  await evaluate(s,'before',char);
}
function pause(s,message) {
  if(s.finishing) return;
  s.version++;
  s.state='paused';
  if(s.job) s.job.pause(message);
  else {s.state='paused';s.message=message;}
  if(s.attached) void evaluate(s,'suspend').catch(()=>{});
  publish();
}
async function finish(s,state,message) {
  if(s.finishing) return s.finishing;
  s.version++;
  clearInterval(s.heartbeatTimer);
  // Install the promise before any async work, so stop and pump completion share cleanup.
  s.finishing=Promise.resolve().then(async()=>{
    if(state==='stopped' && s.attached) {
      try {await withDeadline(evaluate(s,'release'),500,'释放编辑区');} catch {}
      try {await withDeadline(chrome.debugger.detach({tabId:s.tabId}),2000,'释放输入连接');} catch {}
      s.attached=false;
    }
    if(s.job?.pump) await s.job.pump;
    if(s.attached) {
      try {await evaluate(s,'release');} catch {}
      try {await withDeadline(chrome.debugger.detach({tabId:s.tabId}),2000,'释放输入连接');} catch {}
    }
    if(session===s) {
      lastStatus={...status(),state,message,remaining:undefined};
      session=null; s.text=''; if(s.job) s.job.units=[];
      publish();
    }
  });
  return s.finishing;
}
async function pump(s) {
  await s.job.run();
  if(terminal(s.job.state)) await finish(s,s.job.state,s.job.message);
}
async function countdown(s, delay) {
  const version=++s.version;
  s.state='countdown';s.message='请点击目标 SQL 编辑区';s.remaining=delay;
  const deadline=Date.now()+delay*1000;
  while(Date.now()<deadline) {
    if(session!==s || version!==s.version || s.finishing) return;
    s.remaining=Math.max(1,Math.ceil((deadline-Date.now())/1000));publish();await sleep(100);
  }
  if(session!==s || version!==s.version || s.finishing) return;
  try {
    const [tab,window]=await Promise.all([chrome.tabs.get(s.tabId),chrome.windows.get(s.windowId)]);
    if(!tab.active||!window.focused) throw Error('请返回开始时的网页并点击编辑区，然后继续。');
    if(!s.job) {
      const target=await evaluate(s,'capture');s.kind=target.kind;s.verified=target.verified;
      s.job=new TypingJob(s.text,{interval:s.interval,send:char=>withDeadline(chrome.debugger.sendCommand({tabId:s.tabId},'Input.insertText',{text:char}),5000,'输入字符'),
        guard:char=>guard(s,char),after:char=>evaluate(s,'after',char),notify:snapshot=>{
          if(snapshot.state==='paused') {s.state='paused';void evaluate(s,'suspend').catch(()=>{});}
          publish();
        }});
      s.text='';
    } else {await guard(s,s.job.units[s.job.index]||'');}
    if(version!==s.version || s.finishing) {s.job.pause('已暂停'); return;}
    s.remaining=undefined;s.job.resume();s.state='running';
    void pump(s).catch(error=>finish(s,'error',error.message));
  } catch(error) {
    if(error.fatal) {s.job?.stop();await finish(s,'error','浏览器输入连接已断开，请核对代码后重新开始。');}
    else pause(s,error.message);
  }
}
async function start(message) {
  if(session) throw Error('已有输入任务，请先停止。');
  const settings=validateSettings(message);
  const s={...settings,tabId:message.tabId,key:`__sqlTyper_${crypto.randomUUID().replaceAll('-','')}`,
    state:'countdown',total:Array.from(new Intl.Segmenter('zh',{granularity:'grapheme'}).segment(settings.text.replace(/\r\n?/g,'\n'))).length,
    version:0,attached:false};
  session=s;
  try {
    const tab=await chrome.tabs.get(s.tabId);
    const target=(await chrome.debugger.getTargets()).find(target=>target.tabId===s.tabId);
    if(!/^https?:/.test(target?.url||'')) throw Error('请在普通 HTTP / HTTPS 网页上使用；浏览器内部页面不支持。');
    s.windowId=tab.windowId;s.title=target.title;
    const connecting=chrome.debugger.attach({tabId:s.tabId},'1.3');
    connecting.then(()=>{if(session!==s || s.finishing)void chrome.debugger.detach({tabId:s.tabId}).catch(()=>{});}).catch(()=>{});
    await withDeadline(connecting,5000,'连接网页');s.attached=true;
    if(s.finishing) {await chrome.debugger.detach({tabId:s.tabId}).catch(()=>{});return;}
    s.heartbeatTimer=setInterval(()=>{
      if(session===s && !s.finishing) void evaluate(s,'heartbeat').catch(error=>{
        if(error.fatal && !s.finishing) {s.job?.stop();void finish(s,'error','浏览器输入连接已断开，请核对代码后重新开始。');}
      });
    },1500);
    void countdown(s,s.delay);
  } catch(error) {await finish(s,'error',`无法开始：${error.message}`);throw error;}
}
async function resume(s) {
  if(!s || s.finishing) throw Error('没有可继续的任务。');
  if(s.state==='countdown' || s.job?.state==='running') return;
  if(s.job?.pump) await s.job.pump;
  if(s.finishing || (s.job && s.job.state!=='paused')) return;
  // Keep the job paused until the target is rechecked after countdown.
  void countdown(s,s.delay);
}
async function stop() {
  if(!session) return;
  const s=session;s.job?.stop();await finish(s,'stopped','已停止，已输入的内容保留。');
}
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(sender.id!==chrome.runtime.id) return;
  (async()=>{
    switch(message.type) {
      case 'status': return {ok:true,status:status()};
      case 'start': await start(message);break;
      case 'pause': if(session) pause(session,'已暂停，请回到原编辑区后继续。');break;
      case 'resume': await resume(session);break;
      case 'stop': await stop();break;
      default: throw Error('未知操作');
    }
    return {ok:true,status:status()};
  })().then(sendResponse,error=>sendResponse({ok:false,error:error.message}));
  return true;
});
chrome.commands.onCommand.addListener(command=>{
  if(command==='stop') {void stop();return;}
  if(command==='toggle-pause' && session) {
    if(session.state==='countdown'||session.job?.state==='running') pause(session,'快捷键暂停');
    else void resume(session).catch(()=>{});
  }
});
chrome.tabs.onActivated.addListener(({tabId,windowId})=>{
  if(session && windowId===session.windowId && tabId!==session.tabId) pause(session,'切换了标签页，请返回原页面后继续。');
});
chrome.windows.onFocusChanged.addListener(windowId=>{
  if(session && windowId!==session.windowId) pause(session,'切换了窗口，请返回原窗口后继续。');
});
chrome.tabs.onUpdated.addListener((tabId,change)=>{
  if(session?.tabId===tabId && (change.status==='loading'||change.url)) {const s=session;s.job?.stop();void finish(s,'error','网页已刷新或跳转。请核对已输入内容后重新开始。');}
});
chrome.tabs.onRemoved.addListener(tabId=>{
  if(session?.tabId===tabId) {const s=session;s.job?.stop();void finish(s,'stopped','目标标签页已关闭。');}
});
chrome.debugger.onDetach.addListener(source=>{
  if(session?.tabId===source.tabId && !session.finishing) {const s=session;s.attached=false;s.job?.stop();void finish(s,'error','浏览器输入连接已断开，请核对最后一个字符后重新开始。');}
});
