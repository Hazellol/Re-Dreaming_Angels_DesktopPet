# 📖 妄想天使桌宠 · 项目主档（PROJECT MASTER DOC）

> 本档 = **开发者速查总纲**：架构、数据流、模块地图、调试矩阵、演进史、发布与维护。
> 用户手册见 `README.md`；技术细节与坑总集见 `IMPLEMENTATION_NOTES.md`。
> 版本：**v1.0.0 · 开源首发（2026-09）**；此前冻结基准：v1.0 正式版（已归档，未动）。
> 当前阶段：**首发后 bug 维修期**（问题收集见 §10；修复记录追加到 IMPLEMENTATION_NOTES）。

---

## 1. 项目定位

《绝区零 · 妄想天使训练中》H5 活动三小只（爱芮/千夏/南宫羽）的**源码级 Spine 动画还原**桌面宠物。
官方 Spine 4.2.42 运行时 + 原版素材零改动；在"还原"之上生长出完整互动生态：待机行为、物理、音频、AI 角色扮演聊天（DeepSeek）、联网搜索、小偶像互聊、情绪响应。

## 2. 技术栈

| 层 | 技术 |
|---|---|
| 运行 | Electron（Windows；透明/无边框/置顶/穿透/单实例锁） |
| 渲染 | 自研 WebGL Spine 渲染器（`spine-gfx.js`，预乘 alpha、矩阵镜像、组合皮肤） |
| 交互 | DOM 浮层气泡/面板/菜单 + canvas 命中检测（bbox 投影） |
| AI | DeepSeek `deepseek-v4-flash/pro`；Chat Completions（离线）/ **Responses API + web_search**（联网）；经主进程 Node fetch（避 CORS） |
| 数据 | `data/*.json`（聊天历史/AI 配置）+ localStorage（配置记忆，调试可用环境变量覆盖） |
| 构建 | 无构建步骤：`npm install` + 双击启动脚本（纯静态 Script 加载，file:// 友好）；**打包**：electron-builder（`npm run pack:portable` 便携版 / `pack:installer` NSIS 安装版；asar 打包、运行数据自动落 `%APPDATA%\ReDreamingAngels\data`） |

## 3. 架构图

```
Electron
├─ main.js（主进程）
│   ├─ 窗口（透明/置顶/穿透切换 setIgnoreMouseEvents+setFocusable、不可隐藏、多显示器 safe area）
│   ├─ 单实例锁 / AppUserModelId / 托盘?（入口：右键菜单退出）
│   └─ IPC：ai-chat / ai-test / ai-config-saved / clipboard-read/write / 文件与配置读写（data/、assets/）
├─ preload.js（contextBridge → window.deskpet）
│    ├─ 读写（readAudio/readText/readChatHistory/writeChatHistory/readAICfg/writeAICfg）
│    ├─ 系统（setIgnore/setFocusable/bringToFront/env/exit…）
│    └─ AI（aiChat/aiTest/notifyAICfgSaved/onAICfgSaved）
└─ src/（渲染进程）
    ├─ index.html     全部 UI 骨架与样式（气泡/聊天面板/菜单/6 面板/输入右键/历史）
    ├─ core.js        ★数据+纯函数（可单测）：ROLES/姿势表/MOTION/MOOD/BGM 名/stripMood/parseChatterLine/fmtTime/clamp
    ├─ settings.js    ★配置持久层（可单测）：QX_* 键（环境变量→localStorage）、注入式 load/save/clamp
    ├─ ai-core.js     ★AI 协议层（可单测）：注入规则常量/请求组装/情绪标签解析/mock/捏捏指令/时间行
    ├─ chatter-engine.js ★互聊生成引擎（可单测）：场景提示词/回复解析/记忆文本/60% 新话题
    ├─ spine-gfx.js   Spine WebGL 渲染器（预乘/镜像/裁剪开关）
    └─ renderer.js    装配器：Spine 装载/物理/气泡/聊天/互聊/音频/UI 状态机 + 全部事件接线
```

> 模块加载顺序（index.html）：spine-core → spine-gfx → core → settings → ai-core → chatter-engine → renderer；
> 四个 ★ 层均无 UI 依赖，可用 node eval 直接单测（开发期已用过该方式验证组装/解析/记忆逻辑）。
```

## 4. 核心机制速查

| 机制 | 要点 |
|---|---|
| 渲染坐标 | 世界=屏幕 CSS 像素；`container {x,y}` 底部锚；y 向上；`worldToScreenPx(key,lx,ly)` 换算（scale/镜像已含） |
| 姿态 | `state.setAnimation(0, '动作_X', true)` + `(1,'表情_Y',true)`；组合皮肤=默认+朝向(镜像) |
| 命中 | bbox×scale 投影 + 6px pad；hidden/对话中角色各自排除 |
| 穿透 | **主进程鼠标轮询裁决**（坑 16）：renderer 每 150ms 上报可交互矩形（角色 bbox + 浮层，`hit-rects` IPC）→ 主进程每 70ms 用 `screen.getCursorScreenPoint()`（不受遮挡/SetCapture 影响）判定 → `setIgnoreMouseEvents(!inside)`，命中时 `moveTop()`。**不依赖 renderer 的 mousemove**（旧方案在覆盖/QQ 截图后会死锁）。焦点跟随（输入聚焦 `setFocusable(true)`，blur 恢复——编辑态例外） |
| 置顶 | 点击浮层 → `bringToFront`（主窗 always-on-top + z-index 排序） |
| 聊天冻结 | `chatFrozen[role]`：待机动画正常、**不走动/不自动冒泡/不姿势**；unfreeze 用独立 reset（不动气泡） |
| 气泡 | `placePopover` 每帧：**上→右→左** 防出屏（pos-right/left 锚点+尾巴朝向+clamp 兜底）；打字机逐帧定位（边打边换位）；`bubbleIsChat` 拖动角色时保留 |
| 情绪联动 | `MOOD_RULE`（system）+ `MOOD_REMIND`（最新 user 尾）→ `<mood:X>` 标签 → 剥除显示/存档 → `applyMoodPose` 4.5s 后回待机 |
| 联网 | `cfg.webSearch` → Responses API（instructions+input+tools[web_search]+tool_choice auto）+ 联网版人设 `personas_web.json`；`extractResponsesText`（顶层 output_text 或 output[] 双兼容）；`max_output_tokens=4096`（思考+搜索 token 足够） |
| 互聊 | 4s 检测：三只两两≤near×1.27→三人；否则最近一对≤near→两人；冷却 cool±50%；`chatterCfg` 可调；用户交互即断；先 `prepChatIdols` 定格 →（重叠先移开 → 同高度 → 横向聚拢）→ 生成（60% 新话题）→ 演出（气泡+情绪+faceTo）→ `saveChatterMemory` 注入各自历史 |
| 音效音量 | `sfxEffVolume = muted?0:(master/100)*(sfxVol/100)`；BGM 同构（bgmVol） |
| 单实例 | `app.requestSingleInstanceLock()`；第二实例退出 |
| 配置热更新 | 控制台「保存配置」→ `ai-config-saved` → 主窗 `onAICfgSaved` → 重载配置+人设+清理瞬时浮层 |

## 5. 数据文件

| 文件 | 内容 |
|---|---|
| `data/chat_<role>.json` | 与用户的对话 + **互聊记忆片段**（assistant 带【和XX的互聊片段】前缀，上限 200 条） |
| `data/ai_config.json` | provider/apiKey/model/temperature/maxTokens/contextRounds/historyOn/chatMode/webSearch/**connected** |
| `assets/personas.json` | 三只完整人设（含红线、禁 emoji，运行时追加情绪/时间规则） |
| `assets/personas_web.json` | 联网版人设（"被问人设外信息→主动联网搜索"改造版） |

配置记忆（用户偏好）：`QX_SCALES` / `QX_FREQ`（含 moveY）/ `QX_AUDIO` / `QX_CHATTER` / `QX_AI`（JSON，localStorage；环境变量可覆盖）。

## 6. 调试矩阵

完整表见 README「调试模式」；常用组合：

- 聊天链路：`QX_CHAT=1` + `QX_AI_MOCK=1`（面板）／`QX_CHAT_BUBBLE=1`（气泡）
- 真实 AI：去掉 `QX_AI_MOCK`；`QX_WEBTEST=1`（联网搜索）、`QX_CHATTEST=1`（互聊）
- UI：`QX_CTX=1`（菜单）、`QX_EDITTEST=1`（编辑）、`QX_BUBBLETEST=*`（气泡边缘）
- 渲染：`QX_BG=black`、`QX_NOCLIP=1`、`QX_NOALPHA=1`；截图 `--screenshot 5000 "hud=1"`

> ⚠️ 截图会在旧进程残留时得到脏帧：先 `Get-Process electron | Stop-Process -Force`。

## 7. 已知边界与注意

- `deepseek-chat` 旧模型名已映射为 `deepseek-v4-flash`（官方 2026 新命名）
- 联网模式输出限额固定 4096（思考+搜索占 token）；联网响应 5~15s 属正常
- `personas_web.json`：联网版人设（开发期由脚本生成后**已固化**；重建需自行恢复生成脚本，或直接改该文件）
- `scripts/extract_*` 依赖外部原始镜像/素材（不在仓库，仅供复刻参考）
- 互聊生成与捏捏 AI 反应消耗真实 API 额度（次数可控：冷却/30% 概率）

## 8. 演进史（一句话版）

v1.0 冻结基准（112 文件）→ 重力/走路修复 → 面板化（音量/频率/大小/播放器）→ 聊天体系（DeepSeek 角色扮演/面板+气泡双样式/注入规则/情绪标签）→ 联网模式（官方搜索+联网人设）→ 小偶像互聊（走近触发/三人/记忆/新话题）→ 捏捏 AI 反应 → UI 打磨（防出屏/尾巴/编辑重发/历史/复制粘贴）→ **模块化重构（core/settings 拆分）**。

## 9. 后续路线

- ✅ 已完成（v1.0）：模块化（core/settings/ai-core/chatter-engine）+ 打包分发（portable/nsis）
- ⏳ 待做：renderer 进一步拆分 P3/P4（chat/chatter/ui 模块化）；人物专属音效；自动化测试增强

## 10. 发布与仓库维护（v1.0.0 开源首发）

### 发布形态
| 形态 | 说明 |
|---|---|
| 源码仓库（GitHub） | 手动网页上传（无本地 git 历史）；包含代码/文档/assets/scripts |
| 便携版 | `npm run pack:portable` → `dist/妄想天使桌宠-便携版-1.0.0.exe`（107MB） |
| 安装版 | `npm run pack:installer` → NSIS Setup |

### 🚨 上传红线（每次更新仓库前自查）
1. **`data/` 绝不上传**（`ai_config.json` 含 API Key、`chat_*.json` 为聊天隐私）——已写入 `.gitignore`
2. 不上传 `node_modules/`（383MB）、`dist/`（打包产物）、`*.log`
3. **素材版权**：assets 内《绝区零》素材版权归 miHoYo 系；README 已有版权声明，禁止商用

### 更新仓库的两种方式
- **网页拖拽**（现状）：Add file → Upload files → 只拖变更文件（覆盖同名文件即更新）→ Commit
- **git push（推荐，需本地库与远端关联）**：
  ```powershell
  git remote add origin <仓库URL>     # 首次
  git add -A && git commit -m "fix: …"
  git push                              # 弹浏览器登录（Git Credential Manager）
  ```

### 发布前检查清单
- [ ] `git status` / 上传列表确认无 `data/`、`dist/`、`node_modules/`
- [ ] 版本号（package.json `version`）与产物文件名一致
- [ ] README / MASTER / NOTES 三份文档已同步本次改动
- [ ] 便携版打包并自测启动

## 11. 已知问题与反馈收集（维修期填写）

| # | 现象 | 复现步骤 | 状态 | 修复记录 |
|---|---|---|---|---|
| K1 | **播放视频时与桌宠交互 → 视频黑屏**（点击桌宠外恢复） | 打开网页视频（B 站）→ 光标经过三小只或点击/拖动她们 | ⚠️ **已定位，未修复** | 诊断：`QX_ALWAYSPASS=1` 不黑 / `QX_NOPASS=1` 黑 → 元凶是"**全屏窗口进入可交互状态**"（整屏覆盖使视频硬件叠加层失效），**与穿透切换无关**。对照：同机"鲸鱼桌宠"窗口仅 303×221 且一直可交互却不黑屏 → **面积是关键**。候选解法见 `IMPLEMENTATION_NOTES.md` §9.1（推荐：窗口缩小到内容包围盒 + 动态跟随）；临时规避：看视频时关闭「显示小偶像」。 |
| — | （其余首发反馈待填） | | | |

> 维修约定：每个 bug 修完 → 在 `IMPLEMENTATION_NOTES.md` 追加"坑"条目（现象/根因/预防）+ 本表状态更新。

> 🐳 维护约定：每次改动同步本文档 + IMPLEMENTATION_NOTES 对应章节；基准版本永远只读归档。
