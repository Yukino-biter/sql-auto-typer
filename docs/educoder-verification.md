# 头歌真实页面验证与 1.0.1 修复

用户明确授权直接控制其 Chrome，并打开“DML语言的使用”实训第1关：插入数据。

## 发现

- 页面右侧为 Monaco 编辑器，无 iframe，无 VNC。
- window.monaco 未定义，getEditors / getModels 全局接口不可用。
- 实例位于 .my-monaco-editor 的 React owning component 的 useRef 中，形状为 current.instance。
- 旧版实际 pageGuard 在此页面 capture 明确返回“无法读取这个编辑器的代码模型，暂不支持”。
- 旧版等待 debugger 命令没有超时限制，可能一直显示输入状态。计算机控制连接也存在明显延迟，这个延迟的来源尚未确定。

## 修复

- 先尝试公开 Monaco 接口，再有界查找邻近 React component 的实例引用；验证实例的 DOM 确实包含目标输入元素。
- 使用实例公开接口读取模型、光标和原始设置，仅临时调整自动缩进和补全。
- 连接 / 读取 / 输入命令超时后明确终止，不自动重试可能已写入的字符。
- 停止操作在等待输入队列结束前尝试释放 debugger。

## 真实页面测试

- 使用修改后的实际 pageGuard，capture 返回 Monaco / verified: true。
- 通过浏览器 Input.insertText 发送第一个字符 `-`，after 返回 verified: true，模型确实包含该字符。
- 再发送仅含注释的格式测试文本：`- SQL_TYPER_TEST\n  -- 中文\t'a''b' (1);\n`。
- 合成后模型中的文本为 `-- SQL_TYPER_TEST` 与中文注释，空格、Tab、引号与换行均与输入内容一致；after 再次返回 verified: true。
- 测试字符通过浏览器文本输入接口写入，没有设置 textarea.value 或直接修改模型来生成输入。
- 恢复时先尝试 undo，发现 Monaco 把输入分为更多撤销记录。随后仅精确删除已核对的测试后缀；模型逐字符与测试前原文相等（restored: true）。
- 编辑器 autoIndent 恢复为 full，formatOnType 恢复为 true。
- 没有点击自测运行、评测、提交或重置代码。

完整扩展队列、暂停恢复及长 SQL 在独立浏览器中测试；真实页面测试验证输入引擎与适配器，尚未在用户安装后的 1.0.1 弹窗上执行整段任务。

真实页面截图仅保留本地，不随公开仓库分发。
