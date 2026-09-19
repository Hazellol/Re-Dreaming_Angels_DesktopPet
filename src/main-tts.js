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
  downloadUrl: '',                // （旧）手工地址；现优先用下面的 repoUrl 自动拼装
  // ==== 内置下载（用户不再需要手输 URL）====
  repoUrl: 'https://github.com/Hazellol/Re-Dreaming_Angels_DesktopPet',   // 内置仓库地址（用户无需填写）
  runtimeTag: 'tts-runtime-v1',   // 推理环境包 Release tag
  runtimeParts: 6,                // 分卷数量
  voiceTag: 'voices-v1',          // 语音包 Release tag
  mirror: 'official',             // 下载源：official | ghproxy | ghfast | moeyy | llkk | custom
  mirrorCustom: '',               // 自定义镜像前缀（custom 时使用）
  autoModelPath: true,            // 自动随请求指定语音包里的模型权重（保证音色正确）
  logRequests: true,              // 打印合成请求（诊断音色/参数问题）
  saveByRole: false               // true=合成音频按角色分目录保存（文件名含情绪与台词片段，便于整理）
};

function createTtsManager(ctx) {
  const { app, ipcMain, getWin, path: p, fs: f } = ctx;
  const pathMod = p || path;
  const fsMod = f || fs;

  const userData = app.getPath('userData');
  // ===== 数据根目录：**优先项目内**（用户要求"所有功能数据都在项目文件夹里"）=====
  // 项目目录可写 → 用 <项目>/tts；打包版/只读环境（Program Files、asar）→ 回退 userData/tts
  let dataRootCache = null;
  function dataRoot() {
    if (dataRootCache) return dataRootCache;
    const cands = [pathMod.join(__dirname, '..', 'tts'), pathMod.join(process.cwd(), 'tts')];
    for (const c of cands) {
      try {
        fsMod.mkdirSync(c, { recursive: true });
        const probe = pathMod.join(c, '.writetest');
        fsMod.writeFileSync(probe, 'x');
        fsMod.unlinkSync(probe);
        dataRootCache = c;
        return c;
      } catch (e) { /* 试下一个 */ }
    }
    dataRootCache = pathMod.join(userData, 'tts');
    return dataRootCache;
  }
  const legacyTtsDir = pathMod.join(userData, 'tts');   // 旧位置（兼容读取/迁移来源）
  function cfgFile() { return pathMod.join(dataRoot(), 'tts_config.json'); }
  function cacheDirPath() { return pathMod.join(dataRoot(), 'cache'); }
  let cfgPath = pathMod.join(userData, 'tts_config.json');
  let cacheDir = pathMod.join(userData, 'tts_cache');
  let proc = null;               // managed 模式的服务子进程
  let idleTimer = null;
  let lastStatus = { running: false, checkedAt: 0, lastError: '', lastSynthAt: 0 };

  try { fsMod.mkdirSync(cacheDir, { recursive: true }); } catch (e) { /* noop */ }

  function load() {
    // 换到项目内后，配置也搬过去；首次自动从旧位置迁移（保留用户已有设置）
    cfgPath = cfgFile();
    cacheDir = cacheDirPath();
    try { fsMod.mkdirSync(cacheDir, { recursive: true }); } catch (e) { /* noop */ }
    if (!fsMod.existsSync(cfgPath)) {
      const legacyCfg = pathMod.join(legacyTtsDir, 'tts_config.json');
      try { if (fsMod.existsSync(legacyCfg)) fsMod.copyFileSync(legacyCfg, cfgPath); } catch (e) { /* noop */ }
      if (!fsMod.existsSync(cfgPath)) {
        const legacyCfg2 = pathMod.join(userData, 'tts_config.json');
        try { if (fsMod.existsSync(legacyCfg2)) fsMod.copyFileSync(legacyCfg2, cfgPath); } catch (e) { /* noop */ }
      }
    }
    try {
      // 去掉可能的 UTF-8 BOM（用户/脚本手改配置时容易带上，会导致 JSON.parse 失败）
      const raw = fsMod.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '');
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
  } catch (e) { /* noop */ }

  // ---------- 语音包（情绪映射）----------
  function voicesRoot() {
    if (cfg.voicesDir) return cfg.voicesDir;
    // 依次尝试：<数据根>/voices（项目内）→ 旧 userData/tts/voices → 项目 tts_out（兼容手工构建）
    const cands = [
      pathMod.join(dataRoot(), 'voices'),
      pathMod.join(legacyTtsDir, 'voices'),
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
    if (!fsMod.existsSync(cfg.runtimePath)) return { ok: false, error: '运行时不存在：' + cfg.runtimePath };
    if (!fsMod.existsSync(cfg.serverScript)) return { ok: false, error: '服务脚本不存在：' + cfg.serverScript };
    try {
      const args = [pathMod.basename(cfg.serverScript)].concat(Array.isArray(cfg.extraArgs) ? cfg.extraArgs : []);
      // 服务日志写到 <数据根>/logs/server.log（排错用）
      const logDir = pathMod.join(dataRoot(), 'logs');
      try { fsMod.mkdirSync(logDir, { recursive: true }); } catch (e) { /* noop */ }
      const logFile = pathMod.join(logDir, 'server.log');
      const out = fsMod.openSync(logFile, 'a');
      proc = spawn(cfg.runtimePath, args, { cwd: pathMod.dirname(cfg.serverScript), windowsHide: true, stdio: ['ignore', out, out] });
      proc.on('exit', (code) => { console.log('[TTS] service exited', code); proc = null; lastStatus.running = false; broadcast(); });
      console.log('[TTS] service started, device =', cfg.device, 'log =', logFile);
      broadcast();
      return { ok: true, log: logFile };
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
        // 首次启动要加载模型（实测 v2ProPlus 约 90~120 秒）→ 等待上限默认 180 秒，期间状态为"启动中"
        const waitMs = Math.max(30000, (cfg.firstStartWaitSec || 180) * 1000);
        const t0 = Date.now();
        while (Date.now() - t0 < waitMs) {
          await new Promise((r) => setTimeout(r, 1000));
          if (await probe()) break;
        }
      }
      if (!lastStatus.running) return { ok: false, error: lastStatus.lastError ? ('服务不可用：' + lastStatus.lastError) : '服务不可用（启动超时或端口被占用）' };
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
    // 服务状态机：disabled（总开关关）/ running / starting（已拉起进程但还没监听）/ stopped
    const state = !cfg.enabled ? 'disabled' : (lastStatus.running ? 'running' : (proc ? 'starting' : 'stopped'));
    return {
      running: !!lastStatus.running,
      serviceState: state,
      managed: cfg.mode === 'managed',
      enabled: !!cfg.enabled,
      device: cfg.device,
      host: cfg.host,
      port: cfg.port,
      dataRoot: dataRoot(),
      voicesRoot: voicesRoot(),
      hasVoices: ['airui', 'qianxia', 'nangong'].some((r) => !!loadEmotions(r)),
      // 仅在"确实探测失败且未在启动中"时提示错误，避免未运行时一直显示陈旧的连接错误
      lastError: (state === 'stopped' && lastStatus.checkedAt && lastStatus.lastError) ? lastStatus.lastError : '',
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
    // 同样走 Electron net：系统证书 + 自动跟随 302（GitHub Release 会跳到 objects.githubusercontent.com）
    return new Promise((resolve, reject) => {
      netRequest(url, {
        timeoutMs: 3600000,                       // 大文件：给足 1 小时
        headers: { 'User-Agent': 'ReDreamingAngels-DesktopPet' },
        onResponse: (res) => {
          if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode + '（请检查下载源或网络）')); return; }
          const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
          let got = 0;
          let file = null;
          try { file = fsMod.createWriteStream(dest); } catch (e) { reject(e); return; }
          res.on('data', (d) => { got += d.length; if (onProgress) onProgress(got, total); });
          res.on('end', () => { try { file.close(() => resolve({ bytes: got })); } catch (e) { resolve({ bytes: got }); } });
          res.on('error', reject);
          file.on('error', reject);
          res.pipe(file);
        }
      }).catch(reject);
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
  // 关键：把服务推理配置切到 v2ProPlus（包内 custom 段默认为 v2final 底模 → 会导致音色不对！）
  // 用户训练三小只用的是 v2ProPlus，必须让底模与权重匹配。
  function ensureInferConfig(root, device) {
    try {
      const y = pathMod.join(root, 'GPT_SoVITS', 'configs', 'tts_infer.yaml');
      if (!fsMod.existsSync(y)) return false;
      let txt = fsMod.readFileSync(y, 'utf8');
      const isCpu = device === 'cpu';
      const custom = [
        'custom:',
        '  bert_base_path: GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large',
        '  cnhuhbert_base_path: GPT_SoVITS/pretrained_models/chinese-hubert-base',
        '  device: ' + (isCpu ? 'cpu' : 'cuda'),
        '  is_half: ' + (isCpu ? 'false' : 'true'),
        '  t2s_weights_path: GPT_SoVITS/pretrained_models/s1v3.ckpt',
        '  version: v2ProPlus',
        '  vits_weights_path: GPT_SoVITS/pretrained_models/v2Pro/s2Gv2ProPlus.pth',
        ''
      ].join('\n');
      const next = txt.replace(/^custom:[\s\S]*?(?=^v1:)/m, custom);
      if (next === txt) return false;         // 未匹配（结构异常）→ 不动原文件
      fsMod.writeFileSync(y, next, 'utf8');
      console.log('[TTS] inference config switched to v2ProPlus (device=' + (isCpu ? 'cpu' : 'cuda') + ')');
      return true;
    } catch (e) { return false; }
  }

  // ---------- 下载地址构建（内置，用户无需手输）----------
  const MIRRORS = {
    official: '',
    ghproxy: 'https://ghproxy.net/',
    ghfast: 'https://ghfast.top/',
    moeyy: 'https://github.moeyy.xyz/',
    llkk: 'https://gh.llkk.cc/'
  };
  function mirrorPrefix() {
    if (cfg.mirror === 'custom') return cfg.mirrorCustom || '';
    return MIRRORS[cfg.mirror] || '';
  }
  function withMirror(u) { const p = mirrorPrefix(); return p ? (p + u) : u; }
  function repoBase() { return String(cfg.repoUrl || '').replace(/\/+$/, ''); }
  function buildRuntimeUrls() {
    const base = repoBase();
    if (!base) return [];
    const urls = [];
    for (let i = 1; i <= (cfg.runtimeParts || 6); i++) {
      urls.push(withMirror(base + '/releases/download/' + cfg.runtimeTag + '/tts-runtime-part' + i + '.zip'));
    }
    return urls;
  }
  function buildVoiceUrl(role) {
    const base = repoBase();
    if (!base) return '';
    return withMirror(base + '/releases/download/' + cfg.voiceTag + '/tts_voices_' + role + '.zip');
  }
  // 下载并解压一个语音包到 <userData>/tts/voices/<role>/
  async function installVoice(role) {
    const url = buildVoiceUrl(role);
    if (!url) return { ok: false, error: '未配置仓库地址' };
    const root = pathMod.join(dataRoot(), 'voices');       // 项目内 voices 目录
    const zipPath = pathMod.join(dataRoot(), '_voice_' + role + '.zip');
    try { fsMod.mkdirSync(root, { recursive: true }); } catch (e) { /* noop */ }
    try {
      setInstall({ phase: 'download', got: 0, total: 0, message: '语音包[' + role + '] 下载中…' });
      const r = await downloadTo(url, zipPath, (got, total) => {
        setInstall({ phase: 'download', got, total, message: '语音包[' + role + '] ' + (total ? Math.round((got / total) * 100) + '%' : Math.round(got / 1048576) + 'MB') });
      });
      setInstall({ phase: 'extract', got: r.bytes, total: r.bytes, message: '语音包[' + role + '] 解压中…' });
      await expandArchive(zipPath, root);
      try { fsMod.unlinkSync(zipPath); } catch (e) { /* noop */ }
      setInstall({ phase: 'done', message: '语音包[' + role + '] 安装完成' });
      broadcast();
      return { ok: true, role, dir: pathMod.join(root, role) };
    } catch (e) {
      setInstall({ phase: 'error', message: String(e && e.message).slice(0, 200) });
      return { ok: false, error: String(e && e.message) };
    }
  }

  // 支持多个包：GitHub Release 单文件上限 2GB → 运行时常被切成多卷；
  // 多卷依次下载、各自解压到**同一目录**即可还原完整结构。
  function parseUrls(v) {
    if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
    return String(v || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  }
  async function installFromUrl(urlOrUrls) {
    const urls = parseUrls(urlOrUrls);
    if (!urls.length) return { ok: false, error: '未提供下载地址' };
    const root = dataRoot();
    const zipPath = pathMod.join(dataRoot(), '_download.zip');
    try { fsMod.mkdirSync(root, { recursive: true }); } catch (e) { /* noop */ }
    try {
      for (let i = 0; i < urls.length; i++) {
        const tag = urls.length > 1 ? ('第 ' + (i + 1) + '/' + urls.length + ' 包 ') : '';
        setInstall({ phase: 'download', part: i + 1, parts: urls.length, got: 0, total: 0, message: tag + '开始下载…' });
        const r = await downloadTo(urls[i], zipPath, (got, total) => {
          setInstall({ phase: 'download', part: i + 1, parts: urls.length, got, total, message: tag + (total ? Math.round((got / total) * 100) + '%' : Math.round(got / 1048576) + 'MB') });
        });
        setInstall({ phase: 'extract', part: i + 1, parts: urls.length, got: r.bytes, total: r.bytes, message: tag + '解压中…' });
        await expandArchive(zipPath, root);
        try { fsMod.unlinkSync(zipPath); } catch (e) { /* noop */ }
      }
      setInstall({ phase: 'detect', message: '全部解压完成，正在探测运行时…' });
      const det = detectRuntime(root);
      if (!det.python || !det.script) {
        setInstall({ phase: 'error', message: '未找到 python.exe 或 api_v2.py（请确认压缩包内容）' });
        return { ok: false, error: '未找到运行时/脚本', detected: det };
      }
      save({ mode: 'managed', runtimePath: det.python, serverScript: det.script, enabled: true });
      ensureInferConfig(root, cfg.device);      // 切到 v2ProPlus 推理配置（音色正确的前提）
      setInstall({ phase: 'done', message: '安装完成，可直接使用' });
      return { ok: true, runtimePath: det.python, serverScript: det.script };
    } catch (e) {
      setInstall({ phase: 'error', message: String(e && e.message).slice(0, 200) });
      return { ok: false, error: String(e && e.message) };
    }
  }

  // ---------- 网络：统一用 Electron 的 net（Chromium 网络栈 → 默认信任系统证书）----------
  // 背景：Node 自带的 https 使用内置 CA 池；用户环境若装了代理/自签根证书（企业网、加速器），
  //       会报 "unable to verify the first certificate"。改用 net 模块即自动使用系统证书，无需改环境。
  function netRequest(url, { method = 'GET', headers = {}, timeoutMs = 15000, onResponse } = {}) {
    const { net } = require('electron');
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      try {
        const req = net.request({ method, url, redirect: 'follow' });
        for (const [k, v] of Object.entries(headers)) { try { req.setHeader(k, v); } catch (e) { /* noop */ } }
        const timer = setTimeout(() => { try { req.abort(); } catch (e) { /* noop */ } done(reject, new Error('连接超时')); }, timeoutMs);
        req.on('response', (res) => { clearTimeout(timer); if (onResponse) { try { onResponse(res, req); } catch (e) { done(reject, e); } } });
        req.on('error', (e) => { clearTimeout(timer); done(reject, e || new Error('网络错误')); });
        req.end();
      } catch (e) { done(reject, e); }
    });
  }
  function netGetJson(url, timeoutMs) {
    return new Promise((resolve) => {
      netRequest(url, {
        headers: { 'User-Agent': 'ReDreamingAngels-DesktopPet', 'Accept': 'application/vnd.github+json' },
        timeoutMs: timeoutMs || 12000,
        onResponse: (res) => {
          const chunks = [];
          res.on('data', (d) => chunks.push(d));
          res.on('end', () => {
            const txt = Buffer.concat(chunks).toString('utf8');
            try {
              resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: JSON.parse(txt) });
            } catch (e) { resolve({ ok: false, status: res.statusCode, error: 'JSON 解析失败 (HTTP ' + res.statusCode + ')' }); }
          });
          res.on('error', (e) => resolve({ ok: false, error: e && e.message }));
        }
      }).catch((e) => resolve({ ok: false, error: (e && e.message) || '网络错误' }));
    });
  }
  async function checkUpdate() {
    const m = /github\.com\/([^/]+)\/([^/]+)/i.exec(repoBase() || '');
    if (!m) return { ok: false, error: '请先配置 GitHub 仓库地址' };
    const owner = m[1], repo = m[2].replace(/\.git$/i, '');
    const [rel, com] = await Promise.all([
      netGetJson('https://api.github.com/repos/' + owner + '/' + repo + '/releases?per_page=3'),
      netGetJson('https://api.github.com/repos/' + owner + '/' + repo + '/commits?per_page=5')
    ]);
    if (!rel.ok && !com.ok) return { ok: false, error: rel.error || com.error || '查询失败' };
    const releases = (Array.isArray(rel.json) ? rel.json : []).map((r) => ({
      tag: r.tag_name, name: r.name, body: (r.body || '').slice(0, 2000), publishedAt: r.published_at, url: r.html_url
    }));
    const commits = (Array.isArray(com.json) ? com.json : []).map((c) => ({
      sha: (c.sha || '').slice(0, 7), message: (c.commit && c.commit.message || '').split('\n')[0].slice(0, 120),
      date: c.commit && c.commit.author && c.commit.author.date, url: c.html_url
    }));
    return { ok: true, local: app.getVersion(), releases, commits, repoUrl: repoBase() };
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
    ipcMain.handle('tts-install', (e, url) => installFromUrl(url || buildRuntimeUrls()));
    ipcMain.handle('tts-install-runtime', () => installFromUrl(buildRuntimeUrls()));
    ipcMain.handle('tts-install-voice', (e, role) => installVoice(String(role || '')));
    ipcMain.handle('tts-urls', () => ({ runtime: buildRuntimeUrls(), voices: { airui: buildVoiceUrl('airui'), qianxia: buildVoiceUrl('qianxia'), nangong: buildVoiceUrl('nangong') } }));
    ipcMain.handle('tts-check-update', () => checkUpdate());
    ipcMain.handle('open-external', (e, url) => { try { require('electron').shell.openExternal(String(url || '')); return { ok: true }; } catch (err) { return { ok: false, error: err && err.message }; } });
    ipcMain.handle('tts-install-state', () => installState);
    ipcMain.handle('tts-open-cache', () => {
      try { require('electron').shell.openPath(cacheDir); return { ok: true, dir: cacheDir }; } catch (e) { return { ok: false, error: e && e.message }; }
    });
  }

  return { register, synthesize, status, probe, startService, stopService, save, config: () => cfg, voicesRoot, dataRoot, cacheDir: () => cacheDir, installFromUrl, installState: () => installState, checkUpdate };
}

module.exports = { createTtsManager, DEFAULT_CONFIG };
