import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,mkdtemp,writeFile,readdir,access} from 'node:fs/promises';
import {resolve,extname,join} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';

const root=resolve('.');
const server=createServer(async(req,res)=>{
  try {const path=resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
    if(!path.startsWith(root+ '\\') && !path.startsWith(root+'/'))throw Error();
    const data=await readFile(path);res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json'}[extname(path)]||'application/octet-stream'));res.end(data);
  }catch{res.statusCode=404;res.end('Not found');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/tests/fixture.html`;
const extension=resolve('extension');
const profile=await mkdtemp(join(tmpdir(),'sql-typer-test-'));
let executablePath=process.env.SQL_TYPER_BROWSER || chromium.executablePath();
try{await access(executablePath);}catch{
  const cache=join(process.env.LOCALAPPDATA||tmpdir(),'ms-playwright');
  const candidates=(await readdir(cache)).filter(name=>/^chromium-\d+$/.test(name)).sort().reverse();
  if(!candidates.length)throw Error('请先运行 npx playwright install chromium。');
  executablePath=join(cache,candidates[0],'chrome-win64','chrome.exe');
}
const context=await chromium.launchPersistentContext(profile,{headless:true,
  executablePath,
  args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
const results=[];
async function check(name,fn){if(process.env.SQL_TYPER_CASE && !name.includes(process.env.SQL_TYPER_CASE))return;await fn();results.push(name);console.log('PASS',name);}
try {
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const page=await context.newPage();await page.goto(url);await page.waitForFunction(()=>window.ready);
  const tabId=await worker.evaluate(async url=>(await chrome.debugger.getTargets()).find(t=>t.url===url).tabId,url);
  // A service worker cannot message itself; extension popup context provides the sender.
  const extensionId=new URL(worker.url()).host;
  const popup=await context.newPage();await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const request=(type,settings={})=>popup.evaluate(args=>chrome.runtime.sendMessage(args),{type,...settings});
  const getStatus=async()=>(await request('status')).status;
  const waitState=async state=>{
    const end=Date.now()+25000;let value;
    while(Date.now()<end){value=await getStatus();if(value.state===state)return value;if(value.state==='error')throw Error(JSON.stringify(value));await new Promise(r=>setTimeout(r,80));}
    console.log('Diagnostic editor content',await page.evaluate(()=>({monaco:editor.getValue(),cursor:editor.getPosition(),options:editor.getRawOptions()})));
    throw Error('Timeout '+JSON.stringify(value));
  };
  const sql="-- 中文与缩进 👩‍💻\nSELECT\t'id', 'a''b', (1 + 2)\n  FROM students\n WHERE name = '张三';\n";
  async function begin(text,focus,interval=20){await page.bringToFront();await focus();const result=await request('start',{tabId,text,interval,delay:1});assert.equal(result.ok,true,result.error);await page.bringToFront();await focus();}

  await check('independent draft binds the source tab and types intact SQL after target focus erases clipboard',async()=>{
    assert.equal(await popup.locator('#open-window').count(),1,'An independent draft window must be available before returning to the target');
    await page.bringToFront();
    const opened=context.waitForEvent('page');
    await popup.evaluate(()=>document.getElementById('open-window').click());
    const draft=await opened;await draft.waitForLoadState();
    try {
      assert.equal(new URL(draft.url()).searchParams.get('target'),String(tabId));
      await draft.locator('#bound-target').waitFor({state:'visible'});
      // Model the site's clipboard overwrite without reading or changing the OS clipboard.
      await page.evaluate(text=>{window.clipboardForTest=text;
        window.eraseClipboardForTest=()=>{window.clipboardForTest=' ';};
        document.getElementById('plain').addEventListener('focus',window.eraseClipboardForTest);
      },sql);
      const copied=await page.evaluate(()=>clipboardForTest);
      await draft.locator('#sql').fill(copied);
      await draft.locator('#interval').fill('20');await draft.locator('#delay').fill('3');
      const closed=draft.waitForEvent('close');await draft.locator('#start').click();await closed;
      await page.bringToFront();await page.locator('#plain').focus();
      assert.equal(await page.evaluate(()=>clipboardForTest),' ');
      const state=await waitState('completed');assert.equal(state.tabId,tabId);
      assert.equal(await page.locator('#plain').inputValue(),sql);
      await page.locator('#plain').fill('');
    }finally{
      await page.evaluate(()=>{document.getElementById('plain').removeEventListener('focus',window.eraseClipboardForTest);delete window.eraseClipboardForTest;delete window.clipboardForTest;});
      if(!draft.isClosed())await draft.close();await request('stop');
    }
  });
  await check('closed bound target retains draft and reports error instead of using a different tab',async()=>{
    const temporary=await context.newPage();await temporary.goto(url+'?closed-target');
    const id=await worker.evaluate(async url=>(await chrome.debugger.getTargets()).find(t=>t.url===url).tabId,temporary.url());
    const draft=await context.newPage();await draft.goto(`chrome-extension://${extensionId}/popup.html?target=${id}`);
    await draft.locator('#sql').fill(sql);await temporary.close();
    await draft.locator('#start').click();await draft.locator('#error').waitFor({state:'visible'});
    assert.equal(await draft.locator('#sql').inputValue(),sql);assert.equal(draft.isClosed(),false);
    assert.notEqual((await getStatus()).state,'running');await draft.close();
  });
  await check('opening an independent window cannot discard an existing popup draft',async()=>{
    await popup.locator('#sql').fill(sql);await page.bringToFront();
    const count=context.pages().length;
    await popup.evaluate(()=>document.getElementById('open-window').click());
    await popup.locator('#error').waitFor({state:'visible'});
    assert.equal(await popup.locator('#sql').inputValue(),sql);assert.equal(context.pages().length,count);
    await popup.locator('#sql').fill('');
  });

  await check('native textarea preserves multiline SQL, spaces, tab, Unicode; no paste/Enter/Tab',async()=>{
    await begin(sql,()=>page.locator('#plain').focus());await waitState('completed');
    assert.equal(await page.locator('#plain').inputValue(),sql);
    const stats=await page.evaluate(()=>stats);assert.equal(stats.paste,0);assert.equal(stats.enter,0);assert.equal(stats.tab,0);assert.ok(stats.trusted>30);
  });
  await check('CodeMirror model matches the full SQL despite enabled bracket completion',async()=>{
    await begin(sql,()=>page.evaluate(()=>cm.focus()));await waitState('completed');assert.equal(await page.evaluate(()=>cm.getValue()),sql);
  });
  await check('Monaco model matches the full SQL with default editor settings',async()=>{
    const original=await page.evaluate(()=>{const names=['autoClosingQuotes','autoClosingBrackets','autoIndent','quickSuggestions'];return names.map(name=>editor.getOption(monaco.editor.EditorOption[name]));});
    await begin(sql,()=>page.evaluate(()=>editor.focus()));await waitState('completed');assert.equal(await page.evaluate(()=>editor.getValue().replace(/\r\n?/g,'\n')),sql);
    assert.deepEqual(await page.evaluate(()=>{const names=['autoClosingQuotes','autoClosingBrackets','autoIndent','quickSuggestions'];return names.map(name=>editor.getOption(monaco.editor.EditorOption[name]));}),original);
  });
  await check('pause and resume does not repeat or lose SQL characters',async()=>{
    await page.locator('#plain').fill('');await begin(sql,()=>page.locator('#plain').focus(),40);await waitState('running');
    await new Promise(r=>setTimeout(r,200));await request('pause');await waitState('paused');
    const partial=await page.locator('#plain').inputValue();await new Promise(r=>setTimeout(r,150));assert.equal(await page.locator('#plain').inputValue(),partial);
    await request('resume');await page.bringToFront();await page.locator('#plain').focus();await waitState('completed');assert.equal(await page.locator('#plain').inputValue(),sql);
  });
  await check('focus switch pauses and never types in another field',async()=>{
    await page.locator('#plain').fill('');await begin(sql,()=>page.locator('#plain').focus(),40);await waitState('running');
    await page.locator('#single').focus();await waitState('paused');assert.equal(await page.locator('#single').inputValue(),'');await request('stop');
  });
  await check('switching to another browser window still pauses input',async()=>{
    await page.locator('#plain').fill('');await begin(sql,()=>page.locator('#plain').focus(),50);await waitState('running');
    const other=await worker.evaluate(()=>chrome.windows.create({url:'about:blank',type:'popup',focused:true}));
    try {
      await worker.evaluate(id=>chrome.windows.update(id,{focused:true}),other.id);
      assert.equal(await worker.evaluate(async id=>(await chrome.windows.get(id)).focused,other.id),true,'The other window must really gain focus');
      await waitState('paused');const partial=await page.locator('#plain').inputValue();
      await new Promise(r=>setTimeout(r,180));assert.equal(await page.locator('#plain').inputValue(),partial);
    }finally{
      await request('stop');await worker.evaluate(id=>chrome.windows.remove(id),other.id);
      await worker.evaluate(async id=>chrome.windows.update((await chrome.tabs.get(id)).windowId,{focused:true}),tabId);
      await page.bringToFront();
    }
  });
  await check('single line pauses on newline and never sends Enter',async()=>{
    await begin('SELECT 1;\nSELECT 2;',()=>page.locator('#single').focus());await waitState('paused');assert.equal(await page.locator('#single').inputValue(),'SELECT 1;');await request('stop');
  });
  await check('contenteditable receives multiline SQL through browser input',async()=>{
    await begin('SELECT 1;\n  SELECT 2;',()=>page.locator('#rich').focus());await waitState('completed');assert.equal(await page.locator('#rich').innerText(),'SELECT 1;\n  SELECT 2;');
  });
  await check('paused countdown resumes and stop halts an active task',async()=>{
    await page.locator('#plain').fill('');await begin(sql,()=>page.locator('#plain').focus(),50);
    await request('pause');await waitState('paused');assert.equal(await page.locator('#plain').inputValue(),'');
    await request('resume');await page.bringToFront();await page.locator('#plain').focus();await waitState('running');
    await request('stop');await waitState('stopped');
    const partial=await page.locator('#plain').inputValue();await new Promise(r=>setTimeout(r,180));assert.equal(await page.locator('#plain').inputValue(),partial);
    const extensionStillAttached=await worker.evaluate(async tabId=>{
      try{await chrome.debugger.sendCommand({tabId},'Runtime.evaluate',{expression:'1'});return true;}catch{return false;}
    },tabId);
    assert.equal(extensionStillAttached,false);
  });
  await check('model options restore after unexpected debugger detach',async()=>{
    await page.evaluate(()=>editor.setValue(''));await begin(sql,()=>page.evaluate(()=>editor.focus()),50);await waitState('running');
    await worker.evaluate(tabId=>chrome.debugger.detach({tabId}),tabId);await waitState('error');
    await page.waitForFunction(()=>editor.getOption(monaco.editor.EditorOption.autoClosingQuotes)==='languageDefined',{},{timeout:12000});
  });
  await check('starting again before the old watchdog restores preserves original Monaco options',async()=>{
    await page.evaluate(()=>editor.setValue(''));await begin(sql,()=>page.evaluate(()=>editor.focus()),50);await waitState('running');
    await worker.evaluate(tabId=>chrome.debugger.detach({tabId}),tabId);await waitState('error');
    await page.evaluate(()=>editor.setValue(''));await begin('SELECT 2;',()=>page.evaluate(()=>editor.focus()));await waitState('completed');
    assert.equal(await page.evaluate(()=>editor.getOption(monaco.editor.EditorOption.autoClosingQuotes)),'languageDefined');
    assert.equal(await page.evaluate(()=>editor.getValue()),'SELECT 2;');
  });
  await check('component-wrapped Monaco works without window.monaco (Educoder structure)',async()=>{
    const options=await page.evaluate(()=>{window.monacoForTest=window.monaco;editor.dispose();
      window.editor=monacoForTest.editor.create(document.getElementById('monaco'),{value:'',language:'sql',autoIndent:'full',formatOnType:true});
      document.getElementById('monaco').__reactFiber$sqlTest={memoizedState:null,return:{memoizedState:{memoizedState:{current:{instance:editor}},next:null},return:null}};
      delete window.monaco;
      return ['autoClosingQuotes','autoIndent','formatOnType'].map(key=>editor.getOption(monacoForTest.editor.EditorOption[key]));
    });
    try{
      await begin(sql,()=>page.evaluate(()=>editor.focus()));await waitState('completed');
      assert.equal(await page.evaluate(()=>editor.getValue().replace(/\r\n?/g,'\n')),sql);
      assert.deepEqual(await page.evaluate(()=>['autoClosingQuotes','autoIndent','formatOnType'].map(key=>editor.getOption(monacoForTest.editor.EditorOption[key]))),options);
    }finally{await page.evaluate(()=>{window.monaco=window.monacoForTest;delete window.monacoForTest;delete document.getElementById('monaco').__reactFiber$sqlTest;});await request('stop');}
  });
  if(!process.env.SQL_TYPER_SKIP_IMAGES && !process.env.SQL_TYPER_CASE) {
    await page.bringToFront();await page.screenshot({path:resolve('tests/fixture-result.png'),fullPage:true});
    await popup.bringToFront();await request('stop');await popup.locator('#sql').fill(sql);await popup.locator('body').screenshot({path:resolve('tests/popup-preview.png')});
  }
  const reportName=executablePath.toLowerCase().includes('msedge')?'edge':'chromium';
  if(!process.env.SQL_TYPER_CASE)await writeFile(resolve(`docs/test-results-${reportName}.md`),`# Browser verification\n\n${new Date().toISOString()}\n\nBrowser: ${context.browser().version()} (${reportName}; headless; actual MV3 extension).\n\n${results.map(name=>'- PASS '+name).join('\n')}\n\n完整扩展队列测试使用本地测试页；头歌真实页面的适配器和输入引擎验证见 educoder-verification.md。\n`);
}finally{await context.close();await new Promise(resolve=>server.close(resolve));}
