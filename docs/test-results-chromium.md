# Browser verification

2026-10-15T05:29:11.517Z

Browser: 147.0.7727.15 (chromium; headless; actual MV3 extension).

- PASS independent draft binds the source tab and types intact SQL after target focus erases clipboard
- PASS closed bound target retains draft and reports error instead of using a different tab
- PASS opening an independent window cannot discard an existing popup draft
- PASS native textarea preserves multiline SQL, spaces, tab, Unicode; no paste/Enter/Tab
- PASS CodeMirror model matches the full SQL despite enabled bracket completion
- PASS Monaco model matches the full SQL with default editor settings
- PASS pause and resume does not repeat or lose SQL characters
- PASS focus switch pauses and never types in another field
- PASS switching to another browser window still pauses input
- PASS single line pauses on newline and never sends Enter
- PASS contenteditable receives multiline SQL through browser input
- PASS paused countdown resumes and stop halts an active task
- PASS model options restore after unexpected debugger detach
- PASS starting again before the old watchdog restores preserves original Monaco options
- PASS component-wrapped Monaco works without window.monaco (Educoder structure)

完整扩展队列测试使用本地测试页；头歌真实页面的适配器和输入引擎验证见 educoder-verification.md。
