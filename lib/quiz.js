// Vercel용 퀴즈 진행 로직
// Vercel은 요청이 올 때만 잠깐 켜지는 방식이라, 모든 상태를 저장소(Redis)에 보관해요.
// 휴대폰과 진행자 화면은 1초 정도마다 상태를 확인(폴링)해요.
const { pipe } = require('./store');
const BUNDLED = require('../questions.json');

const AGES = ['30대 미만', '40대', '50대', '60대', '70대', '80대 이상'];
const K = {
  game: 'bq:game', // 진행 상태 (JSON)
  players: 'bq:players', // 참가자 (해시: pid → JSON)
  subs: 'bq:subs', // 이번 문제 제출 목록 (들어온 순서대로)
  seen: 'bq:seen', // 휴대폰에 문제가 처음 전달된 시각 (공정한 시간 측정용)
  once: 'bq:once', // 한 사람이 두 번 제출하지 못하게
  qs: 'bq:qs', // 진행자가 고친 문제 목록 (없으면 questions.json)
  ver: 'bq:ver', // 상태가 바뀔 때마다 1씩 증가
};
// 값이 그대로일 때만 바꾸기 (동시에 두 번 정답 공개되는 것을 막음)
const CAS = "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2]) return 1 else return 0 end";

const defaultGame = () => ({ phase: 'lobby', round: 0, qIndex: -1, q: null, startedAt: 0, limit: 30, used: [], stat: null });

// ---------------- 상태 읽기 ----------------
// 같은 서버 안에서는 0.5초 동안 읽은 값을 다시 씀 (참가자가 많아도 저장소 사용량이 적음)
let cache = null;
async function load(fresh = false) {
  if (!fresh && cache && Date.now() - cache.at < 500) return cache.s;
  const [g, pl, subs, seen, ver] = await pipe([
    ['GET', K.game], ['HGETALL', K.players], ['LRANGE', K.subs, 0, -1], ['HGETALL', K.seen], ['GET', K.ver],
  ]);
  const game = g ? JSON.parse(g) : defaultGame();
  const players = new Map();
  for (let i = 0; i + 1 < (pl || []).length; i += 2) players.set(pl[i], JSON.parse(pl[i + 1]));
  const submissions = [];
  const done = new Set();
  for (const raw of subs || []) {
    const x = JSON.parse(raw);
    if (x.round !== game.round || done.has(x.pid)) continue;
    done.add(x.pid);
    submissions.push(x);
  }
  const seenMap = new Map();
  for (let i = 0; i + 1 < (seen || []).length; i += 2) {
    const [r, t] = String(seen[i + 1]).split(':');
    if (Number(r) === game.round) seenMap.set(seen[i], Number(t));
  }
  const s = { game, gameRaw: g, players, submissions, seen: seenMap, ver: Number(ver) || 0 };
  cache = { at: Date.now(), s };
  return s;
}
const invalidate = () => { cache = null; };

async function getQuestions() {
  const [raw] = await pipe([['GET', K.qs]]);
  if (raw) { try { return JSON.parse(raw); } catch {} }
  return BUNDLED;
}

// 제한 시간이 지났으면 정답 공개 (따로 타이머를 켜 둘 수 없어서, 누군가 상태를 확인할 때 처리)
async function current(fresh = false) {
  let s = await load(fresh);
  const g = s.game;
  if (g.phase === 'question' && Date.now() > g.startedAt + g.limit * 1000 + 500) {
    await reveal(await load(true));
    s = await load(true);
  }
  return s;
}

// ---------------- 게임 진행 ----------------
// 점수표: 80% 이상 5점 / 70~80% 6점 / 60~70% 7점 / 50~60% 8점 / 40~50% 9점 / 40% 이하 10점
const SCORE_TABLE = [[80, 5], [70, 6], [60, 7], [50, 8]];
function pointsForRate(rate) {
  for (const [min, pts] of SCORE_TABLE) if (rate >= min) return pts;
  return rate > 40 ? 9 : 10;
}

async function startQuestion(index) {
  const qs = await getQuestions();
  const q = qs[index];
  if (!q) return false;
  const s = await load(true);
  const g = s.game;
  const used = [...new Set([...(g.used || []), index])];
  const ng = {
    phase: 'question', round: g.round + 1, qIndex: index, q, startedAt: Date.now(),
    limit: Math.max(5, Math.min(300, Number(q.time) || 30)), used, stat: null,
  };
  await pipe([['DEL', K.subs, K.seen, K.once], ['SET', K.game, JSON.stringify(ng)], ['INCR', K.ver]]);
  invalidate();
  return true;
}

async function reveal(s) {
  const g = s.game;
  if (g.phase !== 'question' || !g.q) return;
  const subs = s.submissions;
  const total = Math.max(s.players.size, subs.length);
  const correctSubs = subs.filter((x) => x.choice === g.q.answer);
  const rate = total ? (correctSubs.length / total) * 100 : 0;
  const worth = pointsForRate(rate);
  const ng = { ...g, phase: 'reveal', stat: { total, correctCount: correctSubs.length, rate: Math.round(rate * 10) / 10, worth } };
  const [ok] = await pipe([['EVAL', CAS, 1, K.game, s.gameRaw, JSON.stringify(ng)]]);
  if (Number(ok) !== 1) { invalidate(); return; } // 이미 다른 곳에서 공개함
  const cmds = [];
  for (const x of correctSubs) {
    const p = s.players.get(x.pid);
    if (!p) continue;
    p.score += worth; p.correct += 1; p.totalTime += x.elapsed;
    cmds.push(['HSET', K.players, x.pid, JSON.stringify(p)]);
  }
  cmds.push(['INCR', K.ver]);
  await pipe(cmds);
  invalidate();
}

async function goLobby() {
  let s = await load(true);
  if (s.game.phase === 'question') { await reveal(s); s = await load(true); }
  await pipe([['SET', K.game, JSON.stringify({ ...s.game, phase: 'lobby' })], ['INCR', K.ver]]);
  invalidate();
}

async function resetGame(clearPlayers) {
  const s = await load(true);
  const ng = { ...defaultGame(), round: s.game.round };
  const cmds = [['SET', K.game, JSON.stringify(ng)], ['DEL', K.subs, K.seen, K.once]];
  if (clearPlayers) cmds.push(['DEL', K.players]);
  else for (const [id, p] of s.players) cmds.push(['HSET', K.players, id, JSON.stringify({ ...p, score: 0, correct: 0, totalTime: 0 })]);
  cmds.push(['INCR', K.ver]);
  await pipe(cmds);
  invalidate();
}

async function saveQuestions(list) {
  const s = await load(true);
  await pipe([['SET', K.qs, JSON.stringify(list)], ['SET', K.game, JSON.stringify({ ...s.game, used: [] })], ['INCR', K.ver]]);
  invalidate();
}

// ---------------- 참가자 ----------------
async function join(name, age) {
  const id = require('crypto').randomUUID();
  const p = { id, name, age, score: 0, correct: 0, totalTime: 0, joinedAt: Date.now() };
  await pipe([['HSET', K.players, id, JSON.stringify(p)], ['INCR', K.ver]]);
  invalidate();
  return id;
}

async function leave(pid) {
  await pipe([['HDEL', K.players, String(pid || '')], ['INCR', K.ver]]);
  invalidate();
}

async function answer(pid, round, choiceRaw) {
  const now = Date.now();
  const s = await load(true);
  const g = s.game;
  if (!s.players.has(pid)) return { error: '참가 정보가 없어요. 다시 입장해 주세요.' };
  if (g.phase !== 'question' || round !== g.round) return { error: '지금은 제출할 수 없어요.' };
  if (now - g.startedAt > g.limit * 1000 + 1500) return { error: '시간이 지났어요.' };
  const choice = Number(choiceRaw);
  if (!Number.isInteger(choice) || choice < 0 || choice >= g.q.options.length) return { error: '답을 골라 주세요.' };
  const [first] = await pipe([['HSETNX', K.once, `${g.round}:${pid}`, '1']]);
  if (Number(first) !== 1) return { error: '이미 제출했어요.' };
  // 걸린 시간 = 이 사람 휴대폰에 문제가 전달된 때부터 (인터넷 속도 차이 보정)
  const elapsed = Math.max(0, Math.min(now - g.startedAt, now - (s.seen.get(pid) || g.startedAt)));
  const [order] = await pipe([['RPUSH', K.subs, JSON.stringify({ round: g.round, pid, choice, elapsed })], ['INCR', K.ver]]);
  invalidate();
  if (Number(order) >= s.players.size) await reveal(await load(true)); // 모두 제출하면 바로 정답 공개
  return { ok: true, order: Number(order), elapsed };
}

// ---------------- 화면에 보낼 내용 ----------------
const cmp = (a, b) =>
  b.score - a.score || b.correct - a.correct || a.totalTime - b.totalTime || a.joinedAt - b.joinedAt;
const pubPlayer = (p) => ({ name: p.name, age: p.age, score: p.score, correct: p.correct });

function buildState(s, qTotal) {
  const g = s.game;
  const isReveal = g.phase === 'reveal';
  const worth = g.stat ? g.stat.worth : 0;
  const isCorrect = (x) => !!g.q && x.choice === g.q.answer;
  const pubSub = (x, showAnswer) => {
    const p = s.players.get(x.pid) || { name: '(나감)', age: '-' };
    const c = isCorrect(x);
    return {
      name: p.name, age: p.age, elapsed: x.elapsed,
      choice: showAnswer ? x.choice : null,
      correct: showAnswer ? c : null,
      points: showAnswer ? (c ? worth : 0) : null,
    };
  };
  const all = [...s.players.values()];
  const list = [...all].sort(cmp);
  const rank = new Map();
  const byAge = {};
  const ageCounts = {};
  for (const a of AGES) { byAge[a] = []; ageCounts[a] = 0; }
  list.forEach((p, i) => {
    if (!byAge[p.age]) return;
    ageCounts[p.age] += 1;
    byAge[p.age].push(p);
    rank.set(p.id, { rank: i + 1, ageRank: byAge[p.age].length });
  });
  const subs = s.submissions;
  const st = {
    phase: g.phase,
    round: g.round,
    qIndex: g.qIndex,
    total: qTotal,
    question: g.q
      ? { text: g.q.text, options: g.q.options, answer: isReveal ? g.q.answer : null,
          ref: g.q.ref || '', book: g.q.book || '', group: g.q.group || '', no: g.q.no || g.qIndex + 1 }
      : null,
    used: g.used || [],
    net: { publicUrl: '', status: 'cloud', message: '' },
    startedAt: g.startedAt,
    limit: g.limit,
    serverNow: Date.now(),
    playerCount: s.players.size,
    submitCount: subs.length,
    ages: AGES,
    ageCounts,
    roster: AGES.map((a) => ({ age: a, names: [...all].sort((x, y) => x.joinedAt - y.joinedAt).filter((p) => p.age === a).map((p) => p.name) })),
    fastest: subs.slice(0, 10).map((x) => pubSub(x, isReveal)),
    rankings: {
      overall: list.slice(0, 10).map(pubPlayer),
      byAge: Object.fromEntries(AGES.map((a) => [a, byAge[a].slice(0, 10).map(pubPlayer)])),
    },
  };
  if (isReveal && g.q) {
    st.stat = g.stat;
    st.optionCounts = g.q.options.map((_, i) => subs.filter((x) => x.choice === i).length);
    const correctSubs = subs.filter(isCorrect);
    st.fastestCorrect = correctSubs.slice(0, 10).map((x) => pubSub(x, true));
    st.ageFastest = Object.fromEntries(
      AGES.map((a) => {
        const x = correctSubs.find((y) => s.players.get(y.pid)?.age === a);
        return [a, x ? pubSub(x, true) : null];
      })
    );
  }
  return { st, rank };
}

// 참가자 휴대폰용 (꼭 필요한 정보만)
async function playerPayload(pid, v) {
  let s = await current();
  if (pid && !s.players.has(pid)) s = await load(true); // 방금 입장한 사람은 최신 정보로 확인
  const g = s.game;
  const known = s.players.has(pid);
  if (g.phase === 'question' && known && !s.seen.has(pid)) {
    const now = Date.now();
    await pipe([['HSETNX', K.seen, pid, `${g.round}:${now}`]]);
    s.seen.set(pid, now);
  } else if (Number(v) === s.ver && known) {
    return { same: 1 };
  }
  const { st, rank } = buildState(s, 0);
  const p = s.players.get(pid);
  let me = { unknown: true };
  if (p) {
    const idx = s.submissions.findIndex((x) => x.pid === pid);
    const x = s.submissions[idx];
    const isReveal = g.phase === 'reveal';
    const c = x && g.q ? x.choice === g.q.answer : false;
    me = {
      name: p.name, age: p.age, score: p.score, correct: p.correct,
      rank: rank.get(pid)?.rank, ageRank: rank.get(pid)?.ageRank,
      ageTotal: st.ageCounts[p.age],
      sub: x
        ? { choice: x.choice, order: idx + 1, elapsed: x.elapsed, correct: isReveal ? c : null, points: isReveal ? (c ? g.stat?.worth || 0 : 0) : null }
        : null,
    };
  }
  return {
    v: s.ver, phase: st.phase, round: st.round, qIndex: st.qIndex, question: st.question,
    startedAt: st.startedAt, limit: st.limit, playerCount: st.playerCount, stat: st.stat || null,
    serverNow: Date.now(), me,
  };
}

async function hostState() {
  const s = await current();
  const qs = await getQuestionsCached();
  return buildState(s, qs.length).st;
}
// 진행자 화면은 문제 개수만 필요하므로 문제 목록은 10초 동안 다시 씀
let qCache = null;
async function getQuestionsCached() {
  if (qCache && Date.now() - qCache.at < 10000) return qCache.list;
  const list = await getQuestions();
  qCache = { at: Date.now(), list };
  return list;
}
const clearQCache = () => { qCache = null; };

module.exports = {
  AGES, getQuestions, startQuestion, reveal, load, goLobby, resetGame, saveQuestions,
  join, leave, answer, playerPayload, hostState, clearQCache,
};
