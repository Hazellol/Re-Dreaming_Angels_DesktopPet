// 官方 spine-core@4.2.42 解析千夏素材的验证脚本（Node ESM，无 DOM）
import * as spine from '@esotericsoftware/spine-core';
import fs from 'node:fs';

const atlasText = fs.readFileSync(new URL('../assets/qianxia.atlas', import.meta.url), 'utf8');
const skeletonText = fs.readFileSync(new URL('../assets/qianxia.json', import.meta.url), 'utf8');

console.log('=== 1. TextureAtlas 解析 ===');
const atlas = new spine.TextureAtlas(atlasText);
console.log('pages:', atlas.pages.map(p => ({ name: p.name, w: p.width, h: p.height })));
console.log('regions:', atlas.regions.length);
// 手动回填 page.texture（无 DOM，用占位）
for (const page of atlas.pages) {
  page.texture = null;
  page.setTexture({ setFilters() {}, setWraps() {}, dispose() {} });
}
console.log('sample region:', atlas.findRegion('脸'));

console.log('=== 2. SkeletonJson 解析 ===');
const loader = new spine.AtlasAttachmentLoader(atlas);
const json = new spine.SkeletonJson(loader);
const data = json.readSkeletonData(skeletonText);
console.log('bones:', data.bones.length, 'slots:', data.slots.length,
  'ik:', data.ikConstraints.length, 'transform:', data.transformConstraints.length,
  'physics:', data.physicsConstraints.length,
  'skins:', data.skins.map(s => s.name));
console.log('defaultSkin:', data.defaultSkin?.name);

console.log('=== 3. 动画清单+时长 ===');
for (const [name, anim] of Object.entries(data.animations)) {
  const tl = anim.timelines || [];
  let kinds = {};
  for (const t of tl) kinds[t.constructor.name] = (kinds[t.constructor.name] || 0) + 1;
  console.log(`${name}\t dur=${anim.duration.toFixed(3)}s\t${JSON.stringify(kinds)}`);
}

console.log('=== 4. setSkinByName 语义验证（defaultSkin 兜底） ===');
const skeleton = new spine.Skeleton(data);
skeleton.setSkinByName('朝右');
skeleton.setSlotsToSetupPose();
skeleton.updateWorldTransform(spine.Physics.update);
const slotNames = ['刘海a_朝左', '后发_朝右_马尾', '发', '脸', '嘴巴_常态'];
for (const sn of slotNames) {
  const slot = skeleton.findSlot(sn);
  if (!slot) { console.log(`slot ${sn}: 不存在`); continue; }
  console.log(`slot ${sn}: attachment=${slot.getAttachment()?.name ?? null} (class=${slot.getAttachment()?.constructor.name ?? '-'})`);
}

console.log('=== 5. 渲染包围盒（default+朝右 皮肤, setupPose） ===');
computeBBox(skeleton);

function computeBBox(skel) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const verts = new Float32Array(1024);
  for (const slot of skel.drawOrder) {
    const att = slot.getAttachment();
    if (!att) continue;
    if (att instanceof spine.RegionAttachment) {
      const c = att.computeWorldVertices(slot, verts, 0, 2);
      for (let i = 0; i < c; i += 2) {
        minX = Math.min(minX, verts[i]); maxX = Math.max(maxX, verts[i]);
        minY = Math.min(minY, verts[i + 1]); maxY = Math.max(maxY, verts[i + 1]);
      }
    } else if (att instanceof spine.MeshAttachment) {
      att.computeWorldVertices(slot, 0, att.worldVerticesLength, verts, 0, 2);
      for (let i = 0; i < att.worldVerticesLength; i += 2) {
        minX = Math.min(minX, verts[i]); maxX = Math.max(maxX, verts[i]);
        minY = Math.min(minY, verts[i + 1]); maxY = Math.max(maxY, verts[i + 1]);
      }
    } else if (att instanceof spine.BoundingBoxAttachment) {
      att.computeWorldVertices(slot, 0, att.vertexCount * 2, verts, 0, 2);
      for (let i = 0; i < att.vertexCount * 2; i += 2) {
        minX = Math.min(minX, verts[i]); maxX = Math.max(maxX, verts[i]);
        minY = Math.min(minY, verts[i + 1]); maxY = Math.max(maxY, verts[i + 1]);
      }
    }
  }
  console.log(`bbox: x [${minX.toFixed(1)}, ${maxX.toFixed(1)}] w=${(maxX - minX).toFixed(1)}`);
  console.log(`bbox: y [${minY.toFixed(1)}, ${maxY.toFixed(1)}] h=${(maxY - minY).toFixed(1)}`);
  console.log(`脚底相对原点: y=${minY.toFixed(1)}  头顶: y=${maxY.toFixed(1)}`);
  // 左右中心
  console.log(`水平中心: x=${((minX + maxX) / 2).toFixed(1)}`);
}
