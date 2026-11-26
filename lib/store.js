// Vercel용 저장소 연결 (외부 패키지 없이 동작)
// 아래 세 가지 중 연결된 것을 자동으로 찾아서 써요.
//  1) Upstash Redis (REST 주소: KV_REST_API_URL / UPSTASH_REDIS_REST_URL 등)
//  2) 일반 Redis (redis:// 또는 rediss:// 주소: REDIS_URL / KV_URL 등) ← Vercel Storage의 "Redis"
//  3) 아무것도 없으면 임시 저장(메모리) — 연습용. 서버가 다시 켜지면 기록이 사라질 수 있어요.
const net = require('net');
const tls = require('tls');

function findEnv() {
  const e = process.env;
  let url = e.KV_REST_API_URL || e.UPSTASH_REDIS_REST_URL;
  let token = e.KV_REST_API_TOKEN || e.UPSTASH_REDIS_REST_TOKEN;
  // 연결할 때 이름 앞부분(접두어)을 바꾼 경우도 찾아 줌
  for (const k of Object.keys(e)) {
    if (!url && /(_REST_API_URL|REDIS_REST_URL)$/.test(k) && /^https:\/\//.test(e[k])) url = e[k];
    if (!token && /(_REST_API_TOKEN|REDIS_REST_TOKEN)$/.test(k) && !/READ_ONLY/.test(k)) token = e[k];
  }
  let redisUrl = e.REDIS_URL || e.KV_URL || '';
  if (!/^rediss?:\/\//.test(redisUrl)) redisUrl = '';
  if (!redisUrl) {
    for (const k of Object.keys(e)) {
      if (/^rediss?:\/\//.test(String(e[k] || ''))) { redisUrl = e[k]; break; }
    }
  }
  if (url && token) return { mode: 'rest', url: url.replace(/\/$/, ''), token };
  if (redisUrl) return { mode: 'redis', redisUrl };
  return { mode: 'memory' };
}
const ENV = findEnv();
const mode = ENV.mode;
const hasDb = mode !== 'memory';
// 진단용: 저장소와 관련 있어 보이는 환경변수 '이름'만 (값은 절대 보내지 않음)
const envNames = Object.keys(process.env).filter((k) => /REDIS|KV_|UPSTASH|STORAGE/.test(k)).sort();

// ---------------- 1) Upstash REST ----------------
async function pipeRest(cmds) {
  const r = await fetch(ENV.url + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + ENV.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds.map((c) => c.map(String))),
  });
  if (!r.ok) throw new Error('DB ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const out = await r.json();
  return out.map((x) => {
    if (x.error) throw new Error('DB ' + x.error);
    return x.result;
  });
}

// ---------------- 2) 일반 Redis (RESP 프로토콜) ----------------
class RespError extends Error {}
function encode(cmd) {
  let s = '*' + cmd.length + '\r\n';
  for (const a of cmd) {
    const b = Buffer.from(String(a), 'utf8');
    s += '$' + b.length + '\r\n' + b.toString('utf8') + '\r\n';
  }
  return s;
}
// buf[pos]부터 값 하나를 읽음. 아직 덜 왔으면 null
function parse(buf, pos) {
  if (pos >= buf.length) return null;
  const end = buf.indexOf('\r\n', pos);
  if (end < 0) return null;
  const type = String.fromCharCode(buf[pos]);
  const line = buf.toString('utf8', pos + 1, end);
  const next = end + 2;
  if (type === '+') return [line, next];
  if (type === '-') return [new RespError(line), next];
  if (type === ':') return [Number(line), next];
  if (type === '$') {
    const n = Number(line);
    if (n < 0) return [null, next];
    if (buf.length < next + n + 2) return null;
    return [buf.toString('utf8', next, next + n), next + n + 2];
  }
  if (type === '*') {
    const n = Number(line);
    if (n < 0) return [null, next];
    const arr = [];
    let p = next;
    for (let i = 0; i < n; i++) {
      const r = parse(buf, p);
      if (!r) return null;
      arr.push(r[0]);
      p = r[1];
    }
    return [arr, p];
  }
  throw new Error('알 수 없는 응답 ' + type);
}

let conn = null; // { sock, ready: Promise, queue: [], buf }
function connect() {
  if (conn) return conn.ready;
  const u = new URL(ENV.redisUrl);
  const port = Number(u.port) || 6379;
  const opts = { host: u.hostname, port };
  const c = { queue: [], buf: Buffer.alloc(0) };
  c.sock = u.protocol === 'rediss:' ? tls.connect({ ...opts, servername: u.hostname }) : net.connect(opts);
  c.sock.setNoDelay(true);
  c.sock.setKeepAlive(true, 10000);
  const fail = (err) => {
    if (conn === c) conn = null;
    for (const q of c.queue.splice(0)) q.reject(err);
    try { c.sock.destroy(); } catch {}
  };
  c.sock.on('data', (d) => {
    c.buf = c.buf.length ? Buffer.concat([c.buf, d]) : d;
    let pos = 0;
    for (;;) {
      let r;
      try { r = parse(c.buf, pos); } catch (e) { return fail(e); }
      if (!r) break;
      pos = r[1];
      const q = c.queue.shift();
      if (q) q.resolve(r[0]);
    }
    c.buf = c.buf.subarray(pos);
  });
  c.sock.on('error', (e) => fail(new Error('DB 연결 오류: ' + e.message)));
  c.sock.on('close', () => fail(new Error('DB 연결이 끊어졌어요')));
  const send = (cmds) => {
    const ps = cmds.map(() => new Promise((resolve, reject) => c.queue.push({ resolve, reject })));
    c.sock.write(cmds.map(encode).join(''));
    return Promise.all(ps);
  };
  c.send = send;
  const user = decodeURIComponent(u.username || '');
  const pass = decodeURIComponent(u.password || '');
  const db = u.pathname && u.pathname.length > 1 ? u.pathname.slice(1) : '';
  const first = [];
  if (pass) first.push(user && user !== 'default' ? ['AUTH', user, pass] : ['AUTH', pass]);
  if (db && db !== '0') first.push(['SELECT', db]);
  c.ready = (async () => {
    const r = first.length ? await send(first) : [];
    const bad = r.find((x) => x instanceof RespError);
    if (bad) { fail(bad); throw new Error('DB 로그인 실패: ' + bad.message); }
    return c;
  })();
  c.ready.catch(() => {});
  conn = c;
  return c.ready;
}
async function pipeRedis(cmds, retry = true) {
  let c;
  try {
    c = await connect();
    const out = await Promise.race([
      c.send(cmds),
      new Promise((_, rej) => setTimeout(() => rej(new Error('DB 응답 시간 초과')), 8000)),
    ]);
    return out.map((x) => {
      if (x instanceof RespError) throw new Error('DB ' + x.message);
      return x;
    });
  } catch (e) {
    // 오래 쉬어서 끊어진 연결이면 한 번 다시 연결
    if (retry && !/^DB (ERR|WRONG|NOSCRIPT)/.test(e.message)) {
      if (c && conn === c) { conn = null; try { c.sock.destroy(); } catch {} }
      return pipeRedis(cmds, false);
    }
    throw e;
  }
}

// ---------------- 3) 임시 저장 (메모리) ----------------
const mem = new Map();
const mh = (k) => { if (!(mem.get(k) instanceof Map)) mem.set(k, new Map()); return mem.get(k); };
const ml = (k) => { if (!Array.isArray(mem.get(k))) mem.set(k, []); return mem.get(k); };
function runMem([cmd, ...a]) {
  a = a.map(String);
  switch (String(cmd).toUpperCase()) {
    case 'GET': return mem.has(a[0]) ? mem.get(a[0]) : null;
    case 'SET': mem.set(a[0], a[1]); return 'OK';
    case 'DEL': { let n = 0; for (const k of a) if (mem.delete(k)) n++; return n; }
    case 'INCR': { const v = Number(mem.get(a[0]) || 0) + 1; mem.set(a[0], String(v)); return v; }
    case 'HSET': mh(a[0]).set(a[1], a[2]); return 1;
    case 'HSETNX': { const m = mh(a[0]); if (m.has(a[1])) return 0; m.set(a[1], a[2]); return 1; }
    case 'HDEL': return mh(a[0]).delete(a[1]) ? 1 : 0;
    case 'HGETALL': return mem.get(a[0]) instanceof Map ? [...mem.get(a[0])].flat() : [];
    case 'RPUSH': { const x = ml(a[0]); x.push(...a.slice(1)); return x.length; }
    case 'LRANGE': return Array.isArray(mem.get(a[0])) ? mem.get(a[0]).slice() : [];
    case 'EVAL': { // 값이 그대로일 때만 바꾸기 (quiz.js의 CAS 스크립트)
      const [, , key, oldv, newv] = a;
      if ((mem.has(key) ? mem.get(key) : null) === oldv) { mem.set(key, newv); return 1; }
      return 0;
    }
  }
  throw new Error('지원하지 않는 명령 ' + cmd);
}
async function pipeMem(cmds) {
  return cmds.map(runMem);
}

async function pipe(cmds) {
  if (mode === 'rest') return pipeRest(cmds);
  if (mode === 'redis') return pipeRedis(cmds);
  return pipeMem(cmds);
}

module.exports = { pipe, hasDb, mode, envNames };
