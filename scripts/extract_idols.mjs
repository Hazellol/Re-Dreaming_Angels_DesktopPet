// 提取三角色素材到 Re-Dreaming 项目 assets/：骨架/图集（已由主包解出）/贴图复制
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const ANALYSIS = path.join(ROOT, '..', '_analysis');
const IMG = path.join(ROOT, '..', 'act.mihoyo.com', 'zzz', 'event', 'e20260130-idol-ggxnqr', 'images');
const ASSETS = path.join(ROOT, 'assets');

const plan = [
  // [src, dst]
  [path.join(ANALYSIS, 'skeleton_36_HQ772B5pcEI.json'), path.join(ASSETS, 'airui.json')],   // 爱芮 216骨
  [path.join(ANALYSIS, 'skeleton_15_Qzc6oQuu5qY.json'), path.join(ASSETS, 'nangong.json')], // 南宫 222骨
  [path.join(ANALYSIS, 'nangong.atlas'), path.join(ASSETS, 'nangong.atlas')],
  [path.join(ANALYSIS, 'airui.atlas'), path.join(ASSETS, 'airui.atlas')],
  [path.join(IMG, 'airui.3e643712..png'), path.join(ASSETS, 'airui.png')],
  [path.join(IMG, 'airui_2.55f8acc0..png'), path.join(ASSETS, 'airui_2.png')],
  [path.join(IMG, 'nangong.2b56999e..png'), path.join(ASSETS, 'nangong.png')],
  [path.join(IMG, 'nangong_2.e021df55..png'), path.join(ASSETS, 'nangong_2.png')],
];
for (const [s, d] of plan) {
  if (!fs.existsSync(s)) { console.log('MISSING SRC:', s); continue; }
  fs.copyFileSync(s, d);
  console.log('OK', path.basename(d), (fs.statSync(d).size / 1024).toFixed(0) + 'KB');
}
