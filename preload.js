// 妄想天使桌宠 - 渲染进程素材桥（读本地 assets，无网络）
const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'assets');
// 运行数据目录：开发时=项目内 data/；打包后（asar 只读）→ %APPDATA%/ReDreamingAngels/data
const _inAsar = __dirname.indexOf('app.asar') !== -1 || process.env.PORTABLE_EXECUTABLE_DIR ||
  (process.env.APP_BUNDLE && /\.asar$/i.test(process.env.APP_BUNDLE));
const dataDir = _inAsar
  ? path.join(process.env.APPDATA || path.dirname(process.execPath), 'ReDreamingAngels', 'data')
  : path.join(__dirname, 'data');

function imageToDataUrl(p) {
  const abs = path.join(root, p);
  const buf = fs.readFileSync(abs);
  const head = buf.subarray(0, 12).toString('latin1');
  let mime = 'image/png';
  if (head.startsWith('RIFF') && head.includes('WEBP')) mime = 'image/webp';
  else if (head.charCodeAt(0) === 0xff && head.charCodeAt(1) === 0xd8) mime = 'image/jpeg';
  else if (head.startsWith('\x89PNG')) mime = 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function audioToDataUrl(p) {
  // 内置 assets/bgm 优先；用户导入目录（%APPDATA%/ReDreamingAngels/bgm）兜底
  const rel = String(p).replace(/^bgm\//, '');
  let abs = path.join(root, p);
  if (!fs.existsSync(abs)) {
    const cand = path.join(process.env.APPDATA || path.dirname(process.execPath), 'ReDreamingAngels', 'bgm', rel);
    if (fs.existsSync(cand)) abs = cand;
  }
  const buf = fs.readFileSync(abs);
  const head = buf.subarray(0, 12).toString('latin1');
  let mime = 'audio/mpeg';
  if (head.startsWith('RIFF')) mime = 'audio/wav';
  else if (head.startsWith('OggS')) mime = 'audio/ogg';
  else if (head.startsWith('fLaC')) mime = 'audio/flac';
  else if (head.startsWith('ftyp')) mime = 'audio/mp4';      // .m4a (MP4/AAC)
  else if (head.charCodeAt(0) === 0x49 && head.charCodeAt(1) === 0x44 && head.charCodeAt(2) === 0x33) mime = 'audio/mpeg';   // ID3
  else if (head.startsWith('ADIF') || head.startsWith('ADTS')) mime = 'audio/aac';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// 扫描音频：内置 assets/bgm/ + 用户导入目录 %APPDATA%/ReDreamingAngels/bgm（播放器"添加歌曲"导入到后者）
const AUDIO_EXTS = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac'];
const userBgmDir = path.join(process.env.APPDATA || path.dirname(process.execPath), 'ReDreamingAngels', 'bgm');
function isAudio(f) { return AUDIO_EXTS.some((e) => f.toLowerCase().endsWith(e)); }
function listAudio() {
  const out = [];
  const seen = {};
  const dir = path.join(root, 'bgm');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter(isAudio).sort((a, b) => a.localeCompare(b, 'zh-CN'))) {
      if (!seen[f]) { seen[f] = 1; out.push('bgm/' + f); }
    }
  }
  try {
    if (fs.existsSync(userBgmDir)) {
      for (const f of fs.readdirSync(userBgmDir).filter(isAudio).sort((a, b) => a.localeCompare(b, 'zh-CN'))) {
        if (!seen[f]) { seen[f] = 1; out.push('bgm/' + f); }
      }
    }
  } catch (e) { /* noop */ }
  return out;
}

// 聊天历史：存项目内 data/chat_<role>.json（下次打开接上对话）
function readChatHistory(role) {
  try {
    return fs.readFileSync(path.join(dataDir, 'chat_' + role + '.json'), 'utf8');
  } catch (e) { return null; }
}
function writeChatHistory(role, text) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'chat_' + role + '.json'), text, 'utf8');
    return true;
  } catch (e) { return false; }
}

// AI 配置：项目内 data/ai_config.json（panel 与主窗共享同一真源）
function readAICfg() {
  try { return fs.readFileSync(path.join(dataDir, 'ai_config.json'), 'utf8'); } catch (e) { return null; }
}
function writeAICfg(text) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'ai_config.json'), text, 'utf8');
    return true;
  } catch (e) { return false; }
}

contextBridge.exposeInMainWorld('deskpet', {
  readText: (p) => fs.readFileSync(path.join(root, p), 'utf8'),
  // 项目根相对路径读取（人设提示词参考等，只读）
  readProjectText: (p) => fs.readFileSync(path.join(__dirname, p), 'utf8'),
  readImage: (p) => imageToDataUrl(p),
  readAudio: (p) => audioToDataUrl(p),
  listAudio: () => listAudio(),
  readChatHistory: (role) => readChatHistory(role),
  writeChatHistory: (role, text) => writeChatHistory(role, text),
  clearChatHistory: (role) => {
    try { fs.rmSync(path.join(dataDir, 'chat_' + role + '.json'), { force: true }); return true; }
    catch (e) { return false; }
  },
  readAICfg: () => readAICfg(),
  writeAICfg: (text) => writeAICfg(text),
  notifyAICfgSaved: () => ipcRenderer.send('ai-config-saved'),
  onAICfgSaved: (cb) => ipcRenderer.on('ai-config-refresh', () => cb()),
  // 剪贴板
  clipboardRead: () => ipcRenderer.invoke('clipboard-read'),
  clipboardWrite: (text) => ipcRenderer.invoke('clipboard-write', text),
  // 系统开关：开机自启动 / 保持置顶
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (v) => ipcRenderer.invoke('set-auto-launch', v),
  getTopmost: () => ipcRenderer.invoke('get-topmost'),
  setTopmost: (v) => ipcRenderer.invoke('set-topmost', v),
  // 播放器：导入歌曲（系统文件对话框 → 复制到用户歌曲目录）
  importBgm: () => ipcRenderer.invoke('import-bgm'),
  aiChat: (payload) => ipcRenderer.invoke('ai-chat', payload),
  aiTest: (cfg) => ipcRenderer.invoke('ai-test', cfg),
  env: (k) => (process.env[k] || null),
  interact: () => ipcRenderer.send('context-menu'),
  onInteract: (cb) => ipcRenderer.on('user-interact', () => cb()),
  onTrainEvent: (cb) => ipcRenderer.on('train-event', () => cb()),
  onLock: (cb) => ipcRenderer.on('lock-toggle', (e, v) => cb(v)),
  onSizePanel: (cb) => ipcRenderer.on('size-panel', () => cb()),
  onFreqPanel: (cb) => ipcRenderer.on('freq-panel', () => cb()),
  onVisibility: (cb) => ipcRenderer.on('set-idol-visibility', (e, key, on) => cb(key, on)),
  onMainShown: (cb) => ipcRenderer.on('main-shown', () => cb()),
  onPanelInit: (cb) => ipcRenderer.on('panel-init', (e, s) => cb(s)),
  sendVisibility: (key, on) => ipcRenderer.send('panel-visibility', { key, on }),
  toggleIdolWindow: () => ipcRenderer.send('toggle-idol-window'),
  openPanel: () => ipcRenderer.send('open-panel'),
  getIdolsShown: () => ipcRenderer.invoke('get-idols-shown'),
  setIdolsShown: (shown) => ipcRenderer.invoke('set-idols-shown', shown),
  onIdolsShown: (cb) => ipcRenderer.on('idols-shown', (e, on) => cb(on)),
  // 最大帧率（设置页 → 主进程广播给桌宠窗口）
  setMaxFps: (v) => ipcRenderer.send('set-max-fps', v),
  onMaxFps: (cb) => ipcRenderer.on('max-fps', (e, v) => cb(v)),
  onOccluded: (cb) => ipcRenderer.on('occluded', (e, v) => cb(v)),
  // 多显示器：运行屏幕设置 / 显示器信息 / 窗口跨屏后的角色坐标补偿
  setScreenMode: (mode) => ipcRenderer.invoke('set-screen-mode', mode),
  getScreenInfo: () => ipcRenderer.invoke('get-screen-info'),
  onWindowMoved: (cb) => ipcRenderer.on('window-moved', (e, info) => cb(info)),
  // TTS 语音（本地合成；默认关闭，控制台「🎙 语音」页开启）
  ttsStatus: () => ipcRenderer.invoke('tts-status'),
  ttsConfig: (patch) => ipcRenderer.invoke('tts-config', patch),
  ttsProbe: () => ipcRenderer.invoke('tts-probe'),
  ttsStart: () => ipcRenderer.invoke('tts-start'),
  ttsStop: () => ipcRenderer.invoke('tts-stop'),
  ttsSpeak: (payload) => ipcRenderer.invoke('tts-speak', payload),
  ttsEmotions: (role) => ipcRenderer.invoke('tts-emotions', role),
  onTtsStatus: (cb) => ipcRenderer.on('tts-status', (e, s) => cb(s)),
  onTtsTestPlay: (cb) => ipcRenderer.on('tts-test-play', (e, url) => cb(url)),
  ttsInstall: (url) => ipcRenderer.invoke('tts-install', url),
  ttsInstallRuntime: () => ipcRenderer.invoke('tts-install-runtime'),
  ttsInstallVoice: (role) => ipcRenderer.invoke('tts-install-voice', role),
  ttsUrls: () => ipcRenderer.invoke('tts-urls'),
  ttsInstallState: () => ipcRenderer.invoke('tts-install-state'),
  onTtsInstallProgress: (cb) => ipcRenderer.on('tts-install-progress', (e, s) => cb(s)),
  ttsOpenCache: () => ipcRenderer.invoke('tts-open-cache'),
  minimizePanel: () => ipcRenderer.send('panel-minimize'),
  closePanel: () => ipcRenderer.send('panel-close'),
  setFocusable: (v) => ipcRenderer.send('set-focusable', !!v),
  setMouseIgnore: (ignore) => ipcRenderer.send('set-mouse-ignore', ignore),
  moveTop: () => ipcRenderer.send('move-top'),
  // 上报"可交互矩形"（主进程鼠标轮询裁决穿透用；rects=窗口 client 坐标数组，force=拖动/编辑中强制可交互）
  sendHitRects: (rects, force, evtCount, moving) => ipcRenderer.send('hit-rects', { rects, force: !!force, evtCount: evtCount || 0, moving: !!moving }),
  onDragAbort: (cb) => ipcRenderer.on('drag-abort', (e, reason) => cb(reason)),
  getHotkey: () => ipcRenderer.invoke('get-hotkey'),
  quit: () => ipcRenderer.send('quit')
});
