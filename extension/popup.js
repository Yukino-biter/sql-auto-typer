import {splitText,validateSettings} from './core.js';
const $=id=>document.getElementById(id);
const labels={idle:'准备输入',countdown:'准备开始',running:'正在逐字输入',paused:'已暂停',completed:'输入完成',stopped:'已停止',error:'需要核对'};
let busy=false;
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
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
      message={type,tabId:tab.id,...settings};
      await chrome.storage.local.set({settings:{interval:settings.interval,delay:settings.delay}});
    }
    render((await request(message)).status);
    if(type==='start'||type==='resume')window.close();
  }catch(error){$('error').textContent=error.message;$('error').hidden=false;}
  finally{busy=false;for(const button of document.querySelectorAll('button'))button.disabled=false;}
}
for(const type of ['start','pause','resume','stop'])$(type).addEventListener('click',()=>act(type));
$('sql').addEventListener('input',()=>{$('count').textContent=`${splitText($('sql').value).length} 字符`;});
$('sql').addEventListener('keydown',event=>{
  if(event.key==='Tab'){event.preventDefault();const node=event.target;node.setRangeText('\t',node.selectionStart,node.selectionEnd,'end');node.dispatchEvent(new Event('input'));}
});
const {settings}=await chrome.storage.local.get('settings');
if(settings){$('interval').value=settings.interval;$('delay').value=settings.delay;}
await refresh();setInterval(refresh,350);
