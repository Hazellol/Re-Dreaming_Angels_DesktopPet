// 提取三角色 i18n 台词（standby/interact 全量）+ 三角色特训剧本 → assets/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const ASSETS = path.join(ROOT, 'assets');

// ---------- i18n ----------
const i18nSrc = path.join(ROOT, '..', 'fastcdn.mihoyo.com', 'mi18n', 'nap_cn', 'm20251014hy2e1kt0jk', 'm20251014hy2e1kt0jk-zh-cn.json');
const json = JSON.parse(fs.readFileSync(i18nSrc, 'utf8'));
const pick = {};
for (const [k, v] of Object.entries(json)) {
  if (/^(standby|interact)_/.test(k)) pick[k] = v;
}
fs.writeFileSync(path.join(ASSETS, 'i18n.json'), JSON.stringify(pick, null, 1), 'utf8');
console.log('i18n keys:', Object.keys(pick).length);

// ---------- 剧本（3 个角色特训事件）----------
const NOVEL = path.join(ROOT, '..', 'act-webstatic.mihoyo.com', 'upload-static-galgame', 'event', 'nap_cn', 'novel',
  '006ded47d94006a8b003fabd9f615dd7', 'chapters');
const CHARA_NAMES = {
  '-1': '玩家', '-2': 'text', '-3': 'text',
  ng: '南宫', qx: '千夏', ar: '爱芮', sxly: '塞西莉亚', ling: '铃', zhe: '哲',
  fairy: 'fairy', group: '妄想天使', billy: '比利', jff: '橘福福', burnice: '柏妮思',
  astra: '耀嘉音', alice: '爱丽斯', anby: '安比', pp: '派派', rp: '法厄同', err: '系统错误'
};
// 千夏台词 → 姿势标注（以剧本内千夏台词序号 1..41 计；重新提取时保持顺序）
const QX_POSE_MAP = {
  1: '心累', 2: '生气', 3: '心累', 4: '生气', 5: '心累', 6: '害羞', 7: '害羞', 8: '害羞', 9: '待机', 10: '生气',
  11: '自信', 12: '心累', 13: '自信', 14: '心累', 15: '思考', 16: '害羞', 17: '思考', 18: '生气', 19: '心累', 20: '心累',
  21: '害羞', 22: '心累', 23: '害羞', 24: '害羞', 25: '生气', 26: '思考', 27: '思考', 28: '思考', 29: '自信', 30: '思考',
  31: '思考', 32: '思考', 33: '思考', 34: '思考', 35: '自信', 36: '思考', 37: '待机', 38: '害羞', 39: '自信', 40: '思考', 41: '自信'
};

const ROLES = [
  { key: 'airui', chara: 'ar', file: 'd3a269694f83523f0b06bf1d35ecbe06.xml', poseMap: null },  // role_1_train 爱芮
  { key: 'qianxia', chara: 'qx', file: '71c448a4db531ee363cd38d7e64e8671.xml', poseMap: QX_POSE_MAP },
  { key: 'nangong', chara: 'ng', file: '5001e3e1268c1c56aa344d25a7fe90a2.xml', poseMap: null }   // role_3_train 南宫
];

function unescape(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
function stripTags(s) {
  return s.replace(/\[[^\]]*\]/g, '').trim();
}

const roles = {};
for (const role of ROLES) {
  const xml = fs.readFileSync(path.join(NOVEL, role.file), 'utf8');
  const chapters = [];
  let seq = 0;
  const sceneRe = /<scene id="(\d+)" title="([^"]*)">([\s\S]*?)<\/scene>/g;
  let sm;
  while ((sm = sceneRe.exec(xml))) {
    const lines = [];
    const dlRe = /<simple_dialog([^>]*)>([\s\S]*?)<\/simple_dialog>/g;
    let dm;
    while ((dm = dlRe.exec(sm[3]))) {
      const attrs = {};
      const am = /([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*"([^"]*)"/g;
      let m;
      while ((m = am.exec(dm[1]))) attrs[m[1]] = m[2];
      const text = stripTags(unescape(dm[2]));
      if (!text) continue;
      const chara = attrs.chara || '';
      let pose = null;
      if (role.poseMap && chara === role.chara) {
        seq++;
        pose = role.poseMap[seq] || '待机';
      }
      lines.push({
        pos: attrs.pos || 'right', chara, name: CHARA_NAMES[chara] || chara || '',
        img: attrs.img || '', text, pose
      });
    }
    chapters.push({ scene: +sm[1], title: sm[2], lines });
  }
  const total = chapters.reduce((a, c) => a + c.lines.length, 0);
  const own = chapters.flatMap(c => c.lines).filter(l => l.chara === role.chara).length;
  console.log(`${role.key}: scenes=${chapters.length} lines=${total} own=${own}`);
  roles[role.key] = { chapters, total };
}

fs.writeFileSync(path.join(ASSETS, 'train_dialog.json'),
  JSON.stringify({ roles }, null, 1), 'utf8');
console.log('saved assets/train_dialog.json');
