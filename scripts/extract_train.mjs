// 提取 role_2_train（千夏特训事件）galgame 剧本 → src/train_dialog.json
import fs from 'node:fs';

const src = new URL('../../act-webstatic.mihoyo.com/upload-static-galgame/event/nap_cn/novel/006ded47d94006a8b003fabd9f615dd7/chapters/71c448a4db531ee363cd38d7e64e8671.xml', import.meta.url);
const xml = fs.readFileSync(src, 'utf8');

const CHARA_NAMES = {
  qx: '千夏', ng: '南宫', ar: '爱芮', ling: '铃', zhe: '哲',
  '-1': '系统', '-2': '系统'
};

// 千夏台词(按剧本顺序 1..41) → 对应姿势（语义标注）
const QX_POSE_MAP = {
  1: '心累', 2: '生气', 3: '心累', 4: '生气', 5: '心累', 6: '害羞', 7: '害羞', 8: '害羞', 9: '待机', 10: '生气',
  11: '自信', 12: '心累', 13: '自信', 14: '心累', 15: '思考', 16: '害羞', 17: '思考', 18: '生气', 19: '心累', 20: '心累',
  21: '害羞', 22: '心累', 23: '害羞', 24: '害羞', 25: '生气', 26: '思考', 27: '思考', 28: '思考', 29: '自信', 30: '思考',
  31: '思考', 32: '思考', 33: '思考', 34: '思考', 35: '自信', 36: '思考', 37: '待机', 38: '害羞', 39: '自信', 40: '思考', 41: '自信'
};

function unescape(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
function stripTags(s) {
  return s.replace(/\[[^\]]*\]/g, '').trim(); // [em bold] 等标签
}

const chapters = [];
let qxSeq = 0;
const sceneRe = /<scene id="(\d+)" title="([^"]*)">([\s\S]*?)<\/scene>/g;
let sm;
while ((sm = sceneRe.exec(xml))) {
  const sceneId = sm[1];
  const title = sm[2];
  const lines = [];
  const dlRe = /<simple_dialog([^>]*)>([\s\S]*?)<\/simple_dialog>/g;
  let dm;
  while ((dm = dlRe.exec(sm[3]))) {
    const attrs = {};
    const am = /([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = am.exec(dm[1]))) attrs[m[1]] = m[2];
    const text = stripTags(unescape(dm[2]));
    if (!text) continue; // 跳过纯标签行（音效/特效）
    const chara = attrs.chara || '';
    let pose = null;
    if (chara === 'qx') {
      qxSeq++;
      pose = QX_POSE_MAP[qxSeq] || '待机';
    }
    lines.push({
      pos: attrs.pos || 'right',
      chara,
      name: CHARA_NAMES[chara] || chara || '',
      img: attrs.img || '',
      text,
      pose
    });
  }
  chapters.push({ scene: +sceneId, title, lines });
}

const total = chapters.reduce((a, c) => a + c.lines.length, 0);
const qxLines = chapters.flatMap(c => c.lines).filter(l => l.chara === 'qx');
console.log('scenes:', chapters.length, 'lines:', total, 'qx lines:', qxLines.length);
const byPose = {};
for (const l of qxLines) byPose[l.pose] = (byPose[l.pose] || 0) + 1;
console.log('pose spread:', JSON.stringify(byPose));

const out = JSON.stringify({ chapters, total, qxCount: qxLines.length }, null, 1);
const assets = new URL('../assets/train_dialog.json', import.meta.url);
fs.writeFileSync(assets, out, 'utf8');
try { fs.unlinkSync(new URL('../src/train_dialog.json', import.meta.url)); } catch (e) { /* noop */ }
console.log('saved assets/train_dialog.json', (out.length / 1024).toFixed(1) + 'KB (src copy removed)');
