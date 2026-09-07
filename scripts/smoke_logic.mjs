// 冒烟测试：官方运行时全流程（待机→走路→姿势→回待机）在 Node 端推进
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

// setIdolSpineMix 同款
const stateData = new spine.AnimationStateData(data);
for (const m of ['哈气', '害羞', '心累', '思考', '生气', '自信']) {
  stateData.setMix('动作_待机', '动作_' + m, 0.3);
  stateData.setMix('动作_' + m, '动作_待机', 0.3);
}
const skeleton = new spine.Skeleton(data);
const state = new spine.AnimationState(stateData);
skeleton.setSkinByName('朝右');
skeleton.setSlotsToSetupPose();
state.setAnimation(0, '动作_待机', true);
state.setAnimation(1, '表情_常态', true);

const log = (tag) => {
  const t0 = state.tracks[0], t1 = state.tracks[1];
  console.log(`${tag}  t0=${t0.animation.name}(loop=${t0.loop},time=${t0.trackTime.toFixed(2)},mix=${t0.mixTime.toFixed(2)}/${t0.mixDuration.toFixed(2)})  t1=${t1.animation.name}`);
};

function step(secondsAt60fps) {
  for (let i = 0; i < secondsAt60fps * 60; i++) {
    state.update(1 / 60);
    state.apply(skeleton);
    skeleton.update(1 / 60);
    skeleton.updateWorldTransform(spine.Physics.update);
  }
}

log('init');
step(1.0);

console.log('--- 走路开始（onWalkStart：镜像+朝左skin+走路/常态）---');
skeleton.scaleX = -1;
skeleton.setSkinByName('朝左');
skeleton.setSlotsToSetupPose();
state.setAnimation(0, '动作_走路', true);
state.setAnimation(1, '表情_常态', true);
log('walk-start');
step(0.6);
log('walk-mid');
step(0.5);

console.log('--- 到达：回待机（resetWalkIdol→clearIdolFace）---');
state.setAnimation(0, '动作_待机', true);
state.setAnimation(1, '表情_常态', true);
log('idle-back');

console.log('--- 姿势：standby → 哈气(pose 1)：changeFace ---');
// 注意：走完后混合状态
state.setAnimation(0, '动作_哈气', true);
state.setAnimation(1, '表情_哈气', true);
log('haqi-start');
step(0.15);
log('haqi-mix(0.15s)');
step(0.3);
log('haqi-mix(0.45s)');
step(2.5);
log('haqi-hold(3s)');

console.log('--- 3s 后回待机（clearIdolFace）---');
state.setAnimation(0, '动作_待机', true);
state.setAnimation(1, '表情_常态', true);
log('idle-final');
step(0.5);
log('final-ok');

// 验证朝左皮肤 + 镜像后的 bbox 是否合理
console.log('--- 朝左 + 镜像 骨架状态 ---');
console.log('skins active:', skeleton.skin.name);
const b = skeleton.bones[0];
console.log('root world:', b.worldX.toFixed(1), b.worldY.toFixed(1));
console.log('SMOKE OK');
