// Vercel용 저장소 연결 (Upstash Redis REST API, 외부 패키지 없이 fetch만 사용)
// Vercel 프로젝트 → Storage → Upstash for Redis 를 연결하면 아래 환경변수가 자동으로 생겨요.
function findEnv() {
  const e = process.env;
  let url = e.KV_REST_API_URL || e.UPSTASH_REDIS_REST_URL;
  let token = e.KV_REST_API_TOKEN || e.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    // 연결할 때 이름 앞부분(접두어)을 바꾼 경우도 찾아 줌
    for (const k of Object.keys(e)) {
      if (!url && /(_REST_API_URL|REDIS_REST_URL)$/.test(k)) url = e[k];
      if (!token && /(_REST_API_TOKEN|REDIS_REST_TOKEN)$/.test(k) && !/READ_ONLY/.test(k)) token = e[k];
    }
  }
  return { url: url ? url.replace(/\/$/, '') : '', token: token || '' };
}
const { url: DB_URL, token: DB_TOKEN } = findEnv();
const hasDb = !!(DB_URL && DB_TOKEN);

async function pipe(cmds) {
  if (!hasDb) {
    const err = new Error('NO_DB');
    err.code = 'NO_DB';
    throw err;
  }
  const r = await fetch(DB_URL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + DB_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds.map((c) => c.map(String))),
  });
  if (!r.ok) throw new Error('DB ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const out = await r.json();
  return out.map((x) => {
    if (x.error) throw new Error('DB ' + x.error);
    return x.result;
  });
}

module.exports = { pipe, hasDb };
