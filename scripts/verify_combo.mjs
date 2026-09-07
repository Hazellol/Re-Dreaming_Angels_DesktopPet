// 实证 combo skin 合并 + 动画 apply 后的槽附件状态
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

const eyeWhiteSlot = data.findSlot('眼R_眼白').index;
console.log('眼R_眼白 slot index =', eyeWhiteSlot);

console.log('\n=== 1. combo.addSkin 合并测试 ===');
const combo = new spine.Skin('combo');
combo.addSkin(data.defaultSkin);
combo.addSkin(data.findSkin('朝右'));
console.log('combo.getAttachment(眼白, `眼R_眼白`) =', combo.getAttachment(eyeWhiteSlot, '眼R_眼白') ? combo.getAttachment(eyeWhiteSlot, '眼R_眼白').constructor.name : null);
const browSlot = data.findSlot('眉毛').index;
console.log('combo.getAttachment(眉毛, `眉毛_常态`) =', combo.getAttachment(browSlot, '眉毛_常态') ? 'OK' : null);

console.log('\n=== 2. skeleton.setSkin(combo) 后 ===');
const skeleton = new spine.Skeleton(data);
skeleton.setSkin(combo);
skeleton.setSlotsToSetupPose();
skeleton.updateWorldTransform(spine.Physics.update);
console.log('skeleton.skin.name =', skeleton.skin.name);
console.log('skeleton.getAttachment(眼白,`眼R_眼白`) =', skeleton.getAttachment(eyeWhiteSlot, '眼R_眼白') ? 'OK' : null);
console.log('slot 眼R_眼白 attachment =', skeleton.findSlot('眼R_眼白').getAttachment() ? skeleton.findSlot('眼R_眼白').getAttachment().constructor.name : null);

console.log('\n=== 3. 播放 表情_常态 + 动作_待机 3 秒后槽状态 ===');
const stateData = new spine.AnimationStateData(data);
const state = new spine.AnimationState(stateData);
state.setAnimation(0, '动作_待机', true);
state.setAnimation(1, '表情_常态', true);
for (let i = 0; i < 60 * 2; i++) {
  state.update(1 / 60);
  state.apply(skeleton);
  skeleton.updateWorldTransform(spine.Physics.update);
}
for (const sn of ['眼R_眼白', '眼R_眼珠', '眼R_眼框上', '眉毛', '嘴巴', '脸', '闭眼']) {
  const slot = skeleton.findSlot(sn);
  if (!slot) { console.log(sn, ': 槽不存在'); continue; }
  const a = slot.getAttachment();
  console.log(`slot ${sn}: ${a ? a.constructor.name + ' ' + (a.name || '') : 'NULL (空槽)'}`);
}

console.log('\n=== 4. 播放 表情_心累 后槽状态（重点） ===');
state.setAnimation(0, '动作_心累', true);
state.setAnimation(1, '表情_心累', true);
for (let i = 0; i < 60 * 1; i++) {
  state.update(1 / 60);
  state.apply(skeleton);
  skeleton.updateWorldTransform(spine.Physics.update);
}
for (const sn of ['眼R_眼白', '眼R_眼珠', '眼R_眼框上', '眼L_眼珠']) {
  const slot = skeleton.findSlot(sn);
  const a = slot ? slot.getAttachment() : null;
  console.log(`slot ${sn}: ${a ? a.constructor.name + ' ' + (a.name || '') : 'NULL (空槽)'}`);
}
console.log('DONE');
