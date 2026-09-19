// Mock TTS 服务：用于在没有 GPT-SoVITS 环境时验证桌宠侧完整链路
// 用法：node tools/mock_tts_server.mjs [port]
// 行为：/health → 200；POST /tts → 返回一段 0.8s 静音 wav（并打印收到的参数，便于核对请求格式）
import http from 'node:http';
import path from 'node:path';

const port = parseInt(process.argv[2], 10) || 9881;

function silentWav(seconds = 0.8, rate = 32000) {
  const n = Math.floor(rate * seconds);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);      // PCM
  buf.writeUInt16LE(1, 22);      // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  return buf;
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mock: true }));
    return;
  }
  if (req.method === 'POST' && req.url.startsWith('/tts')) {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { /* noop */ }
      console.log('[MOCK-TTS] text=', JSON.stringify((body.text || '').slice(0, 40)),
        'ref=', body.ref_audio_path ? path.basename(body.ref_audio_path) : '(none)',
        'prompt=', JSON.stringify((body.prompt_text || '').slice(0, 20)));
      const wav = silentWav();
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length });
      res.end(wav);
    });
    return;
  }
  res.writeHead(404); res.end();
});
server.listen(port, '127.0.0.1', () => console.log('[MOCK-TTS] listening on 127.0.0.1:' + port));
