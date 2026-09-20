// server/server.js
// Express REST API + WebSocket 실시간 알림 서버.
// 정적 파일(프론트엔드)도 함께 서빙한다.

import './env.js'; // .env 로드 (다른 모듈보다 먼저 실행되어야 함)
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { store } from './store.js';
import { checkOpinions, suggestSubtopics, summarizeWorkspace, similarity, isLLMEnabled } from './llm.js';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = join(__dirname, '..', 'data', 'uploads');

const app = express();
// 파일/이미지를 base64로 받을 수 있도록 바디 한도를 넉넉히 설정 (기본 100kb → 25mb).
app.use(express.json({ limit: '25mb' }));
app.use(express.static(join(__dirname, '..', 'public')));
// 업로드된 파일 서빙
app.use('/uploads', express.static(UPLOAD_DIR));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// workspaceId -> Set<WebSocket>
const rooms = new Map();

function joinRoom(wsId, socket) {
  if (!rooms.has(wsId)) rooms.set(wsId, new Set());
  rooms.get(wsId).add(socket);
}

function broadcast(wsId, event) {
  const room = rooms.get(wsId);
  if (!room) return;
  const payload = JSON.stringify(event);
  for (const socket of room) {
    if (socket.readyState === socket.OPEN) socket.send(payload);
  }
}

wss.on('connection', (socket) => {
  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'subscribe' && msg.workspaceId) {
        socket.workspaceId = msg.workspaceId;
        joinRoom(msg.workspaceId, socket);
      }
    } catch {
      /* ignore malformed */
    }
  });
  socket.on('close', () => {
    if (socket.workspaceId) rooms.get(socket.workspaceId)?.delete(socket);
  });
});

// ---------- 헬퍼 ----------
function notFound(res, what = '리소스') {
  return res.status(404).json({ error: `${what}를 찾을 수 없습니다.` });
}
function badRequest(res, msg) {
  return res.status(400).json({ error: msg });
}

// LLM 활성화 여부 (프론트에서 표시용)
app.get('/api/llm-status', (req, res) => {
  res.json({ enabled: isLLMEnabled() });
});

// ---------- Workspace ----------
app.post('/api/workspaces', (req, res) => {
  const { name, hostName } = req.body || {};
  const { workspace, host } = store.createWorkspace(name, hostName);
  res.status(201).json({ workspace, you: host });
});

app.get('/api/workspaces/:id', (req, res) => {
  const ws = store.getWorkspace(req.params.id);
  if (!ws) return notFound(res, '워크스페이스');
  res.json(ws);
});

// ---------- Participant (초대/입장/재입장) ----------
// participantId를 함께 보내면 기존 신원으로 재입장(기록 유지), 없으면 새로 참여.
app.post('/api/workspaces/:id/participants', (req, res) => {
  const { name, participantId } = req.body || {};
  const result = store.rejoin(req.params.id, { participantId, name });
  if (!result) return notFound(res, '워크스페이스');
  if (result.isNew) {
    broadcast(req.params.id, { type: 'participant_joined', participant: result.participant });
  }
  res.status(result.isNew ? 201 : 200).json({
    participant: result.participant,
    workspace: store.getWorkspace(req.params.id),
    rejoined: !result.isNew,
  });
});

// ---------- Topic ----------
app.post('/api/workspaces/:id/topics', async (req, res) => {
  const { title, createdBy, parentId, x, y, color } = req.body || {};
  if (!title) return badRequest(res, 'title은 필수입니다.');
  const topic = store.createTopic(req.params.id, {
    title,
    createdBy,
    parentId: parentId ?? null,
    x,
    y,
    color,
  });
  if (!topic) return notFound(res, '워크스페이스 또는 상위 토픽');
  broadcast(req.params.id, { type: 'topic_created', topic });
  res.status(201).json(topic);
});

// 토픽 위치/색상/사진/제목 수정 (Miro 스타일 드래그·꾸미기)
app.patch('/api/workspaces/:id/topics/:topicId', (req, res) => {
  const { x, y, color, imageUrl, title } = req.body || {};
  const topic = store.updateTopic(req.params.id, req.params.topicId, { x, y, color, imageUrl, title });
  if (!topic) return notFound(res, '토픽');
  broadcast(req.params.id, { type: 'topic_updated', topic });
  res.json(topic);
});

// 하위 토픽 참여/탈퇴 (스토리보드 5)
app.post('/api/workspaces/:id/topics/:topicId/join', (req, res) => {
  const { participantId } = req.body || {};
  const topic = store.joinTopic(req.params.id, req.params.topicId, participantId);
  if (!topic) return notFound(res, '토픽');
  broadcast(req.params.id, { type: 'topic_updated', topic });
  res.json(topic);
});

app.post('/api/workspaces/:id/topics/:topicId/leave', (req, res) => {
  const { participantId } = req.body || {};
  const topic = store.leaveTopic(req.params.id, req.params.topicId, participantId);
  if (!topic) return notFound(res, '토픽');
  broadcast(req.params.id, { type: 'topic_updated', topic });
  res.json(topic);
});

// LLM: 하위 토픽 추천 (스토리보드 7)
app.get('/api/workspaces/:id/topics/:topicId/suggest-subtopics', async (req, res) => {
  const topic = store.getTopic(req.params.id, req.params.topicId);
  if (!topic) return notFound(res, '토픽');
  const result = await suggestSubtopics(topic.title, topic.opinions);
  res.json(result);
});

// ---------- File Upload (의견 첨부 파일/문서/이미지) ----------
// base64 데이터로 파일을 받아 서버 디스크에 저장하고 접근 URL을 돌려준다.
// (외부 의존성 없이 동작하도록 multipart 대신 base64 JSON 방식 사용)
app.post('/api/upload', async (req, res) => {
  try {
    const { name, mime, dataBase64 } = req.body || {};
    if (!dataBase64) return badRequest(res, 'dataBase64는 필수입니다.');
    const buffer = Buffer.from(dataBase64, 'base64');
    const MAX = 20 * 1024 * 1024; // 20MB 제한
    if (buffer.length > MAX) return badRequest(res, '파일이 너무 큽니다 (최대 20MB).');
    if (!existsSync(UPLOAD_DIR)) await mkdir(UPLOAD_DIR, { recursive: true });
    // 원본 파일명은 표시용으로만 보존, 실제 저장명은 UUID로 안전하게 (경로 조작 방지)
    const safeOrig = (name || 'file').replace(/[^\w.\-가-힣]/g, '_');
    const ext = safeOrig.includes('.') ? '.' + safeOrig.split('.').pop() : '';
    const stored = randomUUID() + ext;
    await writeFile(join(UPLOAD_DIR, stored), buffer);
    const attachment = {
      id: randomUUID(),
      name: safeOrig,
      url: `/uploads/${stored}`,
      size: buffer.length,
      mime: mime || 'application/octet-stream',
    };
    res.status(201).json(attachment);
  } catch (err) {
    console.error('[upload] 실패:', err.message);
    res.status(500).json({ error: '업로드 실패: ' + err.message });
  }
});

// ---------- Opinion ----------
app.post('/api/workspaces/:id/topics/:topicId/opinions', async (req, res) => {
  const { authorId, content, attachments } = req.body || {};
  // 파일만 첨부하고 텍스트가 비어도 허용 (문서 공유 목적)
  if (!content && !(Array.isArray(attachments) && attachments.length)) {
    return badRequest(res, 'content 또는 첨부파일이 필요합니다.');
  }
  const topic = store.getTopic(req.params.id, req.params.topicId);
  if (!topic) return notFound(res, '토픽');

  // 저장 전에 기존 의견과의 중복/상충 분석 (스토리보드 7)
  const existing = topic.opinions.slice();
  const analysis = await checkOpinions(content || '', existing);

  const opinion = store.addOpinion(req.params.id, req.params.topicId, {
    authorId,
    content: content || '',
    attachments,
  });
  const updatedTopic = store.getTopic(req.params.id, req.params.topicId);

  // 의견이 올라오면 알람 broadcast (스토리보드 8)
  broadcast(req.params.id, {
    type: 'opinion_added',
    topicId: req.params.topicId,
    opinion,
    analysis,
    topic: updatedTopic,
  });

  res.status(201).json({ opinion, analysis });
});

// LLM: 두 텍스트 유사도 확인 (스토리보드 7)
app.post('/api/similarity', (req, res) => {
  const { a, b } = req.body || {};
  res.json({ similarity: similarity(a || '', b || '') });
});

// ---------- Comment ----------
app.post('/api/workspaces/:id/topics/:topicId/opinions/:opinionId/comments', (req, res) => {
  const { authorId, content } = req.body || {};
  if (!content) return badRequest(res, 'content는 필수입니다.');
  const result = store.addComment(req.params.id, req.params.topicId, req.params.opinionId, {
    authorId,
    content,
  });
  if (!result) return notFound(res, '토픽 또는 의견');
  broadcast(req.params.id, {
    type: 'comment_added',
    topicId: req.params.topicId,
    opinionId: req.params.opinionId,
    comment: result.comment,
  });
  res.status(201).json(result.comment);
});

// ---------- Check / Decision ----------
app.post('/api/workspaces/:id/topics/:topicId/check', (req, res) => {
  const { participantId } = req.body || {};
  const topic = store.toggleCheck(req.params.id, req.params.topicId, participantId);
  if (!topic) return notFound(res, '토픽');
  broadcast(req.params.id, {
    type: 'topic_updated',
    topic,
    workspace: store.getWorkspace(req.params.id),
  });
  res.json(topic);
});

// ---------- LLM 요약 (스토리보드 12, 13) ----------
app.get('/api/workspaces/:id/summary', async (req, res) => {
  const ws = store.getWorkspace(req.params.id);
  if (!ws) return notFound(res, '워크스페이스');
  const result = await summarizeWorkspace(ws);
  res.json(result);
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, '..', 'public', 'index.html'));
});

async function main() {
  await store.load();
  httpServer.listen(PORT, () => {
    console.log(`협업 회의 플랫폼 서버 실행: http://localhost:${PORT}`);
    console.log(
      process.env.OPENAI_API_KEY
        ? '[llm] OpenAI 연동 활성화'
        : '[llm] 규칙 기반 폴백 모드 (OPENAI_API_KEY 미설정)',
    );
  });
}

main();

export { app, store };
