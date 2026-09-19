# TTS 推理环境包 · 打包与发布说明

> 目标：把 GPT-SoVITS 整合包**精简**成"只跑 TTS 推理"的项目专用包（v2ProPlus），上传到 GitHub Release，用户从控制台**一键下载 + 自动集成**。

---

## 1. 打包（一条命令）

```powershell
node tools\build_tts_package.mjs "D:\GPT-SoVITS-v2pro-20250604" "D:\tts_pkg_out"
```

产出（本次实测）：

| 文件 | 大小 |
|---|---|
| `tts-runtime-part1.zip` | 1630 MB |
| `tts-runtime-part2.zip` | 1741 MB |
| `tts-runtime-part3.zip` | 1670 MB |
| `tts-runtime-part4.zip` | 1422 MB |
| `tts-runtime-part5.zip` | 1282 MB |
| `package-manifest.json` | 体积 + SHA256 清单 |

- **原包 13.22 GB → 精简后 7.56 GB**（runtime 5.26 GB + GPT_SoVITS 2.49 GB）
- **每卷 < 2GB**（GitHub Release 单文件上限）→ **多个 zip 解压到同一目录即还原完整结构**
- 打包工具用 Windows 自带 `tar.exe` 直接从源目录按白名单取文件（不复制中间目录、不额外占磁盘）

## 2. 精简清单（保留 / 删除）

**保留**
```
runtime\                        便携 Python + 依赖（torch 等）
GPT_SoVITS\TTS_infer_pack\ AR\ module\ eres2net\ BigVGAN\
GPT_SoVITS\text\                中英文本前端（日/韩已剔除）
GPT_SoVITS\sv.py  inference_webui.py  process_ckpt.py
GPT_SoVITS\pretrained_models\v2Pro\   <- s2Gv2ProPlus.pth / s2Dv2ProPlus.pth / s2Gv2Pro.pth
GPT_SoVITS\pretrained_models\sv\      <- pretrained_eres2net*.ckpt（v2Pro 系列必需）
GPT_SoVITS\pretrained_models\s1v3.ckpt  chinese-hubert-base\  chinese-roberta-wwm-ext-large\  fast_langdetect\
api_v2.py  config.py  requirements.txt  LICENSE
```

**删除（约 -5.7GB）**
```
tools\（UVR5 等 1.97GB）   Docker\   docs\   *.ipynb   webui.py   batch_inference.py
pretrained_models\gsv-v4-pretrained\（788MB） s2Gv3.pth（733MB） gsv-v2final-pretrained\（338MB）
pretrained_models\s2D488k.pth s2G488k.pth models--nvidia--bigvgan*（共约 405MB）
训练代码（s1_train.py / s2_train.py / 数据集处理工具）
runtime 内：日/韩分词词典（mecab_ko_dic/eunjeon/pyopenjtalk/ipadic ≈480MB）、
           gradio / onnxruntime / ctranslate2 / pyarrow / cmake（≈670MB）、tests / __pycache__ / *.lib / *.pdb
```

## 3. 发布（主人操作）

1. 在 GitHub 仓库建一个 **Release**（如 `tts-runtime-v1`）
2. 上传 **5 个 `tts-runtime-partN.zip`**（每个 <2GB ✓）与 `package-manifest.json`
3. **建议同时上传国内网盘**（GitHub 直连慢；控制台支持填任意直链）
4. 记录每个 zip 的**下载直链**（GitHub Release 资产直链形如
   `https://github.com/<用户>/<仓库>/releases/download/<tag>/tts-runtime-part1.zip`）

## 4. 用户侧使用（控制台）

控制台 → ⚙ 设置 → 🎙 语音 → 运行方式选 **「桌宠启动」** → **一键下载** 框里**每行粘贴一个 zip 直链** →

```
https://.../tts-runtime-part1.zip
https://.../tts-runtime-part2.zip
...
```

点 **「⬇ 一键下载并自动集成」** → 依次下载（显示【包 x/N】与进度）→ 自动解压到
`%APPDATA%\re-dreaming-angels-desktop-pet\tts\` → **递归探测 `python.exe` 与 `api_v2.py`** →
自动写入配置（managed + 路径 + 启用）→ **完成即可用** ✓

## 5. 角色语音包（单独分发）

与运行时分开发布（用户可按需只下喜欢的角色）：

```powershell
node tools\build_voicepack.mjs "C:\Users\hazel\Desktop\千夏\千夏参考.list" "C:\Users\hazel\Desktop\千夏\参考音频" qianxia "C:\Users\hazel\Desktop\千夏\模型" tts_out
```
产出 `tts_out\<角色>\`：`emotions.json`（情绪映射）+ `refs\`（参考音频）+ `models\`（ckpt/pth）+ `pack.json`。
上传后，用户把它解压到 `%APPDATA%\re-dreaming-angels-desktop-pet\tts\voices\<角色>\` 即可
（桌宠会自动在 `tts\voices\` 与项目 `tts_out\` 两处查找语音包）。

> 提示：**角色权重可以不打进语音包** —— 桌宠会自动把 `models\` 里的
> `*.ckpt`/`*.pth` 作为 `gpt_path`/`sovits_path` 随请求发给服务，保证用该角色的权重推理（音色正确）。

## 6. 版权与合规

- GPT-SoVITS 为 **MIT** 许可：分发精简包时**保留 `LICENSE`** 并在 README 注明"基于 GPT-SoVITS 精简，仅保留推理功能"。
- 角色语音模型/参考音频属于**用户自行训练/整理**的素材，请遵守原始素材的授权范围。
