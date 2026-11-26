# 🧚 집밥 프로젝트 은혜제

## ▲ Vercel에 올리기 (이 보관함)
1. vercel.com → GitHub로 가입 → **Add New… → Project** → `jipbapbackup` **Import**
2. **Deploy** (진행자 비밀번호는 필요 없어요)
3. **Storage** → **Upstash Redis**(Free) 만들기 → 이 프로젝트에 **Connect**
4. **Deployments → ⋯ → Redeploy**
5. 진행자: `https://(주소).vercel.app/host` (비밀번호 없이 열림) / 참가자: QR코드

자세한 그림 설명은 `GUIDE_VERCEL.html`을 보세요.

👉 **자세한 사용법은 `GUIDE.html`(사용설명서)을 더블클릭해서 보세요.** (그림 포함)
👉 **참가자가 100명이 넘으면 `GUIDE_CLOUD.html`(인터넷 서버에 올리기)을 보세요.**
👉 **Vercel에 올려서 쓰려면 `GUIDE_VERCEL.html`을 보세요.** (컴퓨터를 켜 두지 않아도 돼요)

## 아주 짧은 사용법
1. (처음 한 번만) https://nodejs.org/ko 에서 초록색 LTS 버튼 → 설치
2. 윈도우: `START_Windows.bat` 더블클릭 / 맥: `START_Mac.command` 오른쪽 클릭 → 열기
3. 자동으로 열린 화면(QR코드)을 TV·빔프로젝터에 띄우기
4. QR코드 아래 ✅ 초록색 표시가 나오면 준비 끝 (10~30초)
5. 참가자: 휴대폰 데이터(LTE·5G) 또는 와이파이로 QR 찍기 → 이름·나이대 고르고 입장
6. 🎲 무작위 문제 내기 → 답 고르고 제출 → 정답 공개 → 🏆 순위

※ 검은 창을 닫으면 퀴즈가 꺼져요. 다시 켜면 인터넷 주소(QR)가 바뀌어요.
※ 데이터 접속은 Cloudflare 무료 터널을 써요(가입 필요 없음, 처음 실행 때 자동으로 내려받음). 끄려면 TUNNEL=0 으로 실행하세요.

## 점수 계산
문제마다 **정답률(전체 참가 인원 중 맞힌 사람 비율)**로 점수가 정해져요. 맞힌 사람은 모두 같은 점수, 틀리면 0점.

| 정답률 | 80% 이상 | 70~80% | 60~70% | 50~60% | 40~50% | 40% 이하 |
|---|---|---|---|---|---|---|
| 점수 | 5점 | 6점 | 7점 | 8점 | 9점 | 10점 |

- 경계값: 80%는 5점, 70%는 6점, 60%는 7점, 50%는 8점, 40%는 10점
- 점수가 같으면 맞힌 문제의 걸린 시간 합계가 짧은 사람이 앞 순위
- 점수표는 `server.js`의 `SCORE_TABLE`에서 바꿀 수 있어요

## 들어 있는 문제
- 집밥프로젝트 기말고사 예상문제 100개 (구약 50 + 신약 50)를 4지선다로 바꿔 넣었어요.
- 정답은 답지 그대로이고, 오답 보기 3개씩은 새로 만들었어요.
- 문제마다 성경 책 이름과 출처 구절이 표시돼요. 빈칸 `( )`는 화면에 `?` 빈칸으로 보여요.
- 진행자 화면의 📝 문제 관리에서 고칠 수 있어요. (`questions.json` 파일에 저장)

## 파일 구성
- `START_Windows.bat`, `START_Mac.command` : 실행 파일 (더블클릭)
- `GUIDE.html` : 사용설명서
- `server.js` : 서버 프로그램
- `tunnel.js` : 데이터 접속용 인터넷 주소 만들기 (내 컴퓨터 실행 시)
- `render.yaml` : 인터넷 서버(Render) 설정
- `public/login.html` : 인터넷 서버용 진행자 로그인 화면
- `GUIDE_CLOUD.html` : 인터넷 서버에 올리는 방법
- `vercel.json`, `api/quiz.js`, `lib/` : Vercel용 설정과 서버 (상태는 Upstash Redis에 저장)
- `GUIDE_VERCEL.html` : Vercel에 올리는 방법
- `public/` : 화면 파일 (진행자 화면 host.html, 참가자 화면 join.html)
- `questions.json` : 문제 100개
