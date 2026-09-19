// 语音包构建工具：把「角色资源目录」组装成标准语音包
// 用法：node tools/build_voicepack.mjs <list文件> <参考音频目录> <角色key> [模型目录] [输出目录]
// 产物： <输出>/<角色>/emotions.json + 参考音频（复制）+ models/（ckpt/pth 若有）
// 例： node tools/build_voicepack.mjs "C:\Users\hazel\Desktop\千夏\千夏参考.list" "C:\Users\hazel\Desktop\千夏\参考音频" qianxia "C:\Users\hazel\Desktop\千夏\模型" tts_out
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [, , listPath, audioDir, roleKey, modelDir, outRootArg] = process.argv;
if (!listPath || !audioDir || !roleKey) {
  console.error('用法: node tools/build_voicepack.mjs <list> <音频目录> <角色key> [模型目录] [输出目录]');
  process.exit(1);
}
const outRoot = outRootArg || 'tts_out';
const outDir = path.join(outRoot, roleKey);
const aOut = path.join(outDir, 'refs');
fs.mkdirSync(aOut, { recursive: true });

// 1) 生成情绪映射（复用 build_emotions）
execFileSync(process.execPath, [path.join('tools', 'build_emotions.mjs'), listPath, audioDir, roleKey, path.join(outDir, 'emotions.json')], { stdio: 'inherit' });

// 2) 复制参考音频（emotions.json 里引用到的全部文件）
const emo = JSON.parse(fs.readFileSync(path.join(outDir, 'emotions.json'), 'utf8'));
const refs = new Set();
for (const list of Object.values(emo.map)) for (const it of list) refs.add(path.basename(it.ref));
let copied = 0, missing = 0;
for (const f of refs) {
  const src = path.join(audioDir, f);
  if (!fs.existsSync(src)) { missing++; continue; }
  fs.copyFileSync(src, path.join(aOut, f));
  copied++;
}

// 3) 复制模型（可选）
let models = [];
if (modelDir && fs.existsSync(modelDir)) {
  const mOut = path.join(outDir, 'models');
  fs.mkdirSync(mOut, { recursive: true });
  for (const f of fs.readdirSync(modelDir)) {
    if (!/\.(ckpt|pth)$/i.test(f)) continue;
    fs.copyFileSync(path.join(modelDir, f), path.join(mOut, f));
    models.push(f);
  }
}

// 4) 写语音包清单
const manifest = {
  role: roleKey,
  builtAt: new Date().toISOString().slice(0, 10),
  version: 'v2ProPlus',
  refsDir: 'refs',
  emotions: 'emotions.json',
  models,
  stats: { refs: copied, missing, moods: Object.keys(emo.map).length }
};
fs.writeFileSync(path.join(outDir, 'pack.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log('语音包已生成:', outDir, JSON.stringify(manifest.stats), 'models:', models.join(',') || '(无)');
