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

---

## 10. v1.0.0 首发后维修记录（按时间追加）

> 格式：`日期 · 现象 → 根因 → 修法 → 验证`。同步在 `PROJECT_MASTER_DOC.md` §11 问题表登记状态。

| 日期 | 现象 | 根因 | 修法 | 验证 |
|---|---|---|---|---|
| 2026-09 | **功能新增批**：开机自启 / 保持置顶开关 / 播放器导入歌曲 | —（新需求） | ①控制台「开机自启动」开关（`app.setLoginItemSettings`，开发模式附项目路径参数，切换即生效）；②右键菜单「📌 保持置顶」开/关（`win.setAlwaysOnTop(v,'floating')`，记忆 `QX_TOPMOST`，启动时应用）；③播放器「➕ 添加歌曲」：`dialog.showOpenDialog` 多选 → 复制到 `%APPDATA%\ReDreamingAngels\bgm`（打包版 assets 只读的统一用户目录）→ `rescanBgm()` 重扫（`listAudio` 合并内置+用户目录并去重；`readAudio` 双目录兜底；aac 支持） | 菜单置顶项截图 ✓；语法/运行零错误 ✓；导入对话框待手动点 ➕ 验证 |

---

## 附：调试模式示例（PowerShell）

```powershell
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
$env:QX_CHAT='1'; $env:QX_AI_MOCK='1'
& "node_modules\electron\dist\electron.exe" . --enable-logging --screenshot 4500 "hud=1"
```
