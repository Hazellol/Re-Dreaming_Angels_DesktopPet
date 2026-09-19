// TTS 推理环境包构建工具（项目专用精简版）
// 用法：node tools/build_tts_package.mjs <GPT-SoVITS整合包目录> [输出目录] [--dry]
// 产物：<输出>/tts-runtime-partN.zip（每个 ≤~1.7GB，解压到同一目录即可）+ package-manifest.json
//
// 设计要点：
//   · **白名单**方式挑选文件（只保留 v2ProPlus 推理需要的代码 + 底模），训练/WebUI/UVR5/其它版本底模一律不要
//   · 直接用 Windows 自带 tar.exe 从源目录按文件列表打包（无需复制，省时省磁盘）
//   · 自动按体积分卷（GitHub Release 单文件上限 2GB）→ 多个 zip 解压到同一目录 = 结构还原
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const [, , srcRoot, outRootArg, ...flags] = process.argv;
if (!srcRoot || !fs.existsSync(srcRoot)) {
  console.error('用法: node tools/build_tts_package.mjs <整合包目录> [输出目录]');
  process.exit(1);
}
const DRY = flags.includes('--dry');
const outRoot = outRootArg || path.join(path.dirname(srcRoot), 'tts_pkg_out');
const VOL_LIMIT = 1.7 * 1024 * 1024 * 1024;   // 每卷上限（留出 GitHub 2GB 余量）

// ===== 白名单（v2ProPlus 推理所需）=====
const KEEP_DIRS = [
  { rel: 'runtime', skip: [
    /(^|\\)__pycache__(\\|$)/, /(^|\\)tests?(\\|$)/i, /(^|\\)\.cache(\\|$)/i, /(^|\\)include(\\|$)/i, /(^|\\)logs?(\\|$)/i,
    /\.lib$/i, /\.pdb$/i, /\.pyc$/i,
    // 与 TTS 推理无关的大件（日韩分词词典、构建/数据集/WebUI/ASR 相关）
    /site-packages\\(mecab_ko_dic|eunjeon|pyopenjtalk|ipadic|cmake|pyarrow|gradio|ctranslate2|onnxruntime)(\\|$)/i,
    /site-packages\\torch\\(include|test)(\\|$)/i,
    /site-packages\\torch\\lib\\.*\.lib$/i
  ] },
  { rel: path.join('GPT_SoVITS', 'TTS_infer_pack') },
  { rel: path.join('GPT_SoVITS', 'AR') },
  { rel: path.join('GPT_SoVITS', 'module') },
  { rel: path.join('GPT_SoVITS', 'eres2net') },
  { rel: path.join('GPT_SoVITS', 'BigVGAN') },
  { rel: path.join('GPT_SoVITS', 'text'), skip: [/(^|\\)(ja|ko)(\\|$)/i] },   // 只留中英前端
  { rel: path.join('GPT_SoVITS', 'pretrained_models', 'chinese-hubert-base') },
  { rel: path.join('GPT_SoVITS', 'pretrained_models', 'chinese-roberta-wwm-ext-large') },
  { rel: path.join('GPT_SoVITS', 'pretrained_models', 'fast_langdetect') },
  { rel: path.join('GPT_SoVITS', 'pretrained_models', 'sv') },
  { rel: path.join('GPT_SoVITS', 'pretrained_models', 'v2Pro') },
];
const KEEP_FILES = [
  path.join('GPT_SoVITS', 'sv.py'),
  path.join('GPT_SoVITS', 'inference_webui.py'),
  path.join('GPT_SoVITS', 'process_ckpt.py'),
  path.join('GPT_SoVITS', 'pretrained_models', 's1v3.ckpt'),
  'api_v2.py', 'config.py', 'requirements.txt', 'ffmpeg.exe', 'ffprobe.exe', 'LICENSE',
];

function collect(dirAbs, relBase, skip, out) {
  let items = [];
  try { items = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch (e) { return; }
  for (const it of items) {
    const rel = path.join(relBase, it.name);
    const abs = path.join(dirAbs, it.name);
    if (skip && skip.some((re) => re.test(rel))) continue;
    if (it.isDirectory()) collect(abs, rel, skip, out);
    else if (it.isFile()) {
      let size = 0;
      try { size = fs.statSync(abs).size; } catch (e) { continue; }
      out.push({ rel, abs, size });
    }
  }
}

const files = [];
for (const d of KEEP_DIRS) {
  const abs = path.join(srcRoot, d.rel);
  if (!fs.existsSync(abs)) { console.log('[WARN] 缺失目录:', d.rel); continue; }
  collect(abs, d.rel, d.skip, files);
}
for (const f of KEEP_FILES) {
  const abs = path.join(srcRoot, f);
  if (!fs.existsSync(abs)) { console.log('[WARN] 缺失文件:', f); continue; }
  files.push({ rel: f, abs, size: fs.statSync(abs).size });
}

const totalBytes = files.reduce((a, b) => a + b.size, 0);
console.log('保留文件数:', files.length, ' 总大小:', (totalBytes / 1073741824).toFixed(2), 'GB');
const byTop = {};
for (const f of files) { const k = f.rel.split(path.sep)[0]; byTop[k] = (byTop[k] || 0) + f.size; }
for (const [k, v] of Object.entries(byTop).sort((a, b) => b[1] - a[1])) console.log('   ', k, (v / 1048576).toFixed(0) + 'MB');
if (DRY) { console.log('（--dry 模式：只统计不打包）'); process.exit(0); }

// ===== 分卷 =====
fs.mkdirSync(outRoot, { recursive: true });
const vols = [];
let cur = { files: [], bytes: 0 };
for (const f of files.sort((a, b) => a.rel.localeCompare(b.rel))) {
  if (cur.bytes + f.size > VOL_LIMIT && cur.files.length) { vols.push(cur); cur = { files: [], bytes: 0 }; }
  cur.files.push(f); cur.bytes += f.size;
}
if (cur.files.length) vols.push(cur);
console.log('分卷数:', vols.length, vols.map((v, i) => 'part' + (i + 1) + '=' + (v.bytes / 1048576).toFixed(0) + 'MB').join(' '));

// ===== 逐卷打包（Windows 自带 tar.exe；-T 读文件列表，避免命令行过长）=====
const manifest = { builtAt: new Date().toISOString(), source: path.basename(srcRoot), totalBytes, parts: [] };
vols.forEach((v, i) => {
  const name = 'tts-runtime-part' + (i + 1) + '.zip';
  const zipPath = path.join(outRoot, name);
  const listPath = path.join(outRoot, '_list' + (i + 1) + '.txt');
  fs.writeFileSync(listPath, v.files.map((f) => f.rel).join('\n'), 'utf8');
  console.log('[PACK]', name, '(' + (v.bytes / 1048576).toFixed(0) + 'MB, ' + v.files.length + ' files) ...');
  try {
    execFileSync('tar.exe', ['-a', '-c', '-f', zipPath, '-C', srcRoot, '-T', listPath], { stdio: 'inherit', timeout: 3600000 });
  } catch (e) { console.error('[FAIL]', name, e && e.message); return; }
  let h = crypto.createHash('sha256');
  const buf = Buffer.alloc(1024 * 1024);
  const fd = fs.openSync(zipPath, 'r');
  let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  fs.closeSync(fd);
  const st = fs.statSync(zipPath);
  manifest.parts.push({ name, bytes: st.size, sha256: h.digest('hex') });
  try { fs.unlinkSync(listPath); } catch (e) { /* noop */ }
  console.log('[OK]', name, (st.size / 1048576).toFixed(0) + 'MB');
});
fs.writeFileSync(path.join(outRoot, 'package-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log('完成 →', outRoot, '（含 package-manifest.json）');
