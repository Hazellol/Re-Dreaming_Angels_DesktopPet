// 输出全部千夏台词（编号/场景），供姿势标注
import fs from 'node:fs';
const src = new URL('../assets/train_dialog.json', import.meta.url);
const data = JSON.parse(fs.readFileSync(src, 'utf8'));
let i = 0;
for (const c of data.chapters) {
  for (const l of c.lines) {
    if (l.chara === 'qx') {
      i++;
      console.log(`${i}\t[${c.scene}] ${l.img}\t${l.text}`);
    }
  }
}
console.log('total qx:', i);
