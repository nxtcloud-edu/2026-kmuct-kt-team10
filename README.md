# 🧠 협업 회의 플랫폼 (Collab Meeting Platform)

> 2026년 국민대학교 캠퍼스타운 키로톤 10팀 **바코드** 프로젝트

실시간 회의와 채팅 회의의 장점을 결합한 **비동기 토픽 기반 협업 회의 도구**입니다.
마인드맵 캔버스에서 안건(토픽)을 나누고, 각 토픽에서 의견을 주고받은 뒤,
참여자 전원이 찬성하면 토픽이 완료되고 AI가 결론 문서를 정리해 줍니다.

---

## ✨ 핵심 기능

### 회의 흐름
- **워크스페이스 + 초대 링크**: 링크 복사 한 번으로 팀원 초대, 이름만 입력하면 입장
- **재방문 기록 유지**: 브라우저에 신원을 저장해, 같은 링크로 다시 오면 이전 참여 상태로 복원
- **마인드맵 캔버스 (Miro 스타일)**
  - 계층적 **타원형 노드**(상위 토픽이 크고 하위로 갈수록 작아짐)
  - 노드 **드래그 이동**, 빈 공간 **패닝**, **확대/축소(줌)**
  - 노드별 **색상·사진** 꾸미기
  - 노드 hover 시 **의견 보기 / 하위 토픽 생성** 버튼
- **토픽 트리**: 안건을 하위 토픽으로 계속 분해 (사이드바에서 하위 토픽 추가)
- **토픽/의견 삭제** (토픽은 하위 트리까지 재귀 삭제)

### 의견 & 문서
- **채팅형 의견 페이지**: "의견 추가" 버튼 → **제목 + Markdown 본문**으로 작성, 카드로 순서대로 표시
- **답글(코멘트)**, **파일·문서·이미지 첨부**
- **Notion 스타일 문서 탭**: 토픽별 결론 문서를 Markdown으로 작성 (자동 저장)
- **완료 토픽은 문서 탭이 먼저** 열리고, 의견은 별도 탭에서 확인

### 완료(결정) 규칙
> 토픽에 **참여한 모든 인원이 찬성 투표**를 했고,
> **하위 토픽이 모두 완료**이거나 **해당 토픽이 최하단 토픽**인 경우에만 완료됩니다.
- 새 의견이 올라오면 찬성이 무효화되어 다시 논의 상태로 전환
- 새 참여자가 들어오면 그 사람의 찬성이 필요하도록 완료가 해제됨

### 🤖 AI 보조 (LLM)
> `OPENAI_API_KEY`가 없으면 **규칙 기반**으로, 있으면 **LLM**으로 동작 (동일 인터페이스)

- **의견 중복/상충 감지**: 새 의견 등록 시 기존 의견과 비교해 경고
- **유사 토픽 확인**: 토픽 생성 시 주제가 겹치는 기존 토픽을 보여주고 "정말 만들지" 확인
- **하위 토픽 추천**
- **AI 의견 추합·정리**: 현재 의견들을 하나의 정리 문서로 요약해 의견 페이지에 등록
- **다른 토픽과 충돌 확인**: 다른 토픽 의견과 상충되는 지점 피드백
- **회의 정리 문서 생성**: 완료된 토픽의 결론 문서를 자동 작성 (완료 시에만 활성화)
- **워크스페이스 요약**: 결정된 토픽 / 회의가 필요한 미결정 안건을 마크다운으로 정리

### 알림
- 내가 **참여한 토픽**에 새 의견/답글이 생기면 우측 상단 **🔔 종 아이콘**에 안 읽은 개수 뱃지가 뜸
- 종을 클릭하면 **알림 목록 드롭다운**이 열리고, 항목을 누르면 **해당 토픽 위치로 캔버스가 이동**하며 노드가 하이라이트됨(의견 사이드도 함께 열림)
- WebSocket으로 참여자·토픽·의견·완료 상태 변경을 **실시간 반영**

---

## 🛠 기술 스택
- **런타임**: Node.js 18+ (ESM)
- **서버**: Express (REST API) + `ws` (WebSocket 실시간)
- **프론트엔드**: Vanilla JS SPA (빌드 도구 없음), SVG 마인드맵, 자체 Markdown 렌더러
- **데이터**: 인메모리 + JSON 파일 영속화 (`data/db.json`)
- **LLM**: OpenAI 호환 API (OpenAI / Groq / **AWS Bedrock 게이트웨이** 등, base URL만 교체)

---

## 🚀 빠른 시작

```bash
# 1. 의존성 설치
npm install

# 2. (선택) 환경설정 — LLM을 쓰려면 .env 작성
cp .env.example .env   # 이후 키 입력. 안 하면 규칙 기반으로 동작

# 3. 서버 실행
npm start              # http://localhost:3000
# 개발 모드(파일 변경 시 자동 재시작): npm run dev
```

브라우저에서 **http://localhost:3000** 접속 → 워크스페이스 생성 → 링크 복사로 팀원 초대.

---

## ⚙️ 환경 변수 (`.env`)

| 키 | 설명 | 기본값 |
|----|------|--------|
| `PORT` | 서버 포트 | `3000` |
| `OPENAI_API_KEY` | LLM API 키 (비우면 규칙 기반) | (없음) |
| `OPENAI_MODEL` | 사용할 모델/별칭 | `gpt-4o-mini` |
| `OPENAI_BASE_URL` | OpenAI 호환 게이트웨이 주소 | `https://api.openai.com/v1` |

예시:
```env
PORT=3000
OPENAI_API_KEY=발급받은_키
OPENAI_MODEL=gpt-4o-mini
OPENAI_BASE_URL=https://api.openai.com/v1
```

> ⚠️ `.env`는 절대 커밋하지 마세요 (`.gitignore`에 포함됨). 키가 노출되면 즉시 폐기/재발급하세요.

---

## 📁 프로젝트 구조

```
.
├── server/
│   ├── server.js   # Express + WebSocket, REST API 라우트
│   ├── store.js    # 인메모리 + JSON 파일 데이터 저장소 (도메인 로직/완료 규칙)
│   ├── llm.js      # LLM 보조 기능 (규칙 기반 폴백 포함)
│   └── env.js      # .env 로더 (의존성 없이)
├── public/
│   ├── index.html  # 메인: 마인드맵 캔버스
│   ├── app.js      # 캔버스 렌더/드래그/줌/알림/유사토픽 확인
│   ├── topic.html  # 토픽 상세: 의견 채팅 + 문서 탭
│   ├── topic.js    # 의견/문서/AI 보조/찬성 투표 로직
│   └── style.css   # 전체 스타일
├── deploy/         # AWS EC2 배포 파일 (systemd, nginx, 가이드)
├── data/           # 런타임 데이터 (db.json, uploads/) — git 제외
├── .env.example
└── package.json
```

---

## 🔌 주요 API

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `GET` | `/api/llm-status` | LLM 활성화 여부 |
| `POST` | `/api/workspaces` | 워크스페이스 생성 |
| `GET` | `/api/workspaces/:id` | 워크스페이스 조회 |
| `POST` | `/api/workspaces/:id/participants` | 입장/재입장 |
| `POST` | `/api/workspaces/:id/topics` | 토픽 생성 |
| `POST` | `/api/workspaces/:id/topics/similar` | 유사 토픽 검색 (LLM) |
| `GET` | `/api/workspaces/:id/topics/:topicId` | 토픽 단건 조회 |
| `PATCH` | `/api/workspaces/:id/topics/:topicId` | 위치/색상/사진/제목/문서 수정 |
| `DELETE` | `/api/workspaces/:id/topics/:topicId` | 토픽(+하위) 삭제 |
| `POST` | `.../topics/:topicId/join` · `/leave` | 토픽 참여/탈퇴 |
| `POST` | `.../topics/:topicId/check` | 찬성 투표 토글 |
| `POST` | `.../topics/:topicId/opinions` | 의견 등록 (제목+본문+첨부) |
| `DELETE` | `.../topics/:topicId/opinions/:opinionId` | 의견 삭제 |
| `POST` | `.../opinions/:opinionId/comments` | 답글 등록 |
| `POST` | `/api/upload` | 파일 업로드 (base64) |
| `GET` | `.../topics/:topicId/suggest-subtopics` | 하위 토픽 추천 (LLM) |
| `POST` | `.../topics/:topicId/synthesize` | AI 의견 추합·정리 |
| `GET` | `.../topics/:topicId/cross-conflicts` | 다른 토픽과 충돌 확인 (LLM) |
| `POST` | `.../topics/:topicId/generate-document` | 완료 토픽 결론 문서 생성 |
| `GET` | `/api/workspaces/:id/summary` | 워크스페이스 요약 (LLM) |

실시간 이벤트(WebSocket): `participant_joined`, `topic_created`, `topic_updated`, `topic_deleted`, `opinion_added`, `opinion_deleted`, `comment_added`

---

## ☁️ 배포

AWS EC2 배포는 [`deploy/EC2-DEPLOY.md`](deploy/EC2-DEPLOY.md) 참고.
- `deploy/collab-meeting.service` — systemd 유닛 (자동 시작/재시작)
- `deploy/nginx-collab-meeting.conf` — nginx 리버스 프록시 (80→3000, WebSocket 지원)

---

## 📌 사용 예시 흐름

1. 조장이 워크스페이스를 만들고 링크로 팀원(사용자 1·2)을 초대
2. 안건 토픽 생성 → 필요 시 하위 토픽으로 분해
3. 사용자 1이 의견 제시 (제목 + Markdown 본문)
4. 사용자 2가 반박 → 답글로 논의 → 사용자 1이 수용
5. 결론이 정리되면 각자 **문서 탭에서 정리** 후 **찬성 투표**
6. 참여자 전원 찬성 → **토픽 완료** → AI가 결론 문서를 자동 정리

---

## 📝 라이선스
교육용 프로젝트 (2026 국민대 캠퍼스타운 키로톤).
