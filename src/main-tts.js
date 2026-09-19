// TTS 管理器（主进程模块）：对接本地 GPT-SoVITS 服务，负责探活 / 合成 / 缓存 / 空闲卸载 / 降级
// 设计原则：
//   · 桌宠侧只关心 { role, text, mood } —— 参考音频选择与情绪映射都在这里完成
//   · **接口与参数做成可配置模板** → 不同 GPT-SoVITS 版本（api.py / api_v2.py / 自研服务）都能适配
//   · 服务未安装/未启动/合成失败 → 一律**静默降级**（聊天功能完全不受影响）
//   · 默认关闭（用户必须在控制台主动开启）
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DEFAULT_CONFIG = {
  enabled: false,                 // 总开关（默认关：用户自行开启）
  mode: 'external',               // external=用已在运行的服务；managed=由桌宠启动（便携包）
  host: '127.0.0.1',
  port: 9880,
  device: 'cuda',                 // cuda | cpu（GPU/CPU 可选）
  runtimePath: '',                // managed：python.exe 路径（便携运行时）
  serverScript: '',               // managed：服务脚本路径
  extraArgs: [],                  // managed：额外启动参数
  apiPath: '/tts',                // 合成接口路径（api_v2 默认 /tts）
  healthPath: '/health',          // 探活路径（失败时回退 TCP 探测）
  params: {                       // 请求参数模板（可覆盖 → 适配不同版本）
    text_lang: 'zh',
    prompt_lang: 'zh',
    text_split_method: 'cut5',
    media_type: 'wav',
    streaming_mode: false
  },
  extraBody: {},                  // 追加到请求体的自定义字段（如 v2ProPlus 需要的权重路径参数）
  refMode: 'body',                // body=参考音频作为 JSON 字段；query=作为 URL 查询参数
  refFields: { audio: 'ref_audio_path', text: 'prompt_text' },
  idleUnloadSec: 300,             // 空闲多久后停止 managed 服务（释放显存/内存）
  speakOn: { chat: true, bubble: false, chatter: false },   // 对哪些内容说话
  volume: 100,
  voicesDir: ''                   // 语音包目录（emotions.json + 参考音频）；留空则用默认位置
};

function createTtsManager(ctx) {
  const { app, ipcMain, getWin, path: p, fs: f } = ctx;
  const pathMod = p || path;
  const fsMod = f || fs;

  const userData = app.getPath('userData');
  const cfgPath = pathMod.join(userData, 'tts_config.json');
  const cacheDir = pathMod.join(userData, 'tts_cache');
  let cfg = Object.assign({}, DEFAULT_CONFIG);
  let proc = null;               // managed 模式的服务子进程
  let idleTimer = null;
  let lastStatus = { running: false, checkedAt: 0, lastError: '', lastSynthAt: 0 };

  try { fsMod.mkdirSync(cacheDir, { recursive: true }); } catch (e) { /* noop */ }

  function load() {
    try {
      const raw = fsMod.readFileSync(cfgPath, 'utf8');
      cfg = Object.assign({}, DEFAULT_CONFIG, JSON.parse(raw));
      cfg.params = Object.assign({}, DEFAULT_CONFIG.params, cfg.params || {});
      cfg.speakOn = Object.assign({}, DEFAULT_CONFIG.speakOn, cfg.speakOn || {});
      cfg.refFields = Object.assign({}, DEFAULT_CONFIG.refFields, cfg.refFields || {});
    } catch (e) { cfg = Object.assign({}, DEFAULT_CONFIG); }
    return cfg;
  }
  function save(patch) {
    cfg = Object.assign({}, cfg, patch || {});
    try { fsMod.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8'); } catch (e) { /* noop */ }
    return cfg;
  }
  load();
  // 调试/自动化：环境变量覆盖（QX_TTS_ENABLED/PORT/HOST/MODE/DEVICE/VOICES）
  try {
    if (process.env.QX_TTS_ENABLED === '1') cfg.enabled = true;
    if (process.env.QX_TTS_PORT) cfg.port = parseInt(process.env.QX_TTS_PORT, 10) || cfg.port;
    if (process.env.QX_TTS_HOST) cfg.host = process.env.QX_TTS_HOST;
    if (process.env.QX_TTS_MODE) cfg.mode = process.env.QX_TTS_MODE;
    if (process.env.QX_TTS_DEVICE) cfg.device = process.env.QX_TTS_DEVICE;
    if (process.env.QX_TTS_VOICES) cfg.voicesDir = process.env.QX_TTS_VOICES;
  } catch (e) { /* noop */ }

  // ---------- 语音包（情绪映射）----------
  function voicesRoot() {
    if (cfg.voicesDir) return cfg.voicesDir;
    // 依次尝试：用户数据目录 → 项目 tts_out
    const cands = [
      pathMod.join(userData, 'tts', 'voices'),
      pathMod.join(__dirname, '..', 'tts_out')
    ];
    for (const c of cands) { try { if (fsMod.existsSync(c)) return c; } catch (e) { /* noop */ } }
    return cands[0];
  }
  function loadEmotions(role) {
    const file = pathMod.join(voicesRoot(), role, 'emotions.json');
    try { return JSON.parse(fsMod.readFileSync(file, 'utf8')); } catch (e) { return null; }
  }
  function pickReference(role, mood) {
    const emo = loadEmotions(role);
    if (!emo || !emo.map) return null;
    const list = emo.map[mood] || emo.map[emo.default || 'neutral'];
    if (!list || !list.length) return null;
    const pick = list[Math.floor(Math.random() * list.length)];
    const base = pathMod.join(voicesRoot(), role);
    const name = pathMod.basename(pick.ref);
    // 语音包结构：<voices>/<role>/refs/<file>；兼容扁平放置
    const cands = [pathMod.join(base, 'refs', name), pathMod.join(base, name)];
    let audio = cands[0];
    for (const c of cands) { try { if (fsMod.existsSync(c)) { audio = c; break; } } catch (e) { /* noop */ } }
    return { audio, text: pick.text || '' };
  }

  // ---------- 服务探活 / 启停 ----------
  function httpJsonOnce({ method, host, port, pathName, timeoutMs, body }) {
    return new Promise((resolve) => {
      const data = body ? JSON.stringify(body) : null;
      const req = http.request({
        method, host, port, path: pathName, timeout: timeoutMs || 4000,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
      }, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, buf: Buffer.concat(chunks) }));
      });
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timeout' }); });
      req.on('error', (e) => resolve({ ok: false, status: 0, error: e && e.message }));
      if (data) req.write(data);
      req.end();
    });
  }
  async function probe() {
    const r = await httpJsonOnce({ method: 'GET', host: cfg.host, port: cfg.port, pathName: cfg.healthPath || '/health', timeoutMs: 1500 });
    // 有些版本没有 /health → 404 也算"服务在跑"
    const running = r.ok || r.status === 404 || r.status === 405;
    lastStatus = { running, checkedAt: Date.now(), lastError: running ? '' : (r.error || ('HTTP ' + r.status)), lastSynthAt: lastStatus.lastSynthAt };
    broadcast();
    return running;
  }
  function startService() {
    if (cfg.mode !== 'managed') return { ok: false, error: '当前为 external 模式（请在外部先启动 GPT-SoVITS 服务）' };
    if (proc && !proc.killed) return { ok: true, already: true };
    if (!cfg.runtimePath || !cfg.serverScript) return { ok: false, error: '未配置运行时与脚本路径（便携包）' };
    try {
      const args = [cfg.serverScript].concat(Array.isArray(cfg.extraArgs) ? cfg.extraArgs : []);
      proc = spawn(cfg.runtimePath, args, { cwd: pathMod.dirname(cfg.serverScript), windowsHide: true, stdio: 'ignore' });
      proc.on('exit', (code) => { console.log('[TTS] service exited', code); proc = null; });
      console.log('[TTS] service started, device =', cfg.device);
      return { ok: true };
    } catch (e) { return { ok: false, error: e && e.message }; }
  }
  function stopService(reason) {
    try { if (proc && !proc.killed) { proc.kill(); } } catch (e) { /* noop */ }
    proc = null;
    if (reason) console.log('[TTS] service stopped:', reason);
    broadcast();
    return { ok: true };
  }
  function touchIdle() {
    lastStatus.lastSynthAt = Date.now();
    if (idleTimer) clearInterval(idleTimer);
    if (!cfg.enabled || cfg.mode !== 'managed') return;
    idleTimer = setInterval(() => {
      const idle = (Date.now() - (lastStatus.lastSynthAt || 0)) / 1000;
      if (idle > (cfg.idleUnloadSec || 300)) {
        clearInterval(idleTimer); idleTimer = null;
        stopService('idle unload (' + Math.round(idle) + 's)');
      }
    }, 30000);
  }

  // ---------- 合成 ----------
  async function synthesize({ role, text, mood }) {
    if (!cfg.enabled) return { ok: false, error: 'disabled' };
    const clean = String(text || '').trim();
    if (!clean) return { ok: false, error: 'empty text' };
    const ref = pickReference(role, mood || 'neutral');
    if (!ref) return { ok: false, error: 'no voice pack (emotions.json) for ' + role };

    // 缓存命中
    const key = crypto.createHash('sha1').update([role, mood || 'neutral', clean, cfg.device].join('|')).digest('hex').slice(0, 20);
    const cacheFile = pathMod.join(cacheDir, key + '.wav');
    const asUrl = (p2) => 'pet://tts/' + pathMod.basename(p2);
    try { if (fsMod.existsSync(cacheFile) && fsMod.statSync(cacheFile).size > 512) return { ok: true, file: cacheFile, url: asUrl(cacheFile), cached: true }; } catch (e) { /* noop */ }

    if (!(await probe())) {
      if (cfg.mode === 'managed') {
        const s = startService();
        if (!s.ok) return { ok: false, error: s.error };
        for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 500)); if (await probe()) break; }
      }
      if (!lastStatus.running) return { ok: false, error: lastStatus.lastError || 'service not running' };
    }

    // 组装请求（模板化，适配不同版本）
    const body = Object.assign({}, cfg.params, cfg.extraBody);
    body.text = clean;
    body[cfg.refFields.audio] = ref.audio;
    body[cfg.refFields.text] = ref.text;
    let pathName = cfg.apiPath || '/tts';
    if (cfg.refMode === 'query') {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) q.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      pathName += '?' + q.toString();
    }
    const r = await httpJsonOnce({ method: 'POST', host: cfg.host, port: cfg.port, pathName, timeoutMs: 120000, body: cfg.refMode === 'query' ? undefined : body });
    touchIdle();
    if (!r.ok || !r.buf || r.buf.length < 512) {
      return { ok: false, error: r.error || ('HTTP ' + r.status + (r.buf ? ' ' + r.buf.toString('utf8').slice(0, 200) : '')) };
    }
    try { fsMod.writeFileSync(cacheFile, r.buf); } catch (e) { /* noop */ }
    return { ok: true, file: cacheFile, url: asUrl(cacheFile), bytes: r.buf.length };
  }

  function broadcast() {
    try {
      const w = getWin && getWin();
      if (w && !w.isDestroyed() && w.webContents) w.webContents.send('tts-status', status());
    } catch (e) { /* noop */ }
  }
  function status() {
    return {
      running: !!lastStatus.running,
      managed: cfg.mode === 'managed',
      enabled: !!cfg.enabled,
      device: cfg.device,
      host: cfg.host,
      port: cfg.port,
      voicesRoot: voicesRoot(),
      hasVoices: ['airui', 'qianxia', 'nangong'].some((r) => !!loadEmotions(r)),
      lastError: lastStatus.lastError || '',
      config: cfg
    };
  }

  // ---------- IPC ----------
  function register() {
    ipcMain.handle('tts-status', () => status());
    ipcMain.handle('tts-config', (e, patch) => { save(patch); if (patch && patch.enabled === false) stopService('disabled'); return status(); });
    ipcMain.handle('tts-probe', () => probe());
    ipcMain.handle('tts-start', () => startService());
    ipcMain.handle('tts-stop', () => stopService('manual'));
    ipcMain.handle('tts-speak', (e, payload) => synthesize(payload || {}));
    ipcMain.handle('tts-emotions', (e, role) => loadEmotions(role));
  }

  return { register, synthesize, status, probe, startService, stopService, save, config: () => cfg, voicesRoot };
}

module.exports = { createTtsManager, DEFAULT_CONFIG };
