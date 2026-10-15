import test from 'node:test';
import assert from 'node:assert/strict';
import { splitText, validateSettings, TypingJob, withDeadline } from '../extension/core.js';
import { pageGuard } from '../extension/guard.js';

test('SQL whitespace and Unicode are preserved; CRLF becomes browser LF', () => {
  const sql = "SELECT\t'中文👩‍💻é', 'a''b'\r\n  FROM t;\r\n-- 注释\r";
  const units = splitText(sql);
  assert.equal(units.join(''), sql.replace(/\r\n?/g, '\n'));
  assert.ok(units.includes('👩‍💻'));
  assert.ok(units.includes('é'));
});

test('settings reject empty text, invalid speed and unreasonable delay', () => {
  assert.throws(() => validateSettings({text:'', interval:100, delay:3}));
  assert.throws(() => validateSettings({text:'SQL', interval:0, delay:3}));
  assert.throws(() => validateSettings({text:'SQL', interval:100, delay:100}));
  assert.deepEqual(validateSettings({text:'  ', interval:100, delay:3}), {text:'  ', interval:100, delay:3});
});

test('pause and resume preserve exact cursor and never run two pumps', async () => {
  const output = [];
  let job;
  job = new TypingJob('SELECT 1;\n', {interval:1,
    send: async char => { output.push(char); if(output.length === 3) job.pause('test'); },
    guard: async () => {}, sleep: async () => {}, notify: () => {}
  });
  await job.run();
  assert.equal(job.state, 'paused');
  assert.equal(output.join(''), 'SEL');
  job.resume();
  await Promise.all([job.run(), job.run()]);
  assert.equal(output.join(''), 'SELECT 1;\n');
  assert.equal(job.state, 'completed');
});

test('stop during in-flight input counts it but sends no further character', async () => {
  const output = [];
  let release;
  const pending = new Promise(resolve => {release = resolve;});
  const job = new TypingJob('ABC', {interval:1, guard:async()=>{}, notify:()=>{}, sleep:async()=>{},
    send:async char => {output.push(char); await pending;}
  });
  const run = job.run();
  await new Promise(resolve => setImmediate(resolve));
  job.stop(); release(); await run;
  assert.equal(output.join(''), 'A');
  assert.equal(job.index, 1);
  assert.equal(job.state, 'stopped');
});

test('guard failure pauses before sending and transport ambiguity is terminal', async () => {
  let sends = 0;
  const job = new TypingJob('A', {interval:1, guard:async()=>{throw Error('焦点改变');},
    send:async()=>{sends++;}, notify:()=>{}, sleep:async()=>{}
  });
  await job.run(); assert.equal(job.state, 'paused'); assert.equal(sends, 0);
  const broken = new TypingJob('A', {interval:1, guard:async()=>{},
    send:async()=>{throw Error('断开');}, notify:()=>{}, sleep:async()=>{}
  });
  await broken.run(); assert.equal(broken.state, 'error');
  broken.resume(); assert.equal(broken.state, 'error');
});

test('resume after pausing during final input completes instead of hanging', async () => {
  let job;
  job=new TypingJob('A',{interval:1,guard:async()=>{},send:async()=>{job.pause();},notify:()=>{},sleep:async()=>{}});
  await job.run();assert.equal(job.index,1);assert.equal(job.state,'paused');
  job.resume();await job.run();assert.equal(job.state,'completed');
});

test('successful input checkpoint survives focus loss before readback', () => {
  const previous=globalThis.document;
  const node={tagName:'TEXTAREA',type:'textarea',closest:()=>null,isConnected:true,value:'',selectionStart:0,selectionEnd:0};
  const doc={activeElement:node,hasFocus:()=>true,defaultView:{}};
  globalThis.document=doc;
  try {
    assert.equal(pageGuard('capture','__sqlTyperTest').ok,true);
    node.value='A';node.selectionStart=node.selectionEnd=1;
    doc.activeElement={tagName:'BUTTON'};
    assert.equal(pageGuard('after','__sqlTyperTest','A').ok,false);
    doc.activeElement=node;
    assert.equal(pageGuard('before','__sqlTyperTest','B').ok,true);
  }finally{pageGuard('release','__sqlTyperTest');globalThis.document=previous;}
});

test('lost browser connection in guard or readback is terminal rather than resumable', async () => {
  const fatal=Object.assign(Error('debugger detached'),{fatal:true});
  for(const stage of ['guard','after']) {
    const options={interval:1,guard:async()=>{},after:async()=>{},send:async()=>{},notify:()=>{},sleep:async()=>{}};
    options[stage]=async()=>{throw fatal;};
    const job=new TypingJob('ABC',options);await job.run();assert.equal(job.state,'error');
  }
});

test('unresponsive browser command has a fatal deadline instead of running forever', async () => {
  await assert.rejects(withDeadline(new Promise(()=>{}), 15, '读取编辑区'), error=>error.fatal===true && /读取编辑区.*超时/.test(error.message));
  assert.equal(await withDeadline(Promise.resolve('ok'),100,'读取编辑区'),'ok');
});
