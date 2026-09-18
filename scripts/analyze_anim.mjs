// 动画日志分析工具：统计三只的动画切换序列与每段时长（诊断"姿势被瞬间重置/动画停摆"）
// 用法：node scripts/analyze_anim.mjs <日志文件>   （日志由 QX_ANIMLOG=1 生成，含 [ANIM] 行）
import fs from 'node:fs';

const file = process.argv[2] || 'anim.log';
const raw = fs.readFileSync(file, 'latin1').split(/\r?\n/);
const lines = raw.filter((l) => l.includes('[ANIM]'));
if (!lines.length) { console.log('未找到 [ANIM] 行（需要 QX_ANIMLOG=1 运行）'); process.exit(0); }

const keys = ['ar', 'qx', 'ng'];
const st = {};
let t = 0;
for (const line of lines) {
  t++;
  for (const tok of line.split(/\s+/)) {
    for (const k of keys) {
      if (!tok.startsWith(k + '=')) continue;
      const body = tok.slice(k.length + 1);          // 形如 待机@1.0(p0)
      const nm = body.split('@')[0];
      const pos = (body.match(/\(p(\d+)\)/) || [])[1] || '?';
      if (!st[k]) { st[k] = { cur: nm, curPos: pos, start: t, segs: [] }; continue; }
      if (st[k].cur !== nm) {
        st[k].segs.push({ n: st[k].cur, p: st[k].curPos, d: t - st[k].start });
        st[k] = { cur: nm, curPos: pos, start: t, segs: st[k].segs };
      } else { st[k].curPos = pos; }
    }
  }
}
for (const k of keys) if (st[k]) st[k].segs.push({ n: st[k].cur, p: st[k].curPos, d: t + 1 - st[k].start });

console.log('总时长: ' + t + ' 秒   动画行数: ' + lines.length);
for (const k of keys) {
  const s = st[k]; if (!s) continue;
  const segs = s.segs;
  const durs = segs.map((x) => x.d);
  const short = segs.filter((x) => x.d < 1);
  console.log('\n--- ' + k + ' ---');
  console.log('  切换次数: ' + (segs.length - 1) + '   段数: ' + segs.length);
  console.log('  每段时长(秒): ' + durs.join(', '));
  console.log('  最短 ' + Math.min(...durs) + 's | 最长 ' + Math.max(...durs) + 's | 平均 ' + (durs.reduce((a, b) => a + b, 0) / durs.length).toFixed(1) + 's');
  console.log('  异常短段(<1s): ' + (short.length ? short.length + ' 个 → ' + short.map((x) => x.d + 's').join(',') : '无 ✓'));
  console.log('  序列: ' + segs.map((x) => x.n + '(p' + x.p + ')' + x.d + 's').join(' → '));
}
