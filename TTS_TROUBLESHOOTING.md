# TTS 音色问题 · 完整排查档案（已解决）

> 现象：本地推理的音色与"云端训练/推理"效果不一致。
> 结论：**不是参考音频、不是情绪映射、也不是桌宠代码** —— 而是**推理环境的底模配置**。

---

## 根因链（三层，逐层排除）

### ① 本地整合包版本不对（`v3lora`）
- 本地原为 `D:\GPT-SoVITS-v3lora-20250401`（**v3 系**）
- 其 `pretrained_models\` 只有 `s2Gv3.pth` / `s2D488k.pth` / `gsv-v2final-pretrained\`…，**完全没有 v2ProPlus 的底模**
- v2ProPlus 推理需要：`v2Pro/s2Gv2ProPlus.pth` + `sv/pretrained_eres2net*.ckpt` + `s1v3.ckpt` + `chinese-hubert-base` + `chinese-roberta-wwm-ext-large`
- → **权重（Plus）+ 底模（v3/v2final）不匹配** → 能出声但音色跑偏

### ② 换用 `GPT-SoVITS-v2pro-20250604` 后**仍然不对** —— 真正的坑 ⭐
该包的 `GPT_SoVITS/configs/tts_infer.yaml` 里：

```yaml
custom:                 # ← api_v2.py 默认读取这一段！
  version: v2
  t2s_weights_path: .../gsv-v2final-pretrained/s1bert25hz-5kh-....ckpt
  vits_weights_path: .../gsv-v2final-pretrained/s2G2333k.pth      # ← v2final 底模
  ...
v2ProPlus:              # ← 正确的配置一直躺在这里，但没人用它
  version: v2ProPlus
  t2s_weights_path: GPT_SoVITS/pretrained_models/s1v3.ckpt
  vits_weights_path: GPT_SoVITS/pretrained_models/v2Pro/s2Gv2ProPlus.pth
```

**服务默认加载 `custom` 段 = v2final 底模** → 即使用我们的请求带上了角色的 `gpt_path/sovits_path`，
**底模仍是 v2final** → **音色依旧不对**。

**修复**：把 `custom:` 段改写为 v2ProPlus：

```yaml
custom:
  bert_base_path: GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large
  cnhuhbert_base_path: GPT_SoVITS/pretrained_models/chinese-hubert-base
  device: cuda
  is_half: true
  t2s_weights_path: GPT_SoVITS/pretrained_models/s1v3.ckpt
  version: v2ProPlus
  vits_weights_path: GPT_SoVITS/pretrained_models/v2Pro/s2Gv2ProPlus.pth
```

服务启动日志确认生效：
```
version           : v2ProPlus
Loading VITS weights from .../v2Pro/s2Gv2ProPlus.pth. <All keys matched successfully>
```

### ③ 精简包时删掉了"看起来无用但其实被 import"的依赖
逐个补齐（迭代排查）：

| 缺失模块 | 来源 | 说明 |
|---|---|---|
| `tools.i18n` | `api_v2.py` | i18n 文案 |
| `feature_extractor` | `TTS.py` | CNHuBERT 封装 |
| `datasets1` | `tools/audio_sr.py` | 在 `tools/AP_BWE_main/datasets1`（该文件会 `sys.path.append(AP_BWE_main)`） |
| `ipadic` / `pyopenjtalk` / `mecab_ko_dic` / `eunjeon` | 文本前端初始化 | 日/韩分词词典（**即使只合成中文也会被加载**） |
| `onnxruntime` | sv / eres2net 相关 | 说话人验证 |

→ **教训：GPT-SoVITS 的依赖链很杂，精简时应"保守删除"**。

---

## 最终验证（v2ProPlus 底模 + 千夏权重 + 开心情绪参考）

```
[TTS] request → { text:"你好呀！今天也要开开心心哦！",
                  ref: OngoingMainCity_..._610033001_002.wav,
                  prompt:"回来后，我就好像没那么害怕演出了。",
                  gpt_path:"qianxia-e15.ckpt", sovits_path:"qianxia_e8_s96.pth", mood:"happy" }
[TTS-TEST] {"ok":true,"bytes":193324}
[TTs] test-play ok
→ tts_cache/qianxia/f68f27ec_happy_你好呀！今天也要开开心心.wav (188.8 KB)
```

---

## 对"打包/分发"的影响（必须做到）

1. **包内配置必须是 v2ProPlus**：安装器解压后**自动改写** `GPT_SoVITS/configs/tts_infer.yaml` 的 `custom` 段（不能让用户手动改）
2. **精简要保守**：`tools/` 只删 `uvr5`(718MB) 与 `asr`(1134MB，保留 `config.py`/`__init__.py`)；`runtime/site-packages` **不再按包名删除**（只删 `__pycache__`/`tests`/`.lib`/`.pdb`）
3. **底模白名单**：保留 `v2Pro/`(s2Gv2ProPlus, s2Dv2ProPlus, s2Gv2Pro…)、`sv/`、`s1v3.ckpt`、BERT、HuBERT、`fast_langdetect`；删 v3/v4/v2final/bigvgan 大件
4. **设备可配**：`custom.device: cuda|cpu`、`is_half` 随用户的 GPU/CPU 选择写入
