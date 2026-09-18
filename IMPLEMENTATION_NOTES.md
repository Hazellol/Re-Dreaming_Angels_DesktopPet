# 🔧 妄想天使桌宠 · 技术手册（IMPLEMENTATION NOTES）

> 实现细节与**坑总集**（当前 14 条）。开发者续作入口。
> 本档的姊妹篇：`PROJECT_MASTER_DOC.md`（架构速查/发布维护）`README.md`（用户手册）。
> 版本：**v1.0.0 · 开源首发（2026-09）**；当前处于**首发后 bug 维修期**——每条修复按格式追加坑条目，并在 MASTER §11 问题表登记。
>
> **新增坑条目模板**：`N. **现象（谁在什么操作下遇到）**：根因（一句话）→ 修法（关键代码/原则）→ 验证方式（怎么确认修好）。`

---

## 0. 快览

| 章节 | 内容 |
|---|---|
| 1 渲染管线 | Spine/WebGL 预乘、矩阵镜像、组合皮肤、截图坑 |
| 2 行为状态机 | 待机/走动/拖动/重力/壁弹/专注模式 |
| 3 气泡系统 | 防出屏、打字机、延时规则、聊天冻结语义 |
| 4 聊天与 AI | 请求组装、注入规则、情绪标签、时间感知、联网、捏捏 AI、历史 |
| 5 互聊系统 | 触发、走位、定格、记忆、演出、打断 |
| 6 音频 | 三路音量、播放器、BGM 扫描 |
| 7 桌面系统 | 穿透、置顶、焦点、单实例 |
| 8 配置持久层 | QX_* 键体系 |
| 9 坑总集 | 现象→根因→预防（含调试教训） |

---

## 1. 渲染管线

- **预乘 alpha**：贴图加载后按 `src.rgb * src.a` 预乘，混合 `ONE, ONE_MINUS_SRC_ALPHA`——否则白边/发灰（调试：`QX_NOALPHA=1` 对比）。
- **镜像**：Spine 运行时无 `skeleton.scaleX`（此运行时），镜像写进 MVP 矩阵 `mvp[0] *= dir`；左右对称贴图镜像后出血需 `QX_NOCLIP` 排障。
- **坐标**：世界=CSS 像素；`container {x,y}` 底部锚、y 向上；`worldToScreenPx` 统一换算（scale/镜像已含）。bbox 来自开发期 probe（爱芮 -148.9~117.3 / -16.6~377.0 等）。
- **多姿势**：0 槽动作 + 1 槽表情，`setAnimation(i, '名字', true)`；组合皮肤 = 默认+朝向（`setComboSkin(key, dir)`）。
- **⚠️ 截图坑**：`capturePage` 抓的是**最后一次 WebGL 绘制**——无绘制帧会得到空白/残像；测试前 kill 旧 electron 进程；失败截图先看 HUD（`--screenshot 5000 "hud=1"`）。

## 2. 行为状态机

- 每帧驱动：`moveIdol`（待机走动>走路 tween+朝向；重力=贴地水平、非重力=路点高度，`freq.moveY` 且 20% 概率 → 竖直/斜向）、`tryBubble`（待机台词+姿势循环）、`placePopover`（每帧气泡定位）。
- 拖动 → `playMotion('drag')`；抛飞（重力）→ `fly`；壁弹第一下 → `bounce` + pat 音效（`physBounced` 标志，松手恢复）。
- **互聊优先级**：`chatter.active` 时 moveIdol/tryBubble 让路；用户交互（双击/单击/拖动）→ `stopChatter()`（全程"零动作"守卫，见坑 9.2）。

## 3. 气泡系统

- 关键语义：`bubbleLock`（占用）、`bubbleIsChat`（聊天气泡拖动保留）、`bubbleThinking/typing`（无缝接管）、`bubbleDeferred`（聊天关闭 3 秒延迟）、`bubbleHideTimer`（hold）。
- **防出屏**：`placePopover` 每帧按实际尺寸验证 上→右→左（`pos-right/left` 锚点+尾巴方向）→ clamp 兜底；打字机逐帧调用 → 增长自动换位。
- **聊天冻结**：`chatFrozen[role]` 时待机动画照常，但排除走路/自动气泡/姿势；`freezeIdol`/`unfreezeIdol`（unfreeze 用独立 reset 避免清气泡）。

## 4. 聊天与 AI（协议层 ai-core.js）

**请求组装（sendChat → ai-core.js 的 `buildChatMessages`）**：
```
system  = 人设（离线/联网版）+ MOOD_RULE（情绪反馈，按需+目的性检测）
        + 当前时间（【当前时间】…，时间感知零成本）
messages= 最近 contextRounds×2 条；
         首次对话（历史无 user，userCount≤1）+IMMERS_RULE（沉浸思考规则）
         最新 user +MOOD_REMIND（方案A：每轮隐性提醒）
main    = ai-chat handler：webSearch ? Responses(+web_search+4096) : ChatCompletions(thinking disabled)
```

- **情绪标签**：`<mood:枚举>`（happy/sad/angry/shy/think/tired/proud）→ 显示/存档/记忆一律剥除（`stripMood` 显示层兜底）；`MOOD_POSES` 映射动作，4.5s 后回待机。
- **联网**：`personas_web.json`（把"被问未知→说不知道/含糊"改造为"可主动搜索后以角色口吻转述"）；`max_output_tokens=4096`（V4 思考+搜索都占输出 token，256 会 incomplete 空内容——坑 9.4）。
- **捏捏 AI**：`aiCfg.connected`（连接测试/真实聊天成功才置位）且 30% → `aiPatReact`：人设+【捏捏反应】指令 → 头顶气泡接管+情绪动作；失败回退固定台词。
- **历史**：`data/chat_*.json`（上限 200）；编辑重发=截断该条及其后；消息显示 `chatMsgEl`（stripMood+复制按钮+末条用户编辑按钮）。

## 5. 互聊系统

- 触发（4s 检测，需 `chatterCfg.on` 且空闲）：三只两两≤near×1.27→三人；否则最近一对≤near→两人；冷却 cool±50%；对话中/用户交互中不触发。
- 指定聊天：`chatterInvite`（发起者走向目标，**prepChatIdols 双方定格** → 重叠先 `moveAwayIfOverlap` → 同高度 → 横向 150px 间隔）→ `startChatter`；三人同理（中间者原地，两边者各距 170px）。
- 生成（`generateChatterLines`）：场景引擎 system（每行"说者: 台词"、3~6 行、**mood 标签必须同行尾**、60% 新话题/40% 延续）+ 各角色人设(前900字)+近况记忆(最近6条,禁提店长) → **强制 webSearch:false** → `parseChatterLine` 拆分。
- 演出：说话者气泡打字+mood 动作，听众 `faceTo` 面向；结束/打断 `stopChatter` → **先 `saveChatterMemory`**（各角色台词注入各自历史，assistant+"【和XX的互聊片段】"）。
- 打断：用户点角色/开聊天/拖动/隐藏 → `chatWalkState=false` + wasActive 守卫。

## 6. 音频

- 三路：`sfxEffVolume = muted?0:(master/100)*(sfxVol/100)`；BGM `bgmEffVolume` 同构（bgmVol 与播放器滑块同源）。
- BGM：`preload.listAudio()` 扫描 `assets/bgm/`；内置曲目固定前缀排序（记忆索引不漂移），新曲目按名追加；`BGM_NAME_MAP` 显示名映射（core.js）。

## 7. 桌面系统

- 穿透：`refreshMouseIgnore` 每帧；浮层矩形+角色命中 → `setIgnoreMouseEvents(!inside)`；`lastMouse` 缓存（事件期间主动刷新）。
- 焦点：textarea/input focus → `setFocusable(true)`；**编辑态中隐藏常驻输入行会触发 blur** → blur 时不解锁（坑 9.6）。
- 单实例：`requestSingleInstanceLock`；第二实例退出；所有窗口永不 hide/show（唯一窗口重绘策略）。

## 8. 配置持久层（QX_*）

- 规则：**环境变量 > localStorage**；JSON 值；加载统一 clamp（见 settings.js）。
- 键：`QX_SCALES`（{all,airui,qianxia,nangong}）、`QX_FREQ`（dialogMode/fixSec/randMin/randMax/moveSec/moveY）、`QX_AUDIO`（master/sfxVol/bgmVol/bgmIdx/bgmOn/playMode/muted）、`QX_CHATTER`（on/near/cool/lines）、`QX_AI`（见 data/ai_config.json 同构）、调试开关（README 表）。

## 9. 坑总集（现象 → 根因 → 预防）

1. **走动"倒着走"/瞬移**：甩飞后落点与路点 dir 不一致 → 动画朝向以"实际移动方向"计算（`B.x-A.x`）。
2. **互动一只，其他两只动作重置**：`stopChatter()` 曾被无条件全员复位 → `wasActive` 守卫 + 仅恢复参与角色。
3. **气泡在贴屏边缘时压住角色**：右/左锚点垂直硬绑角色中部 → 垂直 clamp + 横向分离原则。
4. **联网"卡住"无回复**：V4 思考+搜索吃掉 `max_output_tokens=256` → incomplete 空内容 → 放大 4096 + 空内容容错提示。
5. **点编辑后键盘失效**：隐藏输入行触发 blur → `setFocusable(false)` → 编辑态中 blur 不解锁 + focus 恢复（自动化测试测不出真实键盘问题——需真实焦点条件验证）。
6. **点编辑后界面错乱/卡死**：「（思考中）」占位 `remove()` 丢失 → children 索引错位 → `data-midx` 锚点定位。
7. **聊天气泡内右键弹出全局菜单**：contextmenu 冒泡 → 浮层内只 preventDefault，输入框右键单独处理。
8. **历史滚动条被吸底**：每帧 positionBcHist 里重复滚到底 → 仅打开时滚一次（bcHistNeedScroll）。
9. **⚙设置按钮点击无效**：按钮类不是 `.cm-item` → 点击处理器多分支（.cm-chat-btn / .cm-chat-set / .cm-item）。
10. **`<mood>` 泄漏到界面/记忆**：模型可能把标签放行尾/换行 → 三层防御（prompt 限定同行尾 + 注入前剥除 + 显示层 stripMood）。
11. **控制台 GBK 乱码**：pwsh `Get-Content` 对 UTF-8 显示乱码——用 read 工具/`node` 读。
12. **截图空白/残像**：capturePage 抓 WebGL 最后帧；旧进程残留会互相抢占——跑测试前 `Stop-Process electron`。
13. **互聊"走过去但不说话"（用户实测）**：DeepSeek-V4 偶发把**思考块 `<think>` 写进正文**（或写错标签 `<happy>`、只偷懒给一行台词）→ 场景解析被污染（"每人至少一句"判定失败）→ 静默终止。三层修复：
    - 服务层 `stripThink`（剥离 `<think>…</think>`，含未闭合情况，用户聊天/联网/捏捏/互聊全部受益）；
    - 解析容错：`parseChatterLine` 识别 **7 态裸标签**（`<happy>` 等）+ 场景 prompt 增"绝对不要输出 think 块"；
    - 放宽：`parseSceneReply` 不再强制"每人至少一句"（解析出 ≥1 行即演出）。
    - 新增 `[CHATTER]` 诊断日志（生成失败/API 失败/原始回复预览），排查互聊问题的第一入口。
14. **南宫参与互聊总失败（用户实测）**：显示名与解析名不一致——`personaLabel` 优先用 `personas.json` 的 label（**南宫羽**），模型按 prompt 输出"南宫羽: 台词"，而 `parseChatterLine` 只认 core `ROLES.label`（**南宫**）→ **南宫的行永远被丢弃**（千夏×南宫场景常失败/只剩千夏单句）。修：`parseChatterLine(line, labelOf?)` 优先用 labelOf（与 prompt 同一套名字）+ 内置别名表（南宫/南宫羽）兜底；`parseSceneReply` 透传 labelOf。验证：单测"南宫羽:"行归位 ✓ + 真实 API 千夏×南宫 → 南宫记忆写入【和千夏的互聊片段】（参演铁证）✓。**教训：prompt 与解析器必须用同一"名字来源"，显示名变更要两端同步。**
15. **未置顶时被最大化窗口完全覆盖 → 互动死锁（第一轮排查，权宜修复）**：`set-mouse-ignore(false)`/`bringToFront()` 加 `moveTop()` + 托盘/快捷键召回（`bringPetToFrontTemporarily`）。⚠️ 仅解决"召回"，**未解决根因**（见坑 16）。
16. **穿透架构重构：从"renderer mousemove 判定"改为"主进程鼠标轮询裁决"（根治卡死）**：用户实测三类死锁同一病根——①被全屏窗口完全覆盖；②**QQ 截图（Ctrl+Alt+A）等 SetCapture 接管鼠标后**；③置顶提层后仍点不动。原因：旧方案 `setIgnoreMouseEvents(true,{forward:true})` + **renderer 收 mousemove 命中判定**；一旦窗口被遮挡/被其他进程捕获鼠标，**renderer 永远收不到 mousemove** → 停在"忽略鼠标"态 → 即使视觉可见/置顶，点击也全部穿透给下层 → 死锁（换置顶、加 moveTop 均无效）。
    **新架构**：穿透状态由**主进程统一裁决**——`screen.getCursorScreenPoint()`（系统级 `GetCursorPos`，**不受遮挡、不受 SetCapture 影响**）每 70ms 取全局鼠标位置；renderer 只周期性上报"可交互矩形"（三只角色 bbox + 所有打开的浮层；拖动/编辑中标记 forceInteractive）；主进程命中则 `setIgnoreMouseEvents(false)` + `win.moveTop()`，否则 `setIgnoreMouseEvents(true,{forward:true})`（仅状态变化时下发）。
    **配套**：①`hit-rects` IPC（renderer 每 150ms 及浮层显隐时上报）；②renderer 不再自行调用 setMouseIgnore（避免双源打架）；③救援快捷键**候选降级**（`Control+Alt+Z → Control+Alt+D → Control+Alt+F9`，被占用自动换下一个，实际生效键经 `get-hotkey` IPC 显示在菜单底部与托盘 tooltip）；④**开机自启读取 bug 修复**——`getLoginItemSettings` 必须传与写入**完全相同的 path+args**（Windows 匹配规则），否则"设置成功但开关打不上钩"。
    **实测**（QX_NOTOP=1 + 全屏浏览器覆盖）：`[AUTOLAUNCH-TEST] before=true setTrue→true setFalse→false` ✓；`[HOTKEY] active=Control+Alt+D`（Ctrl+Alt+Z 被占用自动降级）✓；鼠标移到被覆盖的角色处 → **她自动浮到最前** ✓；覆盖状态下点击 → **互动气泡出现**（"助教！好像有正在夸我的评论诶…！"）✓✓。
    **结论：桌宠的"是否可交互"绝不能依赖窗口自身收到的鼠标事件；系统级鼠标位置轮询是遮挡/捕获场景下唯一可靠的方案。**
17. **【第二轮·最终真相】未置顶时点击仍被上层窗口吃掉（z-order 铁律）**：坑 16 的轮询把状态切对了（日志 `[POLL] change INTERACTIVE hit=(295,586,145x209)`），但**点击依然无效**——因为 Windows 的 z-order 规则：**鼠标点击永远由最上层窗口接收**；窗口未置顶时沉在下层，即使关掉穿透，点击仍被上层窗口（浏览器/QQ 窗口）吃掉。而 `win.moveTop()` 对"未置顶的后台非激活窗口"**实测无效**（她不会浮起）——只有 `setAlwaysOnTop(true)` 才能真正提层。
    **终极修复：交互时临时置顶**（`setInterimTop`）——主进程判定鼠标进入可交互区域（或 `hitForceInteractive` 拖动/编辑）时：`win.setAlwaysOnTop(true,'floating')` + `moveTop()`，并维护 2.6s 计时器；鼠标离开或无交互到期后，若用户置顶开关为关则 `setAlwaysOnTop(false)` 恢复（尊重用户设置）。`set-topmost` IPC 同步维护 `userTopmost` 真源（用户开关）与 `interimTop`（临时态）两个状态。
    **实测铁证**（未置顶 + 全屏浏览器覆盖 + 站定角色）：鼠标移到她身上 → 日志 `[POLL] resync INTERACTIVE cursor=(367,690) hit=(295,586,145x209) interimTop` → **她浮到浏览器之上** → 点击 → **互动气泡「助教，我今天的……状态特别好，能加练吗！」** ✓✓✓（此前的鼠标捕获 SetCapture 模拟同样恢复正常）。
    **教训**：①主进程轮询只解决"穿透状态正确性"；②"未置顶窗口能否被点击"是 z-order 问题，唯一解是**交互期间临时置顶**；③`moveTop()` ≠ 置顶，对后台窗口不可靠。
18. **【第三轮·真凶】`drag.on` 卡死 → 所有点击失效（QQ 截图/系统截图后"卡死"的真正机制）**：用户复现路径 `Ctrl+Alt+A → 左键单击 → 回车`（QQ 截图），现象=**能弹右键菜单但点不动任何东西**。人家用等效工具（系统截图 Win+Shift+S / 自制 `SetCapture` 覆盖窗口）复现并**靠持久化状态日志抓到铁证**：
    - 截图工具捕获鼠标期间，用户那次"左键单击"的 **mousedown 到达了我们的窗口，但 mouseup 被截图工具吃掉** → `drag.on` **永久停在 true**（日志特征：主进程轮询里 `cursor=(-1,-1)`——因为 renderer 持续上报 `forceInteractive=true` 而跳过读光标）；
    - 后果：此后每次点击都被当作"拖动开始"，而 `mouseup` 又收不到 → **互动永远不触发**（而 `contextmenu` 是独立事件，所以右键菜单照样弹出——与用户描述 100% 吻合）；同时主进程永久 INTERACTIVE + 永久临时置顶（她浮在最上面，看似正常实则点不动）。
    **修复（三条自救路径 + 一道主进程兜底）**：
    1. `mousemove` 中检测 **`e.buttons === 0`**（拖动中却没有任何按键按下 = mouseup 已丢失）→ `abortDrag()` 立即中断拖动；
    2. `window.blur` / `document.visibilitychange(hidden)` → `abortDrag()`；
    3. `mousedown` 时若 `drag.on` 仍为真（上次异常未结束）→ **先 `abortDrag()`** 再开始新流程；
    4. 主进程：`hitForceInteractive` 持续 >20s 视为 renderer 卡住 → 忽略（避免永久临时置顶）。
    `abortDrag()` 清理拖动状态 + `clearIdolFace` 恢复表情 + 非重力下把踱步路点更新到当前落点（与正常 mouseup 一致，不触发误点击）。
    **实测铁证**（禁走动 + Win+Shift+S 截图工具 → Esc → 点击角色）：修复前日志 `cursor=(-1,-1)`（drag.on 卡住）；修复后 `cursor=(367,690) ignore=0 top=1 interim=1 hit=(295,586,145x209)` → **她浮出 + 互动气泡「助教！不、不要在我唱歌时恶作剧哦！」** ✓✓✓
    **教训**：**桌宠的交互状态机必须能自愈**——凡"依赖配对的鼠标按下/抬起事件"的状态（drag），都必须有"按键丢失检测 + 失焦兜底 + 重入清理"三道保险；截图工具、其它进程 SetCapture、窗口切换都会吞掉 mouseup。
    **诊断资产**：`QX_POLLLOG=1` → 主进程持久写 `poll_diag.log`（含 inside/ignore/top/interim/cursor/矩形坐标）；`scripts/list_windows.ps1`（z-order+扩展样式取证）、`scripts/screen_shot.ps1`、`scripts/mouse_capture.ps1`、`scripts/key_hotkey.ps1`、`scripts/mouse_sim.ps1`。
19. **【第四轮·QQ 专属场景】鼠标输入被外部进程吞掉 → 物理按键交叉验证守护**：用户澄清"**只有 QQ 截图**（Ctrl+Alt+A→左键单击→回车）会卡死，Win+Shift+S 不会"。原因定位：QQ 截图工具**捕获鼠标期间吃掉 mouseup 并可能不释放输入状态**（同类现象见 StackOverflow "Mouse input not being released from other process's window"），使我们的 `drag.on` 卡死；更糟的情况下系统认为左键仍按下，`e.buttons===0` 检测失效（坑 18 的手段对这种情况无效）。
    **最终修复（跨进程交叉验证）**：主进程在"renderer 报告拖动中"时，每 2s 调用 `scripts/mouse_guard.ps1` 查询 **`GetAsyncKeyState(VK_LBUTTON)` 物理按键状态**与前台窗口：
    - **物理左键已松开（UP）但我们仍认为在拖动 → 断定 mouseup 丢失** → 主进程 `abortDragFromMain('mouseup-lost')`：清 force 状态 + 通过 `drag-abort` IPC 通知 renderer `abortDrag()`（实测日志 `[GUARD] physical left button is UP but drag state stuck → abort drag` ✓）；
    - 拖动状态持续 >12s（用户不可能按住那么久）→ 强制中止（`timeout`）；
    - 20s 硬上限兜底忽略 force。
    **配套**：renderer 侧另有四道保险——`e.buttons===0` 的 mousemove、`blur`/`visibilitychange`、mousedown 重入先清理、**帧级 2.5s 无鼠标移动超时**（`drag.lastMoveAt`）。
    **代价**：守护仅在"疑似拖动"时每 2s 一次 powershell 查询（~150ms，`windowsHide`），平时零开销。
    **教训**：当卡死源于**其他进程**吞掉输入时，同一个进程内的事件兜底不够——必须**跨进程交叉验证"物理输入状态"与"逻辑状态"**；`GetAsyncKeyState`（物理按键）不受消息队列/捕获状态影响，是最可靠的裁判。
20. **【第五轮·疑似终极根因】Chromium 窗口遮挡检测 + 输入通道心跳自愈**：用户澄清"**只要被别的全屏窗口覆盖过一次，本次就会一直卡死（待机动画却正常）**"——这是"输入通道"而非"事件配对"层面的问题。定位到 Chromium 在 Windows 上的 **原生窗口遮挡计算**（`CalculateNativeWinOcclusion`）：透明桌宠窗口长期处于被遮挡状态，一旦被判 occluded，Chromium 会停止其渲染/输入通道（`backgroundThrottling:false` 只能保住动画，救不了输入）→ **永久收不到鼠标事件**（而窗口 exStyle/层级/我们的轮询状态看起来全部正常，取证确认 `ex=0x08200008` 含 TOPMOST ✓）。
    **修复（双保险）**：
    1. **禁用遮挡检测**：`app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')`（Electron 社区处理"透明覆盖层被遮挡后异常"的标准解法）；
    2. **输入通道心跳 + 三级自愈**：renderer 上报鼠标事件计数（`hit-rects` 附带 `evtCount`）；主进程判据=**光标正在移动（1.2s 内位置变化）却 1.2s 收不到任何 renderer 鼠标事件** → 判定通道失效 → 3s 限频自愈：**L1** 强制刷新穿透状态（值变化才真正重设扩展样式）→ **L2** 刷新层级＋微调窗口尺寸（触发重配/重绘）→ **L3** 兜底重载渲染进程（每会话上限 3 次）。`QX_SIMULATE_STUCK=1` 可模拟通道失效以验证自愈。
    **实测**：正常操作零误报；模拟通道失效时日志 `[SELFHEAL] input channel stalled (cursor moving, no renderer events) → level 1` ✓（判据经过一次修正——初版用"事件计数停滞"会误报鼠标静止场景，改为"光标在动 + 事件停滞"的交叉判据）。
    **若该修复仍不足**，备选重写方向（评估中）：①**每角色独立小窗口且不穿透**（最接近主流桌宠做法，点击永不卡死；气泡/面板需独立窗口）；②**native 模块 per-pixel hit test**（`SetWindowRgn`/`WM_NCHITTEST`，最接近原生桌宠，需编译 native）。
21. **移除"悬停临时置顶"的过度设计（用户实测反馈）**：坑 17 为了修"被覆盖后无法点击"引入的 `setInterimTop`（鼠标进入角色区域即临时置顶）有严重副作用——**用户锁定别的窗口时，光标只要落在她们位置上，她们就自动浮到最前；被覆盖后光标移回原位置她们又自己冒出来**。这违背了"关闭保持置顶"的语义（用户关置顶就是希望她们**不抢层级、可以被盖住**）。
    **修复**：删除 `applyMouseIgnore` 中的悬停临时置顶调用；`setInterimTop` 仅保留给**主动救援入口**（全局快捷键 / 托盘点击 / 托盘菜单「📌 把三小只提到最前」），救援保持时长统一为 **5s** 后恢复用户的置顶设置。
    **语义澄清**（重要）：未置顶时"被覆盖 → 点不到"是 Windows 的正常层级行为（用户自己的选择），**不应靠自动提层去绕过**；想找她们就用救援入口。`mousePollTick` 仍保留 `setIgnoreMouseEvents(false)`（鼠标在角色区域时窗口可接收点击）——这保证"未被覆盖时点击正常"，但不再改变窗口层级。
    **实测**：QX_NOTOP=1 + 全屏浏览器覆盖 + 光标移到角色处 → 日志 `top=0 interim=0` 且截图确认**她们保持被覆盖不弹出** ✓；QX_FRONTTEST 触发救援 → 裁剪截图确认**浮到浏览器之上** ✓；热键实际生效键会随占用情况动态变化（实测 `Control+Alt+Z` / `Control+Alt+D` 两种），菜单底部与托盘 tooltip 显示真实键 ✓。
    **教训**：修 bug 的临时策略要"够用就好"——自动提层这种强干预会变成新的体验问题；交互入口应交给用户显式触发。
22. **层级语义修正 + 点外部关闭 + 内存自查（用户反馈批）**：
    1. **"立即显示在最上层"取代"临时置顶 5s"**：召回入口（快捷键/托盘/托盘菜单）改为 `showOnTopOnce(300)` —— **脉冲式**：`setAlwaysOnTop(true)+moveTop()` 让她们**立刻出现**，约 300ms 后自动恢复用户的置顶设置（此后其它窗口可正常覆盖）。旧实现"临时置顶 5 秒"会锁死层级（用户 5 秒内无法用别的窗口盖住她们）。
    2. **修复"关闭保持置顶却没生效"**：`set-topmost(false)` 旧分支在 `interimTop` 残留时会跳过关闭 → 改为**无条件** `setAlwaysOnTop(userTopmost)`。
    3. **修复"她们偶尔自己冒到最上层"**：输入通道自愈的 **L2** 原本无条件 `setAlwaysOnTop(true)` 且不回落 → 改为**尊重 `userTopmost`**（关置顶时不置顶）。
    4. **移除临时置顶机制**（`interimTop`/`setInterimTop` 全部清理），悬停自动浮出彻底消失。
    5. **点击浮层外部即关闭**：右键菜单 + 从菜单打开的面板（大小/频率/音量/互聊设置）→ 点击外部任何位置直接关闭；**音乐播放器保持常驻**（用户要求），聊天面板/对话框/输入右键菜单不受影响。为保证"点外部"的点击能到达窗口，**模态浮层打开期间强制可交互**（`reportHitRects` 的 force 条件加入 `modalOpen`）——否则窗口处于穿透态，点击被下层吃掉、菜单关不掉。实测：菜单打开 → 鼠标移到空白处点击 → 菜单关闭 ✓。
    6. **内存自查**（实测：Electron 6 进程合计工作集约 **680MB**：182/137/134/99/84/43MB）。优化思路（按性价比）：
       - ⭐⭐⭐ **控制台窗口按需创建**：现状启动即创建常驻 renderer 进程；改为"点开才建、关闭即 destroy" → 预计省 100~130MB；
       - ⭐⭐ **BGM 改流式加载**：现状 `readAudio` 返回 **base64 data URL**（整首歌字符串驻留 + 每次播放重读）；改用自定义 protocol（`protocol.handle('pet', …)`）或 file:// 让 `<audio src>` 流式读取（asar 内亦可用）→ 省 15~40MB 与解码开销；
       - ⭐⭐ **空闲降帧**：三只均在普通待机（无动作/走动/气泡/拖动/浮层）时 60fps → ~24fps，CPU 约减半；
       - ⭐ **纹理懒加载/释放**：隐藏角色释放 Spine 纹理，重新显示时重载；
       - ⭐ **Chromium 特性裁剪**：追加 `--disable-features`（MediaSessionService、HardwareMediaKeyHandling、GlobalMediaControls、Translate、AutofillServerCommunication 等）；
       - ⭐ **V8 堆限制**：`--js-flags=--max-old-space-size=192`；
       - ⭐ **降频**：rects 上报 150→300ms、鼠标轮询 70→100ms。

---

## 10. v1.0.0 首发后维修记录（按时间追加）

> 格式：`日期 · 现象 → 根因 → 修法 → 验证`。同步在 `PROJECT_MASTER_DOC.md` §11 问题表登记状态。

| 日期 | 现象 | 根因 | 修法 | 验证 |
|---|---|---|---|---|
| 2026-09 | **功能新增批**：开机自启 / 保持置顶开关 / 播放器导入歌曲 | —（新需求） | ①控制台「开机自启动」开关（`app.setLoginItemSettings`，开发模式附项目路径参数，切换即生效；**入口在控制台主页**，与"显示/隐藏小偶像"并排）；②右键菜单「📌 保持置顶」开/关（`win.setAlwaysOnTop(v,'floating')`，记忆 `QX_TOPMOST`，启动时应用）；③播放器「➕ 添加歌曲」：`dialog.showOpenDialog` 多选 → 复制到 `%APPDATA%\ReDreamingAngels\bgm`（打包版 assets 只读的统一用户目录）→ `rescanBgm()` 重扫（`listAudio` 合并内置+用户目录并去重；`readAudio` 双目录兜底；aac 支持） | 菜单置顶项/主页开关截图 ✓；语法/运行零错误 ✓；导入对话框待手动点 ➕ 验证 |
| 2026-09 | **未置顶时被最大化窗口完全覆盖 → 无法互动**（菜单能出现但点不到任何选项；被最小化窗口遮挡则正常）——用户实测 | 双重原因叠加：①窗口 z-order 在覆盖者之下；②为"不抢焦点"设置的 `setFocusable(false)` 使点击**不会像普通窗口那样激活/浮到前面** → 窗口永久沉底；虽然穿透切换会收到 mousemove 并渲染菜单，但点击事件仍被上层窗口吃掉 | 三处提层：①`set-mouse-ignore(false)`（要交互）时顺带 `win.moveTop()`；②新增 `move-top` IPC；③renderer `bringToFront()`（菜单/面板/对话框打开）同步 `moveTop()+setMouseIgnore(false)`——**不改变用户的置顶开关语义**，仅在需要交互时把窗口提到同层最顶 | 逻辑修复；需真实"最大化窗口覆盖"场景复测（主人验证） |

---

## 附：调试模式示例（PowerShell）

```powershell
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
$env:QX_CHAT='1'; $env:QX_AI_MOCK='1'
& "node_modules\electron\dist\electron.exe" . --enable-logging --screenshot 4500 "hud=1"
```
