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

const ROLE_KEYS = ['airui', 'qianxia', 'nangong'];

const DEFAULT_CONFIG = {  enabled: false,                 // 总开关（默认关：用户自行开启）
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
  // ===== 数据根目录（确定性规则）=====
  //   · 源码运行（npm start / 一键启动 vbs）→ <项目>/tts          —— 便于查看与管理
  //   · 打包版（便携版/安装版）           → %APPDATA%/<产品名>/tts —— 项目目录在 asar 内只读
  // 不使用 process.cwd()：便携版双击时工作目录不可控（可能是 exe 目录、桌面或 System32），
  // 会导致"已安装却检测不到"以及数据位置漂移。
  let dataRootCache = null;
  function dataRoot() {
    if (dataRootCache) return dataRootCache;
    const userDir = pathMod.join(userData, 'tts');
    if (app.isPackaged) {                    // 打包版：固定用户数据目录
      try { fsMod.mkdirSync(userDir, { recursive: true }); } catch (e) { /* noop */ }
      dataRootCache = userDir;
      return dataRootCache;
    }
    const projDir = pathMod.join(__dirname, '..', 'tts');   // 源码版：项目目录
    const cands = [projDir];
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
    dataRootCache = userDir;
    return dataRootCache;
  }
  const legacyTtsDir = pathMod.join(userData, 'tts');   // 打包版数据目录（同时作为源码版的历史兼容位置）
  function cfgFile() { return pathMod.join(dataRoot(), 'tts_config.json'); }
  function cacheDirPath() { return pathMod.join(dataRoot(), 'cache'); }
  // ===== 后台日志（<数据根>/logs/app.log，1MB 轮转；控制台可查看）=====
  const LOG_MAX = 1024 * 1024;
  function logDirPath() { return pathMod.join(dataRoot(), 'logs'); }
  function logFilePath() { return pathMod.join(logDirPath(), 'app.log'); }
  function logLine(level, msg) {
    const line = '[' + new Date().toISOString().replace('T', ' ').slice(0, 19) + '] [' + level + '] ' + msg + '\n';
    try {
      fsMod.mkdirSync(logDirPath(), { recursive: true });
      const f = logFilePath();
      try { if (fsMod.statSync(f).size > LOG_MAX) fsMod.renameSync(f, pathMod.join(logDirPath(), 'app.old.log')); } catch (e) { /* noop */ }
      fsMod.appendFileSync(f, line, 'utf8');
    } catch (e) { /* noop */ }
    if (level !== 'DEBUG') console.log('[TTS][' + level + ']', msg);
  }
  function readLogs(maxLines) {
    try {
      const f = logFilePath();
      if (!fsMod.existsSync(f)) return '(暂无日志)';
      const lines = fsMod.readFileSync(f, 'utf8').replace(/\r/g, '').split('\n');
      return lines.slice(-(maxLines || 300)).join('\n').trim() || '(暂无日志)';
    } catch (e) { return '(读取失败: ' + (e && e.message) + ')'; }
  }
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
  // 启动自检日志（用户点「📜 后台日志」立即能看到环境概况）
  try {
    logLine('INFO', 'TTS 管理器就绪（enabled=' + cfg.enabled + ', device=' + cfg.device + ', mirror=' + cfg.mirror + '）');
    logLine('INFO', '数据目录：' + dataRoot());
    logLine('INFO', '安装状态：推理环境=' + (isRuntimeInstalled() ? '已安装' : '未安装') +
      '；语音包 ' + ['airui', 'qianxia', 'nangong'].map((r) => r + '=' + (isVoiceInstalled(r) ? '✓' : '✗')).join(' '));
  } catch (e) { /* noop */ }
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
  function voicesCandidates() {
    const list = [];
    if (cfg.voicesDir) list.push(cfg.voicesDir);
    list.push(pathMod.join(dataRoot(), 'voices'));
    if (legacyTtsDir !== dataRoot()) list.push(pathMod.join(legacyTtsDir, 'voices'));
    if (!app.isPackaged) list.push(pathMod.join(__dirname, '..', 'tts_out'));   // 源码版兼容手工构建的语音包
    return list.filter(Boolean);
  }
  // 某角色的语音包目录（含 emotions.json 的那个候选目录）
  function voiceDirFor(role) {
    for (const c of voicesCandidates()) {
      try { if (fsMod.existsSync(pathMod.join(c, role, 'emotions.json'))) return c; } catch (e) { /* noop */ }
    }
    return voicesCandidates()[0];
  }
  function voicesRoot() {
    // 优先返回"确实含语音包"的目录（避免空目录抢先，导致找不到情绪映射）
    for (const c of voicesCandidates()) {
      try {
        if (!fsMod.existsSync(c)) continue;
        if (ROLE_KEYS.some((r) => fsMod.existsSync(pathMod.join(c, r, 'emotions.json')))) return c;
      } catch (e) { /* noop */ }
    }
    for (const c of voicesCandidates()) { try { if (fsMod.existsSync(c)) return c; } catch (e) { /* noop */ } }
    return voicesCandidates()[0];
  }
  function loadEmotions(role) {
    for (const c of voicesCandidates()) {
      const file = pathMod.join(c, role, 'emotions.json');
      try {
        if (fsMod.existsSync(file)) return JSON.parse(fsMod.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      } catch (e) { /* 试下一个候选 */ }
    }
    return null;
  }
  function pickReference(role, mood) {
    const emo = loadEmotions(role);
    if (!emo || !emo.map) return null;
    const list = emo.map[mood] || emo.map[emo.default || 'neutral'];
    if (!list || !list.length) return null;
    const pick = list[Math.floor(Math.random() * list.length)];
    const base = pathMod.join(voiceDirFor(role), role);
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
  let probeFailCount = 0;   // 抖动抑制：服务忙（加载/合成）时探活可能超时，连续多次失败才判定"未运行"
  async function probe() {
    const r = await httpJsonOnce({ method: 'GET', host: cfg.host, port: cfg.port, pathName: cfg.healthPath || '/health', timeoutMs: 3000 });
    // 有些版本没有 /health → 404 也算"服务在跑"
    const okNow = r.ok || r.status === 404 || r.status === 405;
    if (okNow) probeFailCount = 0; else probeFailCount++;
    // 已判定运行中的服务：容忍连续 3 次失败（避免状态反复横跳）；已停止的：1 次成功即恢复
    const running = okNow || (lastStatus.running && probeFailCount < 3);
    const changed = running !== lastStatus.running;
    lastStatus = { running, checkedAt: Date.now(), lastError: running ? '' : (r.error || ('HTTP ' + r.status)), lastSynthAt: lastStatus.lastSynthAt };
    if (changed) logLine('INFO', '服务状态变化 → ' + (running ? '运行中 (' + cfg.host + ':' + cfg.port + ')' : '未运行' + (lastStatus.lastError ? '（' + lastStatus.lastError + '）' : '')));
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
      proc.on('exit', (code) => { logLine('INFO', '服务进程退出（code=' + code + '）'); proc = null; lastStatus.running = false; broadcast(); });
      logLine('INFO', '已启动服务：' + cfg.runtimePath + ' ' + args.join(' ') + '（device=' + cfg.device + '，日志 ' + logFile + '）');
      broadcast();
      return { ok: true, log: logFile };
    } catch (e) { return { ok: false, error: e && e.message }; }
  }
  function stopService(reason) {
    try { if (proc && !proc.killed) { proc.kill(); } } catch (e) { /* noop */ }
    proc = null;
    if (reason) { logLine('INFO', '已停止服务：' + reason); }
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
    if (hit) { logLine('DEBUG', '缓存命中 [' + role + '/' + (mood || 'neutral') + '] ' + pathMod.basename(hit)); return { ok: true, file: hit, url: asUrl(hit), cached: true }; }
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
          if (await probe()) { probeFailCount = 0; break; }
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
      const err = r.error || ('HTTP ' + r.status + (r.buf ? ' ' + r.buf.toString('utf8').slice(0, 200) : ''));
      logLine('ERROR', '合成失败 [' + role + '/' + (mood || 'neutral') + '] ' + err);
      return { ok: false, error: err };
    }
    try { fsMod.writeFileSync(cacheFile, r.buf); } catch (e) { /* noop */ }
    logLine('INFO', '合成成功 [' + role + '/' + (mood || 'neutral') + '] ' + clean.slice(0, 24) + '… → ' + (r.buf.length / 1024).toFixed(0) + 'KB');
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
      logsFile: logFilePath(),
      installed: { runtime: isRuntimeInstalled(), voices: { airui: isVoiceInstalled('airui'), qianxia: isVoiceInstalled('qianxia'), nangong: isVoiceInstalled('nangong') } },
      hasVoices: ['airui', 'qianxia', 'nangong'].some((r) => !!loadEmotions(r)),
      // 仅在"确实探测失败且未在启动中"时提示错误，避免未运行时一直显示陈旧的连接错误
      lastError: (state === 'stopped' && lastStatus.checkedAt && lastStatus.lastError) ? lastStatus.lastError : '',
      config: cfg
    };
  }

  // ===== 安装状态检测（避免用户重复下载 6GB+）=====
  function isRuntimeInstalled() {
    try {
      return fsMod.existsSync(pathMod.join(dataRoot(), 'runtime', 'python.exe')) &&
             fsMod.existsSync(pathMod.join(dataRoot(), 'api_v2.py'));
    } catch (e) { return false; }
  }
  function runtimeDirCandidates() {
    return [pathMod.join(dataRoot(), 'runtime', 'python.exe'), pathMod.join(legacyTtsDir, 'runtime', 'python.exe')];
  }
  function isVoiceInstalled(role) {
    try {
      return voicesCandidates().some((c) => fsMod.existsSync(pathMod.join(c, role, 'emotions.json')));
    } catch (e) { return false; }
  }
  // 下载进度：附加"速度/剩余时间"（每卷重新采样），并**实时写入后台日志**便于观察
  let dlSample = { t: 0, got: 0 };
  function fmtSpeed(bps) {
    if (!bps || bps <= 0) return '';
    return bps >= 1048576 ? (bps / 1048576).toFixed(1) + ' MB/s' : Math.round(bps / 1024) + ' KB/s';
  }
  function fmtEta(sec) {
    if (!sec || sec <= 0) return '';
    sec = Math.round(sec);
    return sec >= 60 ? (Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒') : (sec + ' 秒');
  }
  function progressReporter(tag, part, parts) {
    let lastLogAt = 0;
    let lastPct = -1;
    return (got, total) => {
      const now = Date.now();
      let speed = 0, eta = 0;
      if (dlSample.t && now > dlSample.t && got >= dlSample.got) {
        speed = (got - dlSample.got) / ((now - dlSample.t) / 1000);
        if (total > 0 && speed > 0) eta = (total - got) / speed;
      }
      if (!dlSample.t || now - dlSample.t > 1200) dlSample = { t: now, got };
      setInstall({
        phase: 'download', part, parts, got, total,
        speed: Math.round(speed), eta: Math.round(eta),
        message: (total ? Math.round((got / total) * 100) + '%' : Math.round(got / 1048576) + 'MB')
      });
      // 实时日志（节流：间隔 ≥2 秒且百分比有变化）—— 控制台「后台日志」面板会自动刷新显示
      const pct = total > 0 ? Math.floor((got / total) * 100) : -1;
      if (now - lastLogAt >= 2000 && pct !== lastPct) {
        lastLogAt = now;
        lastPct = pct;
        const size = total > 0
          ? ((got / 1048576).toFixed(1) + ' / ' + (total / 1048576).toFixed(1) + ' MB')
          : ((got / 1048576).toFixed(1) + ' MB');
        logLine('INFO', tag + '下载中 ' + (pct >= 0 ? pct + '%　' : '') + size
          + (speed > 0 ? '　' + fmtSpeed(speed) : '')
          + (eta > 0 ? '　剩余 ' + fmtEta(eta) : ''));
      }
      if (total > 0 && got >= total) {
        logLine('INFO', tag + '下载完成：' + (total / 1048576).toFixed(1) + ' MB'
          + (speed > 0 ? '，平均速度 ' + fmtSpeed(speed) : ''));
      }
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
  async function installVoice(role, opts) {
    const force = !!(opts && opts.force);
    const url = buildVoiceUrl(role);
    if (!url) return { ok: false, error: '未配置仓库地址' };
    if (!force && isVoiceInstalled(role)) {
      logLine('INFO', '语音包[' + role + '] 已存在 → 跳过下载');
      setInstall({ phase: 'done', message: '语音包[' + role + '] 已安装（跳过）' });
      return { ok: true, skipped: true, message: '语音包已安装，未重复下载' };
    }
    const root = pathMod.join(dataRoot(), 'voices');       // 项目内 voices 目录
    const zipPath = pathMod.join(dataRoot(), '_voice_' + role + '.zip');
    try { fsMod.mkdirSync(root, { recursive: true }); } catch (e) { /* noop */ }
    try {
      dlSample = { t: 0, got: 0 };
      setInstall({ phase: 'download', part: 1, parts: 1, got: 0, total: 0, speed: 0, eta: 0, message: '语音包[' + role + '] 开始下载…' });
      logLine('INFO', '语音包[' + role + '] 下载：' + url);
      const r = await downloadTo(url, zipPath, progressReporter('语音包[' + role + '] ', 1, 1));
      setInstall({ phase: 'extract', got: r.bytes, total: r.bytes, message: '语音包[' + role + '] 解压中…' });
      logLine('INFO', '语音包[' + role + '] 解压中…（' + (r.bytes / 1048576).toFixed(1) + ' MB）');
      const tExt = Date.now();
      await expandArchive(zipPath, root);
      logLine('INFO', '语音包[' + role + '] 解压完成，用时 ' + ((Date.now() - tExt) / 1000).toFixed(1) + ' 秒');
      try { fsMod.unlinkSync(zipPath); } catch (e) { /* noop */ }
      logLine('INFO', '语音包[' + role + '] 安装完成');
      setInstall({ phase: 'done', message: '语音包[' + role + '] 安装完成' });
      broadcast();
      return { ok: true, role, dir: pathMod.join(root, role) };
    } catch (e) {
      logLine('ERROR', '语音包[' + role + '] 安装失败：' + (e && e.message));
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
  async function installFromUrl(urlOrUrls, opts) {
    const force = !!(opts && opts.force);
    const urls = parseUrls(urlOrUrls);
    if (!urls.length) return { ok: false, error: '未提供下载地址' };
    // 已安装 → 默认跳过（避免用户白等几 GB）；控制台可点"重新下载"
    if (!force && isRuntimeInstalled()) {
      logLine('INFO', '推理环境已存在 → 跳过下载（如需覆盖请选择"重新下载"）');
      setInstall({ phase: 'done', message: '已安装（跳过下载）' });
      return { ok: true, skipped: true, message: '推理环境已安装，未重复下载' };
    }
    const root = dataRoot();
    const zipPath = pathMod.join(dataRoot(), '_download.zip');
    try { fsMod.mkdirSync(root, { recursive: true }); } catch (e) { /* noop */ }
    try {
      logLine('INFO', '开始下载推理环境（' + urls.length + ' 个分包）' + (force ? ' [强制重下]' : ''));
      for (let i = 0; i < urls.length; i++) {
        const tag = urls.length > 1 ? ('第 ' + (i + 1) + '/' + urls.length + ' 包 ') : '';
        dlSample = { t: 0, got: 0 };
        setInstall({ phase: 'download', part: i + 1, parts: urls.length, got: 0, total: 0, speed: 0, eta: 0, message: tag + '开始下载…' });
        logLine('INFO', tag + '下载：' + urls[i]);
        const r = await downloadTo(urls[i], zipPath, progressReporter(tag, i + 1, urls.length));
        setInstall({ phase: 'extract', part: i + 1, parts: urls.length, got: r.bytes, total: r.bytes, message: tag + '解压中…' });
        logLine('INFO', tag + '解压中…（' + (r.bytes / 1048576).toFixed(1) + ' MB）');
        const tExt = Date.now();
        await expandArchive(zipPath, root);
        logLine('INFO', tag + '解压完成，用时 ' + ((Date.now() - tExt) / 1000).toFixed(1) + ' 秒');
        try { fsMod.unlinkSync(zipPath); } catch (e) { /* noop */ }
      }
      setInstall({ phase: 'detect', message: '全部解压完成，正在探测运行时…' });
      const det = detectRuntime(root);
      if (!det.python || !det.script) {
        logLine('ERROR', '未找到 python.exe 或 api_v2.py（压缩包内容不符）');
        setInstall({ phase: 'error', message: '未找到 python.exe 或 api_v2.py（请确认压缩包内容）' });
        return { ok: false, error: '未找到运行时/脚本', detected: det };
      }
      save({ mode: 'managed', runtimePath: det.python, serverScript: det.script, enabled: true });
      const okCfg = ensureInferConfig(root, cfg.device);
      logLine('INFO', '安装完成：runtime=' + det.python + '，推理配置切换 v2ProPlus=' + okCfg);
      setInstall({ phase: 'done', message: '安装完成，可直接使用' });
      return { ok: true, runtimePath: det.python, serverScript: det.script, inferConfig: okCfg };
    } catch (e) {
      logLine('ERROR', '推理环境安装失败：' + (e && e.message));
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
    ipcMain.handle('tts-install', (e, arg) => installFromUrl((arg && arg.urls) || arg || buildRuntimeUrls(), { force: !!(arg && arg.force) }));
    ipcMain.handle('tts-install-runtime', (e, opts) => installFromUrl(buildRuntimeUrls(), { force: !!(opts && opts.force) }));
    ipcMain.handle('tts-install-voice', (e, role, opts) => installVoice(String(role || ''), { force: !!(opts && opts.force) }));
    ipcMain.handle('tts-get-logs', (e, lines) => readLogs(lines || 300));
    ipcMain.handle('tts-open-logs', () => {
      try {
        const { shell } = require('electron');
        const f = logFilePath();
        if (fsMod.existsSync(f)) shell.showItemInFolder(f); else shell.openPath(logDirPath());
        return { ok: true, file: f };
      } catch (err) { return { ok: false, error: err && err.message }; }
    });
    ipcMain.handle('tts-open-data', () => {
      try { require('electron').shell.openPath(dataRoot()); return { ok: true, dir: dataRoot() }; } catch (err) { return { ok: false, error: err && err.message }; }
    });
    // 选择自定义目录/文件（kind: runtime=推理环境目录 | script=服务脚本 | voices=语音包目录）
    ipcMain.handle('tts-pick', async (e, kind) => {
      try {
        const { dialog } = require('electron');
        const w = getWin && getWin();
        const isFile = (kind === 'script');
        const res = await dialog.showOpenDialog(w && !w.isDestroyed() ? w : undefined, {
          title: kind === 'runtime' ? '选择推理环境目录（含 python.exe 与 api_v2.py）'
            : kind === 'script' ? '选择服务脚本（api_v2.py）'
            : '选择语音包目录（含 <角色>/emotions.json）',
          properties: isFile ? ['openFile'] : ['openDirectory'],
          filters: isFile ? [{ name: 'Python 脚本', extensions: ['py'] }] : undefined
        });
        if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, canceled: true };
        const picked = res.filePaths[0];
        if (kind === 'voices') {
          const has = ROLE_KEYS.some((r) => fsMod.existsSync(pathMod.join(picked, r, 'emotions.json')));
          save({ voicesDir: picked });
          logLine('INFO', '语音包目录已设为：' + picked + (has ? '（检测到情绪映射）' : '（未检测到 emotions.json，仍已保存）'));
          return { ok: true, dir: picked, detected: has, status: status() };
        }
        if (kind === 'script') {
          save({ serverScript: picked, mode: 'managed' });
          logLine('INFO', '服务脚本已设为：' + picked);
          return { ok: true, file: picked, status: status() };
        }
        // runtime：选目录 → 自动探测 python.exe 与 api_v2.py
        const det = detectRuntime(picked);
        const patch = { mode: 'managed' };
        if (det.python) patch.runtimePath = det.python;
        if (det.script) patch.serverScript = det.script;
        if (!det.python && !det.script) {
          logLine('WARN', '所选目录未找到 python.exe 或 api_v2.py：' + picked);
          return { ok: false, error: '该目录下未找到 python.exe 或 api_v2.py', dir: picked };
        }
        save(patch);
        logLine('INFO', '推理环境已指向：' + (det.python || '(未找到 python)') + ' / ' + (det.script || '(未找到脚本)'));
        return { ok: true, dir: picked, runtimePath: det.python, serverScript: det.script, status: status() };
      } catch (err) { return { ok: false, error: err && err.message }; }
    });
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
