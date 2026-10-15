export function splitText(text) {
  return Array.from(new Intl.Segmenter('zh', {granularity:'grapheme'}).segment(text.replace(/\r\n?/g, '\n')), item => item.segment);
}

export function withDeadline(operation, milliseconds, label) {
  let timer;
  const deadline=new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(Object.assign(Error(`${label}超时。请停止任务并检查编辑区；不要直接重试最后一个字符。`),{fatal:true})),milliseconds);
  });
  return Promise.race([operation,deadline]).finally(()=>clearTimeout(timer));
}

export function validateSettings({text, interval, delay}) {
  if (typeof text !== 'string' || !text.length) throw Error('请先输入 SQL 文本。');
  if (text.length > 200000) throw Error('单次最多输入 200,000 个字符。');
  interval = Number(interval); delay = Number(delay);
  if (!Number.isInteger(interval) || interval < 20 || interval > 2000) throw Error('字符间隔需为 20–2000 毫秒。');
  if (!Number.isInteger(delay) || delay < 1 || delay > 30) throw Error('倒计时需为 1–30 秒。');
  return {text, interval, delay};
}

export class TypingJob {
  constructor(text, {interval, send, guard, after = async()=>{}, notify = ()=>{}, sleep = ms=>new Promise(r=>setTimeout(r,ms))}) {
    this.units = splitText(text); this.index = 0; this.state = 'running'; this.message = '';
    Object.assign(this, {interval, send, guard, after, notify, sleep});
    this.pump = null;
  }
  snapshot() { return {state:this.state, index:this.index, total:this.units.length, message:this.message}; }
  pause(message = '已暂停，请回到原输入位置后继续。') {
    if(this.state === 'running') {this.state = 'paused'; this.message = message; this.notify(this.snapshot());}
  }
  resume() {if(this.state === 'paused') {this.state='running'; this.message='';}}
  stop() {if(['running','paused'].includes(this.state)) {this.state='stopped'; this.message='已停止'; this.notify(this.snapshot());}}
  interrupt(error) {
    if(this.state==='stopped')return;
    if(error.fatal) {this.state='error';this.message=`输入连接中断，请核对已输入内容后重新开始。${error.message}`;this.notify(this.snapshot());}
    else this.pause(error.message);
  }
  run() {
    if(this.pump) return this.pump;
    this.pump = this.loop().finally(()=>{this.pump=null;});
    return this.pump;
  }
  async loop() {
    if(this.state==='running' && this.index===this.units.length) {
      this.state='completed';this.message='输入完成';this.notify(this.snapshot());return;
    }
    while(this.state === 'running' && this.index < this.units.length) {
      const char = this.units[this.index];
      try {await this.guard(char);} catch(error) {this.interrupt(error); break;}
      if(this.state !== 'running') break;
      try {await this.send(char); this.index++;}
      catch(error) {
        if(this.state!=='stopped') {this.state='error'; this.message=`输入连接中断，最后一个字符是否写入无法确认。请核对后重新开始。${error.message}`;}
        this.notify(this.snapshot());break;
      }
      try {await this.after(char);} catch(error) {this.interrupt(error);}
      this.notify(this.snapshot());
      if(this.state !== 'running') break;
      if(this.index === this.units.length) {this.state='completed'; this.message='输入完成'; this.notify(this.snapshot()); break;}
      await this.sleep(this.interval);
    }
  }
}
