// Vercel 서버 함수: 모든 /api/... 요청을 여기서 처리해요 (vercel.json 의 rewrites 참고)
// Vercel 설정(Settings → Environment Variables)에 HOST_PASSWORD(진행자 비밀번호)를 꼭 정해 주세요.
const crypto = require('crypto');
const quiz = require('../lib/quiz');
const { hasDb, mode: storeMode, envNames } = require('../lib/store');

const HOST_PASSWORD = String(process.env.HOST_PASSWORD || '');
const HOST_TOKEN = HOST_PASSWORD ? crypto.createHash('sha256').update('quiz-host:' + HOST_PASSWORD).digest('hex') : '';

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}
async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body || '{}'); } catch { return {}; } }
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function cookie(req, name) {
  const m = String(req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? m[1] : '';
}
function validQuestion(q) {
  return (
    q && typeof q.text === 'string' && q.text.trim() &&
    Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 4 &&
    q.options.every((o) => typeof o === 'string' && o.trim()) &&
    Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length
  );
}

module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  // vercel.json 이 /api/poll → /api/quiz?__p=poll 로 바꿔 보냄
  const sub = url.searchParams.get('__p');
  const p = sub != null ? '/api/' + sub.replace(/^\/+/, '') : url.pathname;
  const method = req.method;
  const isHost = !!(HOST_TOKEN && cookie(req, 'qh') === HOST_TOKEN);
  try {
    if (p === '/api/info') {
      return json(res, 200, { ips: [], port: 0, net: { publicUrl: '', status: 'cloud', message: '' }, cloud: true, mode: 'poll', auth: isHost, db: hasDb, store: storeMode, pw: !!HOST_PASSWORD,
        // 진단용: 저장소 관련 환경변수 '이름'만 (진행자에게만)
        envNames: isHost ? envNames : undefined });
    }
    if (p === '/api/host/login' && method === 'POST') {
      const b = await readBody(req);
      if (!HOST_TOKEN) return json(res, 400, { error: '진행자 비밀번호가 아직 없어요. Vercel → Settings → Environment Variables 에 HOST_PASSWORD 를 만들고 다시 배포(Redeploy)해 주세요.' });
      if (String(b.password || '') !== HOST_PASSWORD) return json(res, 401, { error: '비밀번호가 맞지 않아요.' });
      res.setHeader('Set-Cookie', `qh=${HOST_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400; Secure`);
      return json(res, 200, { ok: true });
    }
    // 저장소가 없어도 임시 저장(메모리)으로 동작함 → 참가자는 QR로 바로 들어올 수 있음

    const hostOnly = p === '/api/state' || p.startsWith('/api/host/') || (p === '/api/questions' && method !== 'GET');
    if (hostOnly && !isHost) return json(res, 403, { error: '진행자 로그인이 필요해요.' });

    // --- 참가자 ---
    if (p === '/api/poll') return json(res, 200, await quiz.playerPayload(url.searchParams.get('pid'), url.searchParams.get('v')));
    if (p === '/api/join' && method === 'POST') {
      const b = await readBody(req);
      const name = String(b.name || '').trim().slice(0, 20);
      if (!name || !quiz.AGES.includes(b.age)) return json(res, 400, { error: '이름과 연령대를 모두 선택해 주세요.' });
      return json(res, 200, { id: await quiz.join(name, b.age) });
    }
    if (p === '/api/leave' && method === 'POST') {
      const b = await readBody(req);
      await quiz.leave(b.pid);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/answer' && method === 'POST') {
      const b = await readBody(req);
      const r = await quiz.answer(String(b.pid || ''), b.round, b.choice);
      return json(res, r.error ? 400 : 200, r);
    }

    // --- 진행자 ---
    if (p === '/api/state') return json(res, 200, { ...(await quiz.hostState()), store: storeMode });
    if (p === '/api/questions' && method === 'GET') {
      // 정답이 들어 있으므로 진행자만 볼 수 있음
      if (!isHost) return json(res, 403, { error: '진행자 로그인이 필요해요.' });
      return json(res, 200, await quiz.getQuestions());
    }
    if (p === '/api/questions' && method === 'PUT') {
      const b = await readBody(req);
      if (!Array.isArray(b) || !b.every(validQuestion)) return json(res, 400, { error: '문제 형식이 올바르지 않아요.' });
      const list = b.map((q) => ({
        ...q, text: q.text.trim(), options: q.options.map((o) => o.trim()), answer: q.answer,
        time: Number(q.time) || 30, ref: String(q.ref || '').trim(), book: String(q.book || '').trim(),
      }));
      await quiz.saveQuestions(list);
      quiz.clearQCache();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/host/start' && method === 'POST') {
      const b = await readBody(req);
      return (await quiz.startQuestion(Number(b.index))) ? json(res, 200, { ok: true }) : json(res, 400, { error: '문제가 없어요.' });
    }
    if (p === '/api/host/reveal' && method === 'POST') { await quiz.reveal(await quiz.load(true)); return json(res, 200, { ok: true }); }
    if (p === '/api/host/lobby' && method === 'POST') { await quiz.goLobby(); return json(res, 200, { ok: true }); }
    if (p === '/api/host/reset' && method === 'POST') {
      const b = await readBody(req);
      await quiz.resetGame(!!b.clearPlayers);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: '없는 주소예요.' });
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: '서버 오류: 잠시 후 다시 해 주세요.' });
  }
};
