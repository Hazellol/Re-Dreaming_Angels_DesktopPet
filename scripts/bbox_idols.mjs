// 计算 airui/nangong 的渲染 bbox（默认+朝右皮肤 setup pose；与千夏 verify 同法）
import * as spine from '@esotericsoftware/spine-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HERE, '..', 'assets');

for (const name of ['airui', 'nangong']) {
  const atlasText = fs.readFileSync(path.join(ASSETS, name + '.atlas'), 'utf8');
  const skeletonText = fs.readFileSync(path.join(ASSETS, name + '.json'), 'utf8');
  const atlas = new spine.TextureAtlas(atlasText);
  for (const page of atlas.pages) {
    page.texture = null;
    page.setTexture({ setFilters() {}, setWraps() {}, dispose() {} });
  }
  const data = new spine.SkeletonJson(new spine.AtlasAttachmentLoader(atlas)).readSkeletonData(skeletonText);
  const combo = new spine.Skin('combo');
  combo.addSkin(data.defaultSkin);
  combo.addSkin(data.findSkin('朝右'));
  const skeleton = new spine.Skeleton(data);
  skeleton.setSkin(combo);
  skeleton.setSlotsToSetupPose();
  skeleton.updateWorldTransform(spine.Physics.update);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const verts = new Float32Array(4096);
  for (const slot of skeleton.drawOrder) {
    const att = slot.getAttachment();
    if (!att) continue;
    let n = 0;
    if (att instanceof spine.RegionAttachment) {
      n = att.computeWorldVertices(slot, verts, 0, 2);
    } else if (att instanceof spine.MeshAttachment) {
      att.computeWorldVertices(slot, 0, att.worldVerticesLength, verts, 0, 2);
      n = att.worldVerticesLength;
    }
    for (let i = 0; i < n; i += 2) {
      minX = Math.min(minX, verts[i]); maxX = Math.max(maxX, verts[i]);
      minY = Math.min(minY, verts[i + 1]); maxY = Math.max(maxY, verts[i + 1]);
    }
  }
  console.log(`${name}: bones=${data.bones.length} slots=${data.slots.length} ik=${data.ikConstraints.length} tf=${data.transformConstraints.length} ph=${data.physicsConstraints.length}`);
  console.log(`${name} BBOX minX=${minX.toFixed(1)} maxX=${maxX.toFixed(1)} minY=${minY.toFixed(1)} maxY=${maxY.toFixed(1)} (w=${(maxX - minX).toFixed(1)} h=${(maxY - minY).toFixed(1)})`);
}
