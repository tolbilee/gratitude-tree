const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');

function loadEnv() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const i = s.indexOf('=');
      if (i < 1) continue;
      const k = s.slice(0, i).trim(), v = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[k]) process.env[k] = v;
    }
  } catch (e) {}
}
loadEnv();

const PORT = process.env.PORT || 3000;
const DB = path.join(__dirname, 'messages.json');
const PUB = path.join(__dirname, 'public');
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_KEY || '';
const useSupabase = !!(SB_URL && SB_KEY);
const BAD_WORDS = []; // 필요하면 금칙어 추가: ['욕설1','욕설2']

let messages = [];
let saveTimer;
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => fs.writeFile(DB, JSON.stringify(messages), () => {}), 300); };

async function sb(pathname, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${pathname}`, {
    method,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(raw || res.statusText);
  return raw ? JSON.parse(raw) : null;
}

function readLocal() {
  try { const d = JSON.parse(fs.readFileSync(DB, 'utf8')); return Array.isArray(d) ? d : []; } catch (e) { return []; }
}

async function initStore() {
  if (!useSupabase) {
    messages = readLocal();
    console.log('Supabase 설정이 없어 messages.json 을 사용합니다.');
    console.log('  .env 에 SUPABASE_URL, SUPABASE_KEY 를 넣고 supabase.sql 을 실행하면 Supabase에 저장됩니다.');
    return;
  }
  messages = await sb('gratitude_messages?select=id,name,text,t&order=t.asc');
  if (!Array.isArray(messages)) messages = [];
  const local = readLocal();
  const have = new Set(messages.map(m => m.id));
  const fresh = local.filter(m => m && m.id && !have.has(m.id)).map(m => ({
    id: String(m.id),
    name: String(m.name || '익명').slice(0, 20) || '익명',
    text: String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 40),
    t: Number(m.t) || Date.now(),
  })).filter(m => m.text);
  if (fresh.length) {
    try {
      await sb('gratitude_messages?on_conflict=id', {
        method: 'POST', body: fresh, prefer: 'resolution=ignore-duplicates,return=minimal',
      });
      messages = messages.concat(fresh).sort((a, b) => a.t - b.t);
      console.log(`로컬 메시지 ${fresh.length}건을 Supabase로 옮겼습니다.`);
    } catch (e) {
      console.error('로컬 메시지 이전 실패:', e.message);
      if (!messages.length) messages = local;
    }
  }
  console.log(`Supabase 연결됨. 메시지 ${messages.length}건`);
}

const clients = new Set(), lastPost = new Map();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'POST' && url.pathname === '/api/messages') {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress, now = Date.now();
    if (now - (lastPost.get(ip) || 0) < 3000) return json(res, 429, { error: '잠시 후 다시 보내주세요' });
    let body = '';
    req.on('data', c => { body += c; if (body.length > 5000) req.destroy(); });
    req.on('end', async () => {
      let d;
      try { d = JSON.parse(body); } catch (e) { return json(res, 400, { error: '잘못된 요청' }); }
      const name = String(d.name || '').replace(/\s+/g, ' ').trim().slice(0, 20) || '익명';
      const text = String(d.text || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!text) return json(res, 400, { error: '메시지를 입력해주세요' });
      if (BAD_WORDS.some(w => text.includes(w) || name.includes(w))) return json(res, 400, { error: '고운 말로 작성해주세요' });
      const m = { id: now.toString(36) + Math.random().toString(36).slice(2, 6), name, text, t: now };
      try {
        if (useSupabase) await sb('gratitude_messages', { method: 'POST', body: m, prefer: 'return=minimal' });
        else save();
      } catch (e) {
        console.error(e);
        return json(res, 500, { error: '저장에 실패했습니다' });
      }
      lastPost.set(ip, now);
      messages.push(m);
      const payload = `data: ${JSON.stringify(m)}\n\n`;
      clients.forEach(c => c.write(payload));
      json(res, 200, { ok: true });
    });
    return;
  }
  if (url.pathname === '/api/messages') return json(res, 200, messages.slice(-400));
  if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    clients.add(res); req.on('close', () => clients.delete(res));
    return;
  }
  const p = url.pathname === '/' ? '/index.html' : url.pathname === '/screen' ? '/screen.html' : url.pathname;
  const fp = path.join(PUB, path.normalize(decodeURIComponent(p)));
  if (!fp.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (e, data) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});

initStore().then(() => {
  server.listen(PORT, () => {
    console.log(`\n감사 나무 서버 실행: 포트 ${PORT}`);
    Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal)
      .forEach(i => console.log(`  모바일:  http://${i.address}:${PORT}/\n  스크린:  http://${i.address}:${PORT}/screen`));
  });
}).catch(e => {
  console.error('Supabase 연결 실패:', e.message);
  console.error('supabase.sql 을 SQL Editor에서 실행했는지, .env 의 주소와 키가 맞는지 확인하세요.');
  process.exit(1);
});
setInterval(() => clients.forEach(c => c.write(': ping\n\n')), 20000);
