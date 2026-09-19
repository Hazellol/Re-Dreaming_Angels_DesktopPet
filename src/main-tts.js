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
  voicesDir: '',                  // 语音包目录（emotions.json + 参考音频）；留空则用默认位置
  downloadUrl: '',                // 便携包下载地址（「桌宠启动」模式的一键下载）
  autoModelPath: true,            // 自动随请求指定语音包里的模型权重（保证音色正确）
  logRequests: true,              // 打印合成请求（诊断音色/参数问题）
  saveByRole: false,              // true=合成音频按角色分目录保存（文件名含情绪与台词片段，便于整理）
  // 参考音频选择策略（GPT-SoVITS 是 zero-shot：参考音频直接决定音色细节）
  //   random = 按情绪从语音包随机挑（默认，语气更丰富）
  //   fixed  = 固定使用指定参考（可与云端 WebUI 完全一致 → 便于 A/B 对比音色）
  refStrategy: 'random',
  refFixed: '',                   // refStrategy=fixed 时的参考音频文件名（如 Level_..._74490001.wav）
  refFixedText: ''                // 固定参考时对应的参考文本（留空则从 emotions.json 里查）
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
    if (process.env.QX_TTS_BYROLE === '1') cfg.saveByRole = true;
    if (process.env.QX_TTS_BYROLE === '0') cfg.saveByRole = false;
    if (process.env.QX_TTS_REF) { cfg.refStrategy = 'fixed'; cfg.refFixed = process.env.QX_TTS_REF; }
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
    const base = pathMod.join(voicesRoot(), role);
    const resolve = (name) => {
      const n = pathMod.basename(name);
      const cands = [pathMod.join(base, 'refs', n), pathMod.join(base, n)];
      for (const c of cands) { try { if (fsMod.existsSync(c)) return c; } catch (e) { /* noop */ } }
      return null;
    };
    // 固定参考策略：与云端 WebUI 用同一条参考 → 音色可直接对比
    if (cfg.refStrategy === 'fixed' && cfg.refFixed) {
      const audio = resolve(cfg.refFixed);
      if (audio) {
        let text = cfg.refFixedText || '';
        if (!text) {
          for (const list of Object.values(emo.map)) {
            const hit = (list || []).find((it) => pathMod.basename(it.ref) === pathMod.basename(cfg.refFixed));
            if (hit) { text = hit.text || ''; break; }
          }
        }
        return { audio, text };
      }
    }
    const list = emo.map[mood] || emo.map[emo.default || 'neutral'];
    if (!list || !list.length) return null;
    const pick = list[Math.floor(Math.random() * list.length)];
    const audio = resolve(pick.ref);
    if (!audio) return null;
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

  // 文本清洗：去掉"（动作描述）/(动作)/【旁白】/*动作*"等舞台指示——只朗读真正的台词
  // （用户实测：聊天台词里的括号动作被一起念出来了）
  function stripActionText(text) {
    return String(text || '')
      .replace(/（[^）]*）/g, '')
      .replace(/\([^)]*\)/g, '')
      .replace(/【[^】]*】/g, '')
      .replace(/\[[^\]]*\]/g, '')
      .replace(/\*[^*]*\*/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  // ---------- 缓存路径（可选：按角色分目录 + 可读文件名）----------
  function safeName(s, max) {
    return String(s || '').replace(/[\\/:*?"<>|\r\n\t]+/g, '').replace(/\s+/g, '').slice(0, max || 12);
  }
  function cacheTarget(role, mood, text, key) {
    if (!cfg.saveByRole) {
      return { dir: cacheDir, file: pathMod.join(cacheDir, key + '.wav'), prefix: null };
    }
    const dir = pathMod.join(cacheDir, role);
    try { fsMod.mkdirSync(dir, { recursive: true }); } catch (e) { /* noop */ }
    const prefix = key.slice(0, 8) + '_';
    return {
      dir,
      // 形如 qianxia/a1b2c3d4_happy_你好呀今天也要开心.wav —— 便于人工试听与整理
      file: pathMod.join(dir, prefix + mood + '_' + (safeName(text, 12) || 'audio') + '.wav'),
      prefix
    };
  }
  function findCached(t) {
    try {
      if (!t.prefix) {
        return (fsMod.existsSync(t.file) && fsMod.statSync(t.file).size > 512) ? t.file : null;
      }
      const files = fsMod.readdirSync(t.dir);
      const hit = files.find((f) => f.startsWith(t.prefix) && /\.wav$/i.test(f));
      if (!hit) return null;
      const full = pathMod.join(t.dir, hit);
      return (fsMod.statSync(full).size > 512) ? full : null;
    } catch (e) { return null; }
  }

  // ---------- 合成 ----------
  async function synthesize({ role, text, mood }) {
    if (!cfg.enabled) return { ok: false, error: 'disabled' };
    const clean = stripActionText(text);
    if (!clean) return { ok: false, error: 'empty text (after strip)' };
    const ref = pickReference(role, mood || 'neutral');
    if (!ref) return { ok: false, error: 'no voice pack (emotions.json) for ' + role };

    // 缓存命中
    const key = crypto.createHash('sha1').update([role, mood || 'neutral', clean, cfg.device].join('|')).digest('hex').slice(0, 20);
    const asUrl = (p2) => 'pet://tts/' + (cfg.saveByRole ? (role + '/') : '') + pathMod.basename(p2);
    const target = cacheTarget(role, mood || 'neutral', clean, key);
    const hit = findCached(target);
    if (hit) return { ok: true, file: hit, url: asUrl(hit), cached: true };
    const cacheFile = target.file;

    if (!(await probe())) {
      if (cfg.mode === 'managed') {
        const s = startService();
        if (!s.ok) {
          // 友好提示：区分"便携包还没下载/未配置"与"启动失败"
          const tip = (!cfg.runtimePath || !cfg.serverScript)
            ? '未安装便携包：请在「桌宠启动」模式点「⬇ 一键下载并自动集成」，或切到「已有服务」并先启动 GPT-SoVITS'
            : ('服务启动失败：' + (s.error || ''));
          return { ok: false, error: tip };
        }
        for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 500)); if (await probe()) break; }
      }
      if (!lastStatus.running) return { ok: false, error: lastStatus.lastError ? ('服务不可用：' + lastStatus.lastError) : '服务不可用（未启动或端口不对）' };
    }

    // 组装请求（模板化，适配不同版本）
    const body = Object.assign({}, cfg.params, cfg.extraBody);
    body.text = clean;
    body[cfg.refFields.audio] = ref.audio;
    body[cfg.refFields.text] = ref.text;
    // ★ 音色正确性的关键：v2ProPlus 等版本必须用**该角色的训练权重**推理。
    //   若语音包里带了 models/（*.ckpt + *.pth），自动随请求指定 gpt_path / sovits_path，
    //   避免"本地服务默认加载了别的模型 → 音色不像"（用户实测问题）。
    if (cfg.autoModelPath !== false) {
      try {
        const mdir = pathMod.join(voicesRoot(), role, 'models');
        if (fsMod.existsSync(mdir)) {
          const files = fsMod.readdirSync(mdir);
          const gptFile = files.find((f) => /\.ckpt$/i.test(f));
          const sovFile = files.find((f) => /\.pth$/i.test(f));
          if (gptFile && !body.gpt_path) body.gpt_path = pathMod.join(mdir, gptFile);
          if (sovFile && !body.sovits_path) body.sovits_path = pathMod.join(mdir, sovFile);
        }
      } catch (e) { /* noop */ }
    }
    let pathName = cfg.apiPath || '/tts';
    if (cfg.refMode === 'query') {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) q.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      pathName += '?' + q.toString();
    }
    if (cfg.logRequests !== false) {
      console.log('[TTS] request →', pathName, JSON.stringify({
        text: body.text, ref: pathMod.basename(body[cfg.refFields.audio] || ''),
        prompt: body[cfg.refFields.text], gpt_path: body.gpt_path ? pathMod.basename(body.gpt_path) : undefined,
        sovits_path: body.sovits_path ? pathMod.basename(body.sovits_path) : undefined,
        device: cfg.device, mood: mood || 'neutral'
      }));
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

  // ---------- 一键下载并自动集成（便携运行时 / 语音包）----------
  // 用户点一下：下载 → 解压 → 自动探测 python 与 api_v2.py → 写配置 → 可直接用
  let installState = { phase: 'idle', got: 0, total: 0, message: '' };
  function setInstall(patch) {
    installState = Object.assign({}, installState, patch, { at: Date.now() });
    try {
      const w = getWin && getWin();
      if (w && !w.isDestroyed() && w.webContents) w.webContents.send('tts-install-progress', installState);
    } catch (e) { /* noop */ }
  }
  function downloadTo(url, dest, onProgress) {
    return new Promise((resolve, reject) => {
      const isHttps = /^https:/i.test(url);
      const mod = isHttps ? require('https') : require('http');
      const file = fsMod.createWriteStream(dest);
      const req = mod.get(url, { timeout: 60000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          return downloadTo(res.headers.location, dest, onProgress).then(resolve, reject);
        }
        if (res.statusCode !== 200) { file.close(); return reject(new Error('HTTP ' + res.statusCode)); }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let got = 0;
        res.on('data', (d) => { got += d.length; if (onProgress) onProgress(got, total); });
        res.on('error', reject);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve({ bytes: got })));
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('download timeout')); });
      req.on('error', reject);
    });
  }
  function expandArchive(zipPath, outDir) {
    return new Promise((resolve, reject) => {
      const { execFile } = require('child_process');
      const esc = (s) => String(s).replace(/'/g, "''");
      const cmd = "Expand-Archive -LiteralPath '" + esc(zipPath) + "' -DestinationPath '" + esc(outDir) + "' -Force";
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
        { timeout: 1800000, windowsHide: true }, (err, so, se) => err ? reject(new Error(String(se || err.message).slice(0, 300))) : resolve());
    });
  }
  // 递归探测：python.exe 与服务脚本（api_v2.py / api.py / server.py）
  function detectRuntime(root) {
    const found = { python: '', script: '' };
    const walk = (dir, depth) => {
      if (depth > 4 || (found.python && found.script)) return;
      let items = [];
      try { items = fsMod.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const it of items) {
        const full = pathMod.join(dir, it.name);
        if (it.isDirectory()) { walk(full, depth + 1); continue; }
        const n = it.name.toLowerCase();
        if (!found.python && n === 'python.exe') found.python = full;
        if (!found.script && (n === 'api_v2.py' || n === 'server.py' || n === 'api.py')) found.script = full;
      }
    };
    walk(root, 0);
    return found;
  }
  async function installFromUrl(url) {
    if (!url) return { ok: false, error: '未提供下载地址' };
    const root = pathMod.join(userData, 'tts');
    const zipPath = pathMod.join(root, '_download.zip');
    try { fsMod.mkdirSync(root, { recursive: true }); } catch (e) { /* noop */ }
    try {
      setInstall({ phase: 'download', got: 0, total: 0, message: '开始下载…' });
      const r = await downloadTo(url, zipPath, (got, total) => {
        setInstall({ phase: 'download', got, total, message: '下载中 ' + (total ? Math.round((got / total) * 100) + '%' : Math.round(got / 1048576) + 'MB') });
      });
      setInstall({ phase: 'extract', got: r.bytes, total: r.bytes, message: '下载完成，正在解压…' });
      await expandArchive(zipPath, root);
      setInstall({ phase: 'detect', message: '解压完成，正在探测运行时…' });
      const det = detectRuntime(root);
      if (!det.python || !det.script) {
        setInstall({ phase: 'error', message: '未找到 python.exe 或 api_v2.py（请确认压缩包结构）' });
        return { ok: false, error: '未找到运行时/脚本', detected: det };
      }
      save({ mode: 'managed', runtimePath: det.python, serverScript: det.script, enabled: true });
      setInstall({ phase: 'done', message: '安装完成，可直接使用' });
      try { fsMod.unlinkSync(zipPath); } catch (e) { /* noop */ }
      return { ok: true, runtimePath: det.python, serverScript: det.script };
    } catch (e) {
      setInstall({ phase: 'error', message: String(e && e.message).slice(0, 200) });
      return { ok: false, error: String(e && e.message) };
    }
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
    ipcMain.handle('tts-install', (e, url) => installFromUrl(url || cfg.downloadUrl || ''));
    ipcMain.handle('tts-install-state', () => installState);
    ipcMain.handle('tts-open-cache', () => {
      try { require('electron').shell.openPath(cacheDir); return { ok: true, dir: cacheDir }; } catch (e) { return { ok: false, error: e && e.message }; }
    });
  }

  return { register, synthesize, status, probe, startService, stopService, save, config: () => cfg, voicesRoot, installFromUrl, installState: () => installState };
}

module.exports = { createTtsManager, DEFAULT_CONFIG };
