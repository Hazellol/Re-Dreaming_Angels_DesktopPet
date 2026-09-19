// 情绪映射生成器：把"千夏参考.list"（音频|情绪标签|台词）转成 TTS 服务用的 emotions.json
// 用法：node tools/build_emotions.mjs <list文件> <音频目录> <角色key> [输出文件]
// 例： node tools/build_emotions.mjs "C:\Users\hazel\Desktop\千夏\千夏参考.list" "C:\Users\hazel\Desktop\千夏\参考音频" qianxia
//
// 设计要点：
//   · list 天然自带情绪标注 → 零手工成本；每个 mood 收集多条候选，合成时随机取一条（语气更自然）
//   · 缺某情绪自动回落到 neutral；可用 --overrides 手工指定（见文件末尾示例）
import fs from 'node:fs';
import path from 'node:path';

const [, , listPath, audioDir, roleKey, outPathArg] = process.argv;
if (!listPath || !audioDir || !roleKey) {
  console.error('用法: node tools/build_emotions.mjs <list> <音频目录> <角色key> [输出json]');
  process.exit(1);
}

// 我们项目 AI 协议的 7 种 mood（core/renderer 里已有的 <mood:X>）→ 语音包 list 里的情绪标签
const MOOD_RULES = {
  neutral: ['日常'],
  happy: ['开心', '兴奋', '高兴', '鼓励'],
  sad: ['沮丧', '担心', '难过', '失落'],
  angry: ['愤怒', '生气', '不满'],
  shy: ['害羞', '羡慕'],
  think: ['疑惑', '思考', '好奇'],
  tired: ['紧张', '努力', '心累'],
  proud: ['努力', '鼓励', '自信']
};
// 手工覆盖（可选）：某 mood 强制只用这些音频（文件名不含扩展名或含均可匹配）
const OVERRIDES = {
  // proud: ['OngoingLevel_ActivityLivehouse_Sunna_610033034_001.wav'],
  // tired: ['OngoingLevel_ActivityLivehouse_Sunna_610033013_002.wav']
};

const raw = fs.readFileSync(listPath, 'utf8').split(/\r?\n/).filter((l) => l.trim());
const entries = [];
for (const line of raw) {
  const parts = line.split('|');
  if (parts.length < 3) continue;
  const file = parts[0].trim();
  const tags = parts[1].split(/[，,、]/).map((s) => s.trim()).filter(Boolean);
  const text = parts.slice(2).join('|').trim();
  const abs = path.join(audioDir, path.basename(file));
  entries.push({ file: path.basename(file), tags, text, exists: fs.existsSync(abs) });
}

const map = {};
for (const [mood, tags] of Object.entries(MOOD_RULES)) {
  const pick = entries.filter((e) => e.exists && e.tags.some((t) => tags.includes(t)));
  if (pick.length) {
    map[mood] = pick
      .sort((a, b) => a.file.localeCompare(b.file))
      .map((e) => ({ ref: e.file, text: e.text, tags: e.tags }));
  }
}
// overrides 优先
for (const [mood, files] of Object.entries(OVERRIDES)) {
  const pick = entries.filter((e) => e.exists && files.some((f) => e.file === f || e.file.startsWith(f)));
  if (pick.length) map[mood] = pick.map((e) => ({ ref: e.file, text: e.text, tags: e.tags }));
}
// 回落：没配到的 mood 用 neutral
const fallback = map.neutral || (entries[0] ? [{ ref: entries[0].file, text: entries[0].text, tags: entries[0].tags }] : []);
for (const mood of Object.keys(MOOD_RULES)) if (!map[mood] || !map[mood].length) map[mood] = fallback;

const out = {
  role: roleKey,
  source: path.basename(listPath),
  generatedAt: new Date().toISOString().slice(0, 10),
  default: 'neutral',
  stats: Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v.length])),
  map
};

const outPath = outPathArg || path.join('tts_out', roleKey, 'emotions.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8');

console.log('条目总数:', entries.length, ' 音频缺失:', entries.filter((e) => !e.exists).length);
console.log('情绪覆盖:', Object.entries(out.stats).map(([k, v]) => k + '×' + v).join('  '));
console.log('已写入:', outPath);
