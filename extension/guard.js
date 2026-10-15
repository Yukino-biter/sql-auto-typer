// Runs in the page through Runtime.evaluate. Only reads content and selection;
// browser Input.insertText performs all actual text insertion.
export function pageGuard(operation, key, char = '') {
  const norm = value => value.replace(/\r\n?/g, '\n');
  function active() {
    let doc = document, element = doc.activeElement;
    for(let i=0; i<20; i++) {
      if(element?.shadowRoot?.activeElement) {element=element.shadowRoot.activeElement; continue;}
      if(element?.tagName === 'IFRAME') {
        try {doc = element.contentDocument; if(!doc) throw Error(); element=doc.activeElement; continue;}
        catch {throw Error('此跨域 iframe 暂不支持。请在编辑器所在页面直接使用。');}
      }
      break;
    }
    return {doc, element};
  }
  function adapter(element, doc) {
    const view = doc.defaultView;
    const cm = element.closest('.CodeMirror')?.CodeMirror;
    if(cm) return {kind:'CodeMirror', multiline:true, read:()=>({text:norm(cm.getValue()), start:cm.indexFromPos(cm.getCursor('from')), end:cm.indexFromPos(cm.getCursor('to'))})};
    function findMonaco() {
      const matches=editor=>typeof editor?.getModel==='function' && typeof editor?.getSelection==='function' &&
        typeof editor?.getRawOptions==='function' && typeof editor?.updateOptions==='function' && editor.getDomNode?.()?.contains(element);
      const exposed=view.monaco?.editor?.getEditors?.().find(matches);
      if(exposed)return exposed;
      // Educoder keeps the instance in a React useRef: current.instance.
      // Search only refs on nearby owning components; never modify React state.
      let node=element;
      for(let i=0;node && i<12;i++,node=node.parentElement) {
        const fiberKey=Object.keys(node).find(name=>name.startsWith('__reactFiber$')||name.startsWith('__reactInternalInstance$'));
        let fiber=fiberKey?node[fiberKey]:null;
        for(let j=0;fiber && j<16;j++,fiber=fiber.return) {
          const candidates=[fiber.ref?.current,fiber.stateNode?.editor,fiber.stateNode?.editorRef?.current];
          let hook=fiber.memoizedState;
          for(let k=0;hook && k<32;k++,hook=hook.next) candidates.push(hook.memoizedState?.current);
          for(const candidate of candidates) {
            for(const editor of [candidate,candidate?.instance,candidate?.editor])if(matches(editor))return editor;
          }
        }
      }
      return null;
    }
    const monaco = findMonaco();
    if(monaco) {
      const model = monaco.getModel();
      const enums=view.monaco?.editor?.EditorOption;
      if(enums?monaco.getOption(enums.readOnly):monaco.getRawOptions().readOnly) throw Error('这个代码编辑器是只读的。');
      const overrides={autoIndent:'none',autoClosingBrackets:'never',autoClosingQuotes:'never',autoSurround:'never',formatOnType:false,quickSuggestions:false,suggestOnTriggerCharacters:false};
      let original=null;
      const activate=()=>{
        if(original)return;
        original={};
        for(const name of Object.keys(overrides)) {
          let value=enums?monaco.getOption(enums[name]):monaco.getRawOptions()[name];
          if(name==='autoIndent' && typeof value==='number')value=['none','keep','brackets','advanced','full'][value];
          original[name]=value;
        }
        monaco.updateOptions(overrides);
      };
      const release=()=>{if(original){monaco.updateOptions(original);original=null;}};
      return {kind:'Monaco', multiline:true, activate, release, read:()=>{
        if(monaco.getModel() !== model) throw Error('编辑器切换了文件，请停止后重新开始。');
        const selection=monaco.getSelection();
        const offset=position=>norm(model.getValueInRange({startLineNumber:1,startColumn:1,endLineNumber:position.lineNumber,endColumn:position.column})).length;
        return {text:norm(model.getValue()), start:offset(selection.getStartPosition()), end:offset(selection.getEndPosition())};
      }};
    }
    const ace = element.closest('.ace_editor')?.env?.editor;
    if(ace) return {kind:'Ace', multiline:true, read:()=>{const range=ace.getSelectionRange(), doc=ace.session.doc; return {text:norm(ace.getValue()), start:doc.positionToIndex(range.start), end:doc.positionToIndex(range.end)};}};
    if(element.closest('.monaco-editor, .ace_editor, .cm-editor')) throw Error('无法读取这个编辑器的代码模型，暂不支持。请提供编辑器信息以便适配。');
    if(['TEXTAREA','INPUT'].includes(element.tagName)) {
      if(element.readOnly || element.disabled || element.type === 'password' || element.selectionStart === null) throw Error('请选择可编辑的文本框（密码框不支持）。');
      return {kind:element.tagName==='TEXTAREA'?'多行文本框':'单行文本框', multiline:element.tagName==='TEXTAREA', read:()=>({text:norm(element.value),start:element.selectionStart,end:element.selectionEnd})};
    }
    if(element.isContentEditable) {
      const root = element.closest('[contenteditable="true"], [contenteditable="plaintext-only"]') || element;
      return {kind:'富文本（仅监测焦点与选区）', multiline:true, verified:false, read:()=>{
        const selection=doc.getSelection();
        return {text:root.innerHTML, start:selection?.anchorOffset, end:selection?.focusOffset, anchor:selection?.anchorNode, focus:selection?.focusNode};
      }};
    }
    throw Error('请点击网页中的 SQL 编辑区或文本框。VNC 画面暂不支持。');
  }
  try {
    if(operation === 'release' || operation==='suspend') {
      globalThis[key]?.target.release?.();
      if(operation==='release') {
        clearInterval(globalThis[key]?.timer);delete globalThis[key];
        if(globalThis.__sqlTyperActiveGuard===key)delete globalThis.__sqlTyperActiveGuard;
      }
      return {ok:true};
    }
    if(operation==='heartbeat') {
      if(!globalThis[key])return {ok:true};
      globalThis[key].heartbeat=Date.now();return {ok:true};
    }
    // Input has already succeeded. Commit its expected state even if focus was
    // lost while the browser was sending it; the queue will resume AFTER it.
    if(operation==='after') {
      const bound=globalThis[key];
      if(!bound)throw Error('页面已变化，请停止后重新开始。');
      const old=bound.expected;
      bound.expected=bound.target.verified!==false?
        {text:old.text.slice(0,old.start)+char+old.text.slice(old.end),start:old.start+char.length,end:old.start+char.length}:
        bound.target.read();
    }
    const {doc,element} = active();
    if(!element || !doc.hasFocus()) throw Error('输入区失去焦点，请回到原编辑区后继续。');
    let bound = globalThis[key];
    if(operation === 'capture') {
      // A disconnected session may still have a page watchdog. Release it
      // before saving options for a new session, so cleanup cannot cross jobs.
      const previousKey=globalThis.__sqlTyperActiveGuard;
      if(previousKey && previousKey!==key) {
        const previous=globalThis[previousKey];
        previous?.target.release?.();clearInterval(previous?.timer);delete globalThis[previousKey];
      }
      const target=adapter(element,doc);
      bound = {element, doc, target, expected:target.read()};
      Object.defineProperty(globalThis,key,{value:bound,configurable:true});
      globalThis.__sqlTyperActiveGuard=key;
      target.activate?.();
      bound.heartbeat=Date.now();
      // Restore editor options even if the user disconnects the debugger or
      // the extension reloads and can no longer run its normal cleanup.
      bound.timer=setInterval(()=>{
        if(Date.now()-bound.heartbeat>6000) {
          try {if(globalThis.__sqlTyperActiveGuard===key)target.release?.();}
          finally {clearInterval(bound.timer);delete globalThis[key];if(globalThis.__sqlTyperActiveGuard===key)delete globalThis.__sqlTyperActiveGuard;}
        }
      },1000);
    }
    if(!bound) throw Error('页面已变化，请停止后重新开始。');
    bound.heartbeat=Date.now();
    if(element !== bound.element || doc !== bound.doc || !element.isConnected) throw Error('输入目标改变，请回到原编辑区；无法恢复时请停止。');
    const actual=bound.target.read();
    const expected=bound.expected;
    if(actual.text !== expected.text || actual.start !== expected.start || actual.end !== expected.end || actual.anchor !== expected.anchor || actual.focus !== expected.focus) {
      throw Error('代码或光标与预期不同，可能存在自动缩进 / 补全。请核对并撤销多余改动，恢复光标后继续，或停止重新输入。');
    }
    if(operation==='before' && !bound.target.multiline && /[\n\t]/.test(char)) throw Error('单行输入框不能保留换行或 Tab。请停止后改用多行编辑区。');
    if(operation==='before')bound.target.activate?.();
    return {ok:true,kind:bound.target.kind, verified:bound.target.verified!==false};
  } catch(error) {return {ok:false,message:error.message};}
}
