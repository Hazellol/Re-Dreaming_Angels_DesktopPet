// 核对：动画 AttachmentTimeline 引用名 vs default/朝右 皮肤中的附件（千夏）
import * as spine from '@esotericsoftware/spine-core';
import fs from 'node:fs';

const atlasText = fs.readFileSync(new URL('../assets/qianxia.atlas', import.meta.url), 'utf8');
const skeletonText = fs.readFileSync(new URL('../assets/qianxia.json', import.meta.url), 'utf8');

const atlas = new spine.TextureAtlas(atlasText);
for (const page of atlas.pages) {
  page.texture = null;
  page.setTexture({ setFilters() {}, setWraps() {}, dispose() {} });
}
const data = new spine.SkeletonJson(new spine.AtlasAttachmentLoader(atlas)).readSkeletonData(skeletonText);

const defSkin = data.defaultSkin;
const rightSkin = data.findSkin('朝右');

function slotSets(skin) {
  const map = new Map(); // slotIndex -> Set(names)
  for (let i = 0; i < data.slots.length; i++) {
    const atts = [];
    skin.getAttachmentsForSlot(i, atts);
    const names = atts.map(a => a.name);
    if (names.length) map.set(i, new Set(names));
  }
  return map;
}
const defMap = slotSets(defSkin);
const rightMap = slotSets(rightSkin);

console.log('=== 眼睛相关槽的 default 附件名 ===');
const eyeRe = /眼|眉|嘴|脸|闭眼|耳/;
for (const [si, names] of defMap) {
  const sn = data.slots[si].name;
  if (eyeRe.test(sn)) {
    console.log(`slot[${si}] ${sn}: ${[...names].join(' | ')}`);
  }
}

console.log('\n=== 关键动画的 AttachmentTimeline 引用核对 ===');
const anims = ['动作_待机', '动作_心累', '动作_思考', '动作_生气', '表情_心累', '表情_思考', '表情_生气', '表情_常态', '表情_自信', '表情_哈气', '表情_害羞', '表情_皱眉'];
for (const an of anims) {
  const anim = data.findAnimation(an);
  if (!anim) { console.log(an + ': 不存在'); continue; }
  let attTimelines = 0;
  const refs = [];
  for (const tl of anim.timelines) {
    if (tl.constructor.name === 'AttachmentTimeline') {
      attTimelines++;
      const slotName = data.slots[tl.slotIndex].name;
      refs.push({ slotName, names: [...tl.attachmentNames] });
    }
  }
  console.log(`\n[${an}] attachmentTimelines=${attTimelines}`);
  for (const r of refs) {
    for (const n of r.names) {
      if (!n) continue;
      const si = data.slots.findIndex(s => s.name === r.slotName);
      const inDef = defMap.has(si) && defMap.get(si).has(n);
      const inRight = rightMap.has(si) && rightMap.get(si).has(n);
      if (!inDef && !inRight) console.log(`  !!! ${r.slotName} <- "${n}"  (两个皮肤都缺)`);
      else if (!inRight) console.log(`  [仅default] ${r.slotName} <- "${n}"`);
    }
  }
}
