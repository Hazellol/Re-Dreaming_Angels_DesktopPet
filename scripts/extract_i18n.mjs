// 从镜像 i18n JSON 提取千夏 (id=2) 相关文案
import fs from 'node:fs';

const src = new URL('../../fastcdn.mihoyo.com/mi18n/nap_cn/m20251014hy2e1kt0jk/m20251014hy2e1kt0jk-zh-cn.json', import.meta.url);
const json = JSON.parse(fs.readFileSync(src, 'utf8'));
console.log('total keys:', Object.keys(json).length);

const pick = {};
for (const [k, v] of Object.entries(json)) {
  // 千夏 = id 2
  if (/^standby_2_/.test(k) || /^interact_2_/.test(k) || /^home_.*_btn$/.test(k) || /^friendship_/.test(k)) {
    pick[k] = v;
  }
}
// 也看看有哪些 standby/interact 键
const all = Object.keys(json).filter(k => /^(standby|interact)_/.test(k)).sort();
console.log('ALL standby/interact keys:', all.join(', '));

fs.writeFileSync(new URL('../src/i18n.json', import.meta.url), JSON.stringify(pick, null, 1), 'utf8');
console.log('picked keys:', Object.keys(pick).length);
console.log(JSON.stringify(pick, null, 1));
