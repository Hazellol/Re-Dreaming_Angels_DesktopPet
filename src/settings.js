// 妄想天使桌宠 · 配置持久层（settings）
// 所有"QX_*"键：优先进程环境变量（调试开关），其次 localStorage（用户记忆）。
// 接口以"注入对象"方式工作（如 loadAudioCfg(cfg, bgmCount) 原地钳制 cfg），
// 不直接读写渲染进程全局变量 → 可单测、可随时被其它配置复用。
// 加载顺序：core.js 之后、renderer.js 之前 —— 见 index.html
/* eslint-disable no-console */
(function () {
  'use strict';
  const CORE = window.PetCore;
  const { clampNum, clampBool } = CORE;

  // ---------- 通用存取 ----------
  function envOrLS(key) {
    let raw = null;
    try { raw = window.deskpet ? window.deskpet.env(key) : null; } catch (e) { raw = null; }
    if (raw) return raw;
    try { return localStorage.getItem(key) || null; } catch (e) { return null; }
  }
  function saveLS(key, obj) {
    try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) { /* noop */ }
  }

  // ---------- 缩放（all=统一值；单角色 null=跟随 all） ----------
  function loadScales(scales, roleKeys) {
    const raw = envOrLS('QX_SCALES');
    if (raw) {
      try { const o = JSON.parse(raw); if (o && typeof o.all === 'number') Object.assign(scales, o); } catch (e) { /* ignore */ }
    }
    const clamp = (v, d) => (typeof v === 'number' && isFinite(v) ? Math.min(200, Math.max(50, v)) : d);
    scales.all = clamp(scales.all, 100);
    for (const key of roleKeys) {
      scales[key] = (scales[key] == null) ? null : clamp(scales[key], 100);
    }
  }
  function saveScales(scales) { saveLS('QX_SCALES', scales); }

  // ---------- 频率（待机对话 3 模式 + 走动间隔 + 竖直移动开关） ----------
  const FREQ_MIN = 7, FREQ_MAX = 300;
  const FREQ_DEFAULTS = { dialogMode: 'fix', fixSec: 7, randMin: 10, randMax: 60, moveSec: 7, moveY: false };
  function loadFreq(freq) {
    const raw = envOrLS('QX_FREQ');
    if (raw) { try { Object.assign(freq, JSON.parse(raw)); } catch (e) { /* ignore */ } }
    clampFreq(freq);
  }
  function clampFreq(freq) {
    const c = (v, d) => (typeof v === 'number' && isFinite(v) ? Math.min(FREQ_MAX, Math.max(FREQ_MIN, v)) : d);
    freq.fixSec = c(freq.fixSec, FREQ_DEFAULTS.fixSec);
    freq.randMin = c(freq.randMin, FREQ_DEFAULTS.randMin);
    freq.randMax = c(freq.randMax, FREQ_DEFAULTS.randMax);
    if (freq.randMin > freq.randMax) { const t = freq.randMin; freq.randMin = freq.randMax; freq.randMax = t; }
    freq.moveSec = c(freq.moveSec, FREQ_DEFAULTS.moveSec);
    freq.moveY = clampBool(freq.moveY);
    if (!['off', 'fix', 'rand'].includes(freq.dialogMode)) freq.dialogMode = 'fix';
  }
  function saveFreq(freq) {
    clampFreq(freq);
    saveLS('QX_FREQ', freq);
  }

  // ---------- 音频（master/sfxVol/bgmVol 三路 + 静音 + BGM） ----------
  function loadAudioCfg(cfg, bgmCount) {
    const raw = envOrLS('QX_AUDIO');
    if (raw) { try { const o = JSON.parse(raw); if (o) Object.assign(cfg, o); } catch (e) { /* ignore */ } }
    cfg.master = clampNum(cfg.master, 0, 100, cfg.master || 70);
    cfg.sfxVol = clampNum(cfg.sfxVol, 0, 100, cfg.sfxVol || 100);
    cfg.bgmVol = clampNum(cfg.bgmVol, 0, 100, cfg.bgmVol || 60);
    cfg.bgmIdx = clampNum(cfg.bgmIdx, 0, Math.max(0, (bgmCount || 1) - 1), 0);
    cfg.muted = clampBool(cfg.muted);
    cfg.bgmOn = clampBool(cfg.bgmOn);
    if (cfg.playMode !== 'loop') cfg.playMode = 'order';
    return cfg;
  }
  function saveAudioCfg(cfg) { saveLS('QX_AUDIO', cfg); }

  // ---------- 互聊（触发距离/冷却/轮数/开关） ----------
  function loadChatterCfg(cfg) {
    const raw = envOrLS('QX_CHATTER');
    if (raw) { try { const o = JSON.parse(raw); if (o) Object.assign(cfg, o); } catch (e) { /* ignore */ } }
    cfg.on = clampBool(cfg.on);
    cfg.near = clampNum(cfg.near, 100, 400, 220);
    cfg.cool = clampNum(cfg.cool, 1, 10, 4);
    cfg.lines = Math.round(clampNum(cfg.lines, 2, 8, 5));
  }
  function saveChatterCfg(cfg) { saveLS('QX_CHATTER', cfg); }

  window.PetSettings = {
    envOrLS, saveLS,
    FREQ_MIN, FREQ_MAX, FREQ_DEFAULTS,
    loadScales, saveScales,
    loadFreq, clampFreq, saveFreq,
    loadAudioCfg, saveAudioCfg,
    loadChatterCfg, saveChatterCfg
  };
})();
