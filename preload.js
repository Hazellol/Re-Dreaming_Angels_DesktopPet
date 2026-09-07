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
  const abs = path.join(root, p);
  const buf = fs.readFileSync(abs);
  const head = buf.subarray(0, 12).toString('latin1');
  let mime = 'audio/mpeg';
  if (head.startsWith('RIFF')) mime = 'audio/wav';
  else if (head.startsWith('OggS')) mime = 'audio/ogg';
  else if (head.startsWith('fLaC')) mime = 'audio/flac';
  else if (head.startsWith('ftyp')) mime = 'audio/mp4';      // .m4a (MP4/AAC)
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// 扫描 assets/bgm/ 下的音频文件（用户可自行放入 mp3/wav/ogg/flac/m4a → 播放器自动收录）
const AUDIO_EXTS = ['.mp3', '.wav', '.ogg', '.flac', '.m4a'];
function listAudio() {
  const dir = path.join(root, 'bgm');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /\.(mp3|wav|ogg|flac|m4a)$/i.test(f))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))
    .map((f) => 'bgm/' + f);
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
  minimizePanel: () => ipcRenderer.send('panel-minimize'),
  setFocusable: (v) => ipcRenderer.send('set-focusable', !!v),
  setMouseIgnore: (ignore) => ipcRenderer.send('set-mouse-ignore', ignore),
  quit: () => ipcRenderer.send('quit')
});
