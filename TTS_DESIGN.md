# 妄想天使桌宠 · TTS 语音系统设计方案（v1 草案）

> 目标：三小只的 AI 聊天文本 → **带情绪的本地语音**；模型与运行时**不随整合包分发**，由用户按需下载；整体**专业、轻量**——相对原版 GPT-SoVITS 只保留 **TTS 推理**。

---

## 0. 已确认的现实条件（实测）

| 项 | 实测结果 |
|---|---|
| 训练镜像 | GPT-SoVITS **v9.0**（新增 v2pro / v2pro plus，PyTorch 2.0.1 + CUDA 11.8，镜像 23.35GB） |
| 训练版本 | **v2ProPlus** |
| 千夏模型 | `模型/qianxia-e15.ckpt`（GPT，148.1MB） + `模型/qianxia_e8_s96.pth`（SoVITS，164.8MB） ✓ 齐全 |
| 参考音频 | `参考音频/` 47 条 wav（共 16.8MB，游戏原声） |
| **标注文件** | `千夏参考.list`，格式 **`音频|情绪标签|台词文本`** ✓✓ **天然带情绪标注** |
| 情绪分布 | 日常×10、紧张×8、担心×7、开心×7、沮丧×7、害羞×7、疑惑×4、愤怒×3、羡慕×1、努力×1、鼓励×1 |

**结论**：数据条件极好——**情绪映射可以由 `.list` 自动生成，零手工标注成本**。

---

## 1. 总体架构

```
┌────────────────────── 桌宠（Electron，整合包内） ──────────────────────┐
│  renderer：AI 回复文本 + <mood:X> 情绪标签（项目已有 7 状态情绪系统）      │
│        │ IPC: tts-speak { role, text, mood }                          │
│  主进程 tts-manager：懒加载 / 空闲卸载 / 音频缓存 / 崩溃降级 / 播放编排   │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ HTTP 127.0.0.1:9880（仅回环）
┌───────────────────────────────▼───────────────────────────────────────┐
│  TTS 服务（**用户可选下载**，独立进程，只含推理）                        │
│   /speak   { role, text, mood } → wav                                 │
│   /health  /warmup  /emotions                                         │
│   内部：emotions.json（情绪→参考音频+文本）→ TTS_infer_pack 推理         │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ 返回 wav / 分块
                     renderer <audio> 播放（走已有 pet:// 协议）
```

**分层理由**：模型常驻独立进程（免重复加载）；服务与桌宠互不拖累（崩溃可降级为无语音）；**桌面端不携带模型**。

---

## 2. 情绪方案（核心设计）

### 2.1 映射链

```
LLM 回复（含 <mood:happy>）→ 角色 + mood → emotions.json 里挑一条参考（可随机）
                                    → api_v2: ref_audio_path + prompt_text → 推理
```

### 2.2 GPU 情绪 → 千夏参考（自动生成，实测产物示例）

| 我们的 mood | 采用的情绪标签 | 可用条数 | 示例参考文本 |
|---|---|---|---|
| `happy` | 开心 / 鼓励 | 8 | 「（我的第一首歌…终于，写完啦…）」 |
| `sad` | 沮丧 / 担心 | 14 | 「（…会有人，能喜欢上它吗？）」 |
| `angry` | 愤怒 | 3 | 「还神神秘秘地不肯说出来——！」 |
| `shy` | 害羞 / 羡慕 | 8 | 「是爱芮的功劳啦！」 |
| `think` | 疑惑 | 4 | 「兔子伯爵最后去哪里了？总觉得有点在意。」 |
| `tired` | 沮丧（弱语气条）/ 紧张 | 3~5 | 「呜哇！对不起，都怪我——」 |
| `proud` | 开心（得意条）/ 努力 | 3~4 | 「店长…和爱芮…都好笃定、好可靠、好帅气哦…！」 |
| `neutral` | 日常 | 10 | 「今天的背景音乐…是G大调！」 |

- **每个 mood 配多条候选** → 合成本次随机取一条 → **同情绪不同语气，更自然** ✓
- 缺某情绪 → 自动回落到 `neutral`；控制台可关闭情绪（全部用 neutral）
- 主人在 `参考音频/` 里补充音频后，只需按同样格式追加到 `.list` → 重新生成 `emotions.json` 即可扩充

### 2.3 生成的映射文件（服务侧读取）

```jsonc
// voices/qianxia/emotions.json
{
  "role": "qianxia",
  "model": { "gpt": "qianxia-e15.ckpt", "sovits": "qianxia_e8_s96.pth", "version": "v2ProPlus" },
  "default": "neutral",
  "map": {
    "happy": [
      { "ref": "Level_..._610033013_001.wav", "text": "（我的第一首歌…终于，写完啦…）" },
      { "ref": "Level_..._74490012.wav",      "text": "打、打起精神，我演出也经常出糗的…" }
    ]
  }
}
```

---

## 3. 精简策略（相对原版 GPT-SoVITS）

| 类别 | 处理 |
|---|---|
| **保留** | `GPT_SoVITS/inference_webui.py` 的推理核心（`TTS_infer_pack`）、必要的 `module/`、`feature_extractor`、`text/`（中英日前端）、`AR/`、`eres2net`（sv 模型） |
| **去掉** | 训练全部代码（`s1_train.py`/`s2_train.py`/`prepare_datasets`）、WebUI（Gradio 全站）、UVR5 人声分离、`tools/` 工具集、示例数据集、文档与 notebook |
| **替换** | 用**自研薄 HTTP 服务**（FastAPI）替代 `api_v2.py`：接口更简单（桌宠只传 `role/text/mood`），情绪映射与参考选择在服务内完成 |
| **依赖** | `torch` + `torchaudio` + `transformers` + `librosa`/`soundfile` + `numpy`/`scipy` + `fastapi`/`uvicorn` + `pytorch-lightning`(如推理需要则保留) |

**体积预估**：

| 组成 | CPU 版 | GPU 版 |
|---|---|---|
| Python 运行时 + 推理依赖 | ~0.8GB | ~2.5GB（含 CUDA 版 torch） |
| 底座模型（BERT / HuBERT / v2ProPlus 底模 / sv） | ~1.9GB | ~1.9GB |
| 单角色模型（ckpt + pth） | ~0.32GB | ~0.32GB |
| 参考音频（47 条） | ~0.02GB | ~0.02GB |
| **合计** | **≈3.0GB** | **≈4.7GB** |

（对比训练镜像 **23.35GB** → 大幅精简 ✓）

---

## 4. 下载与安装（可选功能，默认不下载）

- **入口**：控制台新增 **「🎙 语音」页**（与"设置/对话配置"并列），首屏显示 **未安装** 状态 + 「下载语音包」按钮
- **组成两份可独立下载的包**：
  1. **TTS 运行时包**（Python + 依赖 + 底座模型，CPU/GPU 两版可选）
  2. **角色语音包**（三小只的 ckpt/pth + 参考音频 + emotions.json，可单独更新）
- **下载实现**：主进程 `https` 流式下载 → 临时文件 → **SHA256 校验** → 解压到 `%APPDATA%/ReDreamingAngels/tts/`；支持**断点续传**与进度事件（控制台进度条）
- **目录**：
```
%APPDATA%/ReDreamingAngels/tts/
  runtime/        便携运行时（python.exe + 精简服务代码 + 底座权重）
  voices/         角色语音包（qianxia/、airui/、nangong/）
  cache/          合成缓存（hash(text|role|mood).wav）
  config.json     端口 / 开关 / 语速 / 空闲超时
```

---

## 5. 桌宠侧集成

| 触发源 | 默认 | 说明 |
|---|---|---|
| **AI 聊天回复** | ✅ 开 | 主场景：文本 + mood → 语音 |
| 待机气泡台词 | ⬜ 关 | 频繁，用户可开 |
| 三小只互聊 | ⬜ 关 | 可选 |

**播放与体验**：
- **分句流水线**：按标点切句 → 逐句合成播放（首字延迟最低，实现比纯流式可靠）
- **打断**：再次点击/新消息 → 立即停播（丢弃未播队列）
- **缓存**：`hash(role|mood|text)` 命中直接播（省算力）
- **音量**：复用现有三路音量（总音量 × 语音音量）
- **情绪**：直接消费现有 `<mood:X>` 标签（项目已有），无需改 AI 协议
- **降级**：服务未安装/未启动/合成失败 → **静默无语音**，聊天功能完全不受影响

**主进程 `tts-manager` 职责**：
- 探活（`GET /health`）→ 未运行则按需启动 `runtime/python.exe runtime/server.py`（隐藏窗口）
- **懒加载**：首次需要合成时才启动（不拖慢开机）
- **空闲卸载**：默认 5 分钟无请求 → 优雅停止（释放 1.5~4GB 显存/内存），可配置
- 请求队列 + 超时 + 失败重试 + 崩溃重启（上限 N 次）

---

## 6. 控制台「🎙 语音」页

- **状态卡**：未安装 / 已安装未运行 / 运行中（端口、显存占用）
- **按钮**：下载语音包（进度条）· 启动服务 · 停止服务 · 预热 · 打开目录 · 删除
- **开关**：总开关 · 对"聊天/气泡/互聊"分别启用 · 情绪控制 · 空闲卸载时间
- **试听**：选角色 + 情绪 → 输入一句话 → 合成试听（调参用）
- **情绪映射查看**：列出每个 mood 当前用的参考音频（可点听）

---

## 7. 实施阶段（建议）

| 阶段 | 内容 | 交付 |
|---|---|---|
| **① 情绪映射与数据准备** | 从 `千夏参考.list` **自动生成** `emotions.json`（含 7 mood 映射 + 多候选）；工具脚本 `tools/build_emotions.mjs` | 映射文件 + 生成工具 ✓ 现在即可完成（不依赖环境） |
| **② 桌宠侧链路** | `tts-manager` + IPC + 控制台「语音」页（开关/状态/启停）+ 聊天回复 → 合成 → 播放 | 可跑通（服务未装时静默降级） |
| **③ 精简推理服务** | 自研 `server.py`（FastAPI，只依赖推理核心）+ 依赖清单 + 启动脚本 | 需在主人的 GPT-SoVITS 环境调试 |
| **④ 千夏端到端实测** | 用千夏模型跑通"文本+情绪 → 出声" | 语音效果确认 ✓ |
| **⑤ 打包与下载** | 运行时包 + 角色包 + 下载器 + 校验 | 用户自助安装 |
| **⑥ 打磨** | 分句流水线 / 缓存 / 打断 / 试听页 | 体验 |

---

## 8. 待主人确认

1. **本地是否有可用的 GPT-SoVITS 运行环境**（能跑推理）用于调试阶段③？若有，请提供路径（例如 `GPT_SoVITS/pretrained_models/` 下的底座与 `v2Pro`/`sv` 权重是否齐全）。
2. **爱芮 / 南宫** 的模型与 `.list` 是否与千夏同样格式？（千夏先跑通，再补齐两只）
3. **推理用 GPU 还是 CPU**（决定便携包体积与速度；CPU 版约 3GB、GPU 版约 4.7GB）
4. **情绪粒度**：按上表 7 种 mood 即可？`tired`/`proud` 目前借用近似条目，是否需要补录参考音频。
5. **阶段 ① 是否现在就做**（人家可以立刻生成千夏的 `emotions.json` + 生成工具，不依赖任何环境）。

---

## 9. 已实现（初版，可直接试用）

### 9.1 代码落点

| 文件 | 作用 |
|---|---|
| `src/main-tts.js` | TTS 管理器（主进程）：配置读写 / 探活 / 合成 / 缓存 / 空闲卸载 / managed 启动 / **静默降级** |
| `main.js` | 接入 TTS 管理器 + `pet://tts/xxx.wav` 协议映射（播放合成音频）+ `QX_TTS_*` 调试开关 |
| `preload.js` | `ttsStatus/ttsConfig/ttsProbe/ttsStart/ttsStop/ttsSpeak/ttsEmotions/onTtsStatus` |
| `src/renderer.js` | 聊天回复 → `speakTts(role, text, mood)` → `<audio>` 播放；点击角色**打断**；复用三路音量 |
| `src/panel.html` / `src/panel.js` | 控制台「⚙ 设置 → 🎙 语音」页：总开关 / 运行方式 / **GPU·CPU 可选** / 地址端口 / 运行时与脚本 / 空闲卸载 / 朗读范围 / **高级 JSON（适配不同版本）** / 探活·启停 |
| `tools/build_emotions.mjs` | 由 `.list` **自动生成情绪映射**（7 mood，多候选，缺档回落到 neutral） |
| `tools/build_voicepack.mjs` | 组装语音包：`tts_out/<role>/{emotions.json, refs/, models/, pack.json}` |
| `tools/mock_tts_server.mjs` | 无 GPT-SoVITS 环境时的**假服务**（返回静音 wav），用于验证桌宠侧链路 |

### 9.2 端到端验证（已通过）

```
[TTS] manager ready (enabled = true)
[TTS-TEST] {"ok":true,"url":"pet://tts/5f4965….wav","bytes":51244}
[MOCK-TTS] text="你好呀，今天也要开心哦！" ref=…_111701011_001.wav prompt="我见过那个！…"
```
→ 探活 / **情绪映射选参考** / 请求格式 / 音频返回 / 缓存 / pet:// 播放地址 **全链路打通** ✓

### 9.3 主人如何试

1. **准备语音包**（本项目已构建千夏版）：
   ```
   node tools/build_voicepack.mjs "C:\Users\hazel\Desktop\千夏\千夏参考.list" "C:\Users\hazel\Desktop\千夏\参考音频" qianxia "C:\Users\hazel\Desktop\千夏\模型" tts_out
   ```
   产物在 `tts_out/qianxia/`（emotions.json + refs/47 条 + models/2 个）。**程序会自动在这个目录找语音包**（也可在配置里指定 `voicesDir`）。
2. **启动你的 GPT-SoVITS 服务**（保持运行）。
3. 控制台 → **⚙ 设置 → 🎙 语音**：
   - 运行方式选 **「已有服务」**，填 **地址 + 端口**（默认 127.0.0.1:9880）
   - 点 **🔍 探测服务** → 显示"服务运行中"
   - 勾 **启用语音** + **聊天回复朗读** → 点 **💾 保存并应用**
4. 和她们聊天 → 回复会自动转成语音播放（点击角色可打断）。

**若你的版本报错**（如 v2ProPlus 参数不兼容）：把报错原文发给人家人家来适配；也可在「高级(JSON)」里直接改：
```jsonc
{ "apiPath": "/tts", "params": {"text_lang":"zh","media_type":"wav"},
  "extraBody": {"gpt_path":"…","sovits_path":"…"}, "refFields": {"audio":"ref_audio_path","text":"prompt_text"} }
```

**调试开关**：`QX_TTS_ENABLED=1` · `QX_TTS_PORT=9882` · `QX_TTS_VOICES=<语音包根目录>` · `QX_TTS_DEVICE=cpu|cuda` · `QX_TTS_TEST='qianxia|测试文本|happy'`（启动 8s 后自动合成一句并打日志）

### 9.4 尚未完成（后续阶段）

- 精简推理服务（`server.py`，只保留推理）+ 便携运行时打包（23GB → ~3/4.7GB）
- 控制台「下载语音包」下载器（进度/校验/断点续传）
- 分句流水线、试听页、爱芮/南宫语音包
- 待主人提供 GPT-SoVITS 环境信息后：**针对 v2ProPlus 的参数适配**
