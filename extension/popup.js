import {splitText,validateSettings} from './core.js';
const $=id=>document.getElementById(id);
const labels={idle:'准备输入',countdown:'准备开始',running:'正在逐字输入',paused:'已暂停',completed:'输入完成',stopped:'已停止',error:'需要核对'};
const params=new URLSearchParams(location.search);
const detached=params.has('target');
const boundTabId=detached?Number(params.get('target')):null;
let busy=false;
async function targetTab() {
  if(detached && (!Number.isSafeInteger(boundTabId)||boundTabId<=0))throw Error('目标标签页无效，请从原网页重新打开独立窗口。');
  let tab;
  try {tab=detached?await chrome.tabs.get(boundTabId):(await chrome.tabs.query({active:true,currentWindow:true}))[0];}
  catch {throw Error('原网页已关闭，请保留或取回草稿，再从目标网页重新打开独立窗口。');}
  if(!tab?.id)throw Error('没有找到目标网页，请从目标网页打开插件。');
  const target=(await chrome.debugger.getTargets()).find(target=>target.tabId===tab.id);
  if(!/^https?:/.test(target?.url||''))throw Error('请从普通 HTTP / HTTPS 网页打开插件；浏览器新标签页和地址栏不支持。');
  return {...tab,title:target.title};
}
async function focusTarget(tab) {
  await chrome.tabs.update(tab.id,{active:true});
  await chrome.windows.update(tab.windowId,{focused:true});
}
function render(s) {
  $('state').textContent=labels[s.state]||s.state;
  $('progress-text').textContent=`${s.index||0} / ${s.total||0}`;
  $('progress').max=s.total||1;$('progress').value=s.index||0;
  $('message').textContent=s.state==='countdown'?`${s.remaining||''} 秒后开始。请点击原网页的 SQL 编辑区。`:s.message;
  $('target').textContent=s.kind?`${s.kind}${s.verified?' · 逐字核对内容':' · 无法逐字核对，请自行检查'}${s.title?' · '+s.title:''}`:'';
  const active=['running','paused','countdown'].includes(s.state);
  $('start').hidden=active;$('pause').hidden=!['running','countdown'].includes(s.state);
  $('resume').hidden=s.state!=='paused';$('stop').hidden=!active;
  $('sql').disabled=active;$('interval').disabled=active;$('delay').disabled=active;
}
async function request(message) {const result=await chrome.runtime.sendMessage(message);if(!result?.ok)throw Error(result?.error||'插件连接中断，请重新打开。');return result;}
async function refresh(){if(busy)return;try{render((await request({type:'status'})).status);}catch(error){$('error').textContent=error.message;$('error').hidden=false;}}
async function act(type) {
  if(busy)return;busy=true;$('error').hidden=true;
  for(const button of document.querySelectorAll('button'))button.disabled=true;
  try {
    let message={type};
    if(type==='start') {
      const settings=validateSettings({text:$('sql').value,interval:$('interval').value,delay:$('delay').value});
      const tab=await targetTab();
      message={type,tabId:tab.id,...settings};
      await chrome.storage.local.set({settings:{interval:settings.interval,delay:settings.delay}});
      // The draft is already captured; site focus may now overwrite the clipboard safely.
      if(detached)await focusTarget(tab);
    }
    if(type==='resume' && detached){const current=(await request({type:'status'})).status;await focusTarget(await chrome.tabs.get(current.tabId));}
    render((await request(message)).status);
    if(type==='start'||type==='resume')window.close();
  }catch(error){$('error').textContent=error.message;$('error').hidden=false;}
  finally{busy=false;for(const button of document.querySelectorAll('button'))button.disabled=false;}
}
$('open-window').addEventListener('click',async()=>{
  if(busy)return;busy=true;$('open-window').disabled=true;$('error').hidden=true;
  try {
    if($('sql').value)throw Error('当前弹窗已有文本。为避免关闭弹窗丢失草稿，请先开始输入，或取回并清空文本后再打开独立窗口。');
    const tab=await targetTab();
    await chrome.windows.create({type:'popup',url:chrome.runtime.getURL(`popup.html?target=${tab.id}`),width:480,height:790});
  }catch(error){$('error').textContent=error.message;$('error').hidden=false;}
  finally{busy=false;$('open-window').disabled=false;}
});
for(const type of ['start','pause','resume','stop'])$(type).addEventListener('click',()=>act(type));
$('sql').addEventListener('input',()=>{$('count').textContent=`${splitText($('sql').value).length} 字符`;});
$('sql').addEventListener('keydown',event=>{
  if(event.key==='Tab'){event.preventDefault();const node=event.target;node.setRangeText('\t',node.selectionStart,node.selectionEnd,'end');node.dispatchEvent(new Event('input'));}
});
const {settings}=await chrome.storage.local.get('settings');
if(settings){$('interval').value=settings.interval;$('delay').value=settings.delay;}
if(detached){
  document.body.classList.add('detached');$('open-window').hidden=true;
  $('draft-note').textContent='现在去外部复制 SQL，直接回此窗口粘贴。开始后自动返回原网页，请在倒计时内点击编辑区。头歌仍可能改写系统剪贴板，已接收的 SQL 不受影响。';
  $('bound-target').hidden=false;
  try{$('bound-target').textContent=`输入到：${(await targetTab()).title||'原网页'}`;}
  catch(error){$('bound-target').textContent=error.message;}
}
await refresh();setInterval(refresh,350);
