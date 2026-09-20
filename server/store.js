// server/store.js
// 인메모리 + JSON 파일 영속성을 가진 간단한 데이터 저장소.
// 도메인 모델:
//   Workspace  : 회의 워크스페이스. 참여자와 토픽 트리를 가진다.
//   Participant: 워크스페이스 참여자.
//   Topic      : 안건/하위 토픽. 트리 구조(parentId). 의견을 가진다.
//   Opinion    : 토픽에 대한 의견. 코멘트를 가진다.
//   Comment    : 의견에 대한 코멘트.
//   결정 상태  : 토픽에 참여한 인원 전부가 체크하고, 모든 하위 토픽이 결정되면 "decided".

import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DATA_FILE = join(DATA_DIR, 'db.json');

/** @typedef {{id:string,name:string,createdAt:string,participants:Participant[],topics:Topic[]}} Workspace */
/** @typedef {{id:string,name:string,role:'host'|'member'}} Participant */
/** @typedef {{id:string,parentId:string|null,title:string,createdBy:string,createdAt:string,members:string[],checks:string[],status:'open'|'decided',opinions:Opinion[],x:number,y:number,color:string,imageUrl:string|null,document:string,documentUpdatedAt:string|null}} Topic */
/** @typedef {{id:string,topicId:string,authorId:string,title:string,content:string,createdAt:string,comments:Comment[],attachments:Attachment[]}} Opinion */
/** @typedef {{id:string,authorId:string,content:string,createdAt:string}} Comment */
/** @typedef {{id:string,name:string,url:string,size:number,mime:string}} Attachment */

// 노드 색상 팔레트 (Miro 스타일 원형 노드용)
const TOPIC_COLORS = ['#6b5cff', '#22a06b', '#f0a020', '#e0563f', '#0ea5e9', '#a855f7', '#ec4899', '#14b8a6'];

class Store {
  constructor() {
    /** @type {Map<string, Workspace>} */
    this.workspaces = new Map();
    this._saveTimer = null;
  }

  async load() {
    if (existsSync(DATA_FILE)) {
      try {
        const raw = await readFile(DATA_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        for (const ws of parsed.workspaces ?? []) {
          // 구버전 데이터 호환: 신규 필드 기본값 보정
          for (const t of ws.topics ?? []) {
            if (typeof t.x !== 'number') t.x = 160 + Math.random() * 400;
            if (typeof t.y !== 'number') t.y = 140 + Math.random() * 300;
            if (!t.color) t.color = TOPIC_COLORS[Math.floor(Math.random() * TOPIC_COLORS.length)];
            if (t.imageUrl === undefined) t.imageUrl = null;
            if (typeof t.document !== 'string') t.document = '';
            if (t.documentUpdatedAt === undefined) t.documentUpdatedAt = null;
            for (const op of t.opinions ?? []) {
              if (!Array.isArray(op.attachments)) op.attachments = [];
              if (typeof op.title !== 'string') op.title = '';
            }
          }
          this.workspaces.set(ws.id, ws);
        }
      } catch (err) {
        console.error('[store] 데이터 로드 실패, 빈 상태로 시작합니다:', err.message);
      }
    }
  }

  async persist() {
    // 짧은 시간에 여러 변경이 발생할 때 디스크 쓰기를 debounce.
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(async () => {
      try {
        if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
        const data = { workspaces: [...this.workspaces.values()] };
        await writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
      } catch (err) {
        console.error('[store] 데이터 저장 실패:', err.message);
      }
    }, 150);
  }

  // ---- Workspace ----
  createWorkspace(name, hostName) {
    const host = { id: randomUUID(), name: hostName || '방장', role: 'host' };
    /** @type {Workspace} */
    const ws = {
      id: randomUUID(),
      name: name || '새 워크스페이스',
      createdAt: new Date().toISOString(),
      participants: [host],
      topics: [],
    };
    this.workspaces.set(ws.id, ws);
    this.persist();
    return { workspace: ws, host };
  }

  getWorkspace(id) {
    return this.workspaces.get(id) || null;
  }

  // ---- Participant ----
  addParticipant(wsId, name) {
    const ws = this.getWorkspace(wsId);
    if (!ws) return null;
    const participant = { id: randomUUID(), name: name || '참여자', role: 'member' };
    ws.participants.push(participant);
    this.persist();
    return participant;
  }

  getParticipant(wsId, participantId) {
    const ws = this.getWorkspace(wsId);
    if (!ws) return null;
    return ws.participants.find((p) => p.id === participantId) || null;
  }

  // 재입장: 기존 participantId가 유효하면 그 신원을 그대로 돌려주고(기록 유지),
  // 아니면 새 참여자로 등록한다. 이름이 바뀌었으면 갱신한다.
  rejoin(wsId, { participantId, name }) {
    const ws = this.getWorkspace(wsId);
    if (!ws) return null;
    if (participantId) {
      const existing = ws.participants.find((p) => p.id === participantId);
      if (existing) {
        if (name && name !== existing.name) {
          existing.name = name;
          this.persist();
        }
        return { participant: existing, isNew: false };
      }
    }
    const participant = this.addParticipant(wsId, name);
    return { participant, isNew: true };
  }

  // ---- Topic ----
  createTopic(wsId, { title, createdBy, parentId = null, x, y, color }) {
    const ws = this.getWorkspace(wsId);
    if (!ws) return null;
    if (parentId && !ws.topics.find((t) => t.id === parentId)) return null;
    // 위치 자동 배치: 부모가 있으면 부모 근처, 없으면 기존 노드 개수 기반으로 흩뿌린다.
    const parent = parentId ? ws.topics.find((t) => t.id === parentId) : null;
    const siblingCount = ws.topics.filter((t) => t.parentId === parentId).length;
    const autoX = parent
      ? (parent.x ?? 200) + 220
      : 160 + (siblingCount % 3) * 240;
    const autoY = parent
      ? (parent.y ?? 200) + (siblingCount - 1) * 130
      : 140 + Math.floor(siblingCount) * 150;
    /** @type {Topic} */
    const topic = {
      id: randomUUID(),
      parentId,
      title,
      createdBy,
      createdAt: new Date().toISOString(),
      // 토픽 참여는 각자 "선택"한다. 생성자를 자동 참여시키지 않는다.
      members: [],
      checks: [],
      status: 'open',
      opinions: [],
      // Miro 스타일 캔버스 배치/스타일
      x: typeof x === 'number' ? x : autoX,
      y: typeof y === 'number' ? y : autoY,
      color: color || TOPIC_COLORS[ws.topics.length % TOPIC_COLORS.length],
      imageUrl: null,
      // Notion 스타일 토픽 문서 (마크다운 본문)
      document: '',
      documentUpdatedAt: null,
    };
    ws.topics.push(topic);
    this.persist();
    return topic;
  }

  // 토픽 위치/스타일/문서 수정 (Miro 드래그·색상·사진 + Notion 문서)
  updateTopic(wsId, topicId, { x, y, color, imageUrl, title, document } = {}) {
    const topic = this.getTopic(wsId, topicId);
    if (!topic) return null;
    if (typeof x === 'number') topic.x = x;
    if (typeof y === 'number') topic.y = y;
    if (typeof color === 'string') topic.color = color;
    if (imageUrl !== undefined) topic.imageUrl = imageUrl;
    if (typeof title === 'string' && title.trim()) topic.title = title.trim();
    if (typeof document === 'string') {
      topic.document = document;
      topic.documentUpdatedAt = new Date().toISOString();
    }
    this.persist();
    return topic;
  }

  getTopic(wsId, topicId) {
    const ws = this.getWorkspace(wsId);
    if (!ws) return null;
    return ws.topics.find((t) => t.id === topicId) || null;
  }

  // 토픽과 그 모든 하위 토픽(자손)을 재귀적으로 삭제한다.
  deleteTopic(wsId, topicId) {
    const ws = this.getWorkspace(wsId);
    if (!ws) return null;
    const target = ws.topics.find((t) => t.id === topicId);
    if (!target) return null;
    // 삭제할 모든 자손 id 수집 (BFS)
    const toDelete = new Set([topicId]);
    let added = true;
    while (added) {
      added = false;
      for (const t of ws.topics) {
        if (t.parentId && toDelete.has(t.parentId) && !toDelete.has(t.id)) {
          toDelete.add(t.id);
          added = true;
        }
      }
    }
    ws.topics = ws.topics.filter((t) => !toDelete.has(t.id));
    // 부모의 완료 상태가 바뀔 수 있으므로 재계산
    this.recomputeDecisions(wsId);
    this.persist();
    return { deletedIds: [...toDelete], parentId: target.parentId };
  }

  // 의견 삭제
  deleteOpinion(wsId, topicId, opinionId) {
    const topic = this.getTopic(wsId, topicId);
    if (!topic) return null;
    const before = topic.opinions.length;
    topic.opinions = topic.opinions.filter((o) => o.id !== opinionId);
    if (topic.opinions.length === before) return null; // 없던 의견
    this.recomputeDecisions(wsId);
    this.persist();
    return topic;
  }

  // 하위 토픽에 참여할지 선택 (스토리보드 5번)
  joinTopic(wsId, topicId, participantId) {
    const topic = this.getTopic(wsId, topicId);
    if (!topic) return null;
    if (participantId && !topic.members.includes(participantId)) {
      topic.members.push(participantId);
      // 새 참여자는 아직 찬성 투표를 하지 않았으므로, 완료 상태였다면 해제되어야 한다.
      // (참여자 전원 찬성 조건이 다시 충족되어야 완료됨)
      this.recomputeDecisions(wsId);
      this.persist();
    }
    return topic;
  }

  leaveTopic(wsId, topicId, participantId) {
    const topic = this.getTopic(wsId, topicId);
    if (!topic) return null;
    topic.members = topic.members.filter((m) => m !== participantId);
    topic.checks = topic.checks.filter((c) => c !== participantId);
    this.recomputeDecisions(wsId);
    this.persist();
    return topic;
  }

  // ---- Opinion ----
  addOpinion(wsId, topicId, { authorId, title = '', content, attachments = [] }) {
    const topic = this.getTopic(wsId, topicId);
    if (!topic) return null;
    /** @type {Opinion} */
    const opinion = {
      id: randomUUID(),
      topicId,
      authorId,
      title: (title || '').trim(),
      content,
      createdAt: new Date().toISOString(),
      comments: [],
      attachments: Array.isArray(attachments) ? attachments : [],
    };
    topic.opinions.push(opinion);
    // 의견을 냈다는 것은 이 토픽 논의에 참여한다는 의미이므로 멤버로 보장한다.
    if (authorId && !topic.members.includes(authorId)) topic.members.push(authorId);
    // 새 의견이 올라오면 체크가 무효화되어 다시 논의가 필요 (스토리보드 10)
    topic.checks = [];
    if (topic.status === 'decided') topic.status = 'open';
    this.recomputeDecisions(wsId);
    this.persist();
    return opinion;
  }

  // ---- Comment ----
  addComment(wsId, topicId, opinionId, { authorId, content }) {
    const topic = this.getTopic(wsId, topicId);
    if (!topic) return null;
    const opinion = topic.opinions.find((o) => o.id === opinionId);
    if (!opinion) return null;
    /** @type {Comment} */
    const comment = { id: randomUUID(), authorId, content, createdAt: new Date().toISOString() };
    opinion.comments.push(comment);
    this.persist();
    return { topic, opinion, comment };
  }

  // 의견 수정 (제목/본문)
  updateOpinion(wsId, topicId, opinionId, { title, content }) {
    const topic = this.getTopic(wsId, topicId);
    if (!topic) return null;
    const opinion = topic.opinions.find((o) => o.id === opinionId);
    if (!opinion) return null;
    if (typeof title === 'string') opinion.title = title.trim();
    if (typeof content === 'string') opinion.content = content;
    opinion.editedAt = new Date().toISOString();
    this.persist();
    return { topic, opinion };
  }

  // 댓글 수정 (내용)
  updateComment(wsId, topicId, opinionId, commentId, { content }) {
    const topic = this.getTopic(wsId, topicId);
    if (!topic) return null;
    const opinion = topic.opinions.find((o) => o.id === opinionId);
    if (!opinion) return null;
    const comment = opinion.comments.find((c) => c.id === commentId);
    if (!comment) return null;
    if (typeof content === 'string') comment.content = content;
    comment.editedAt = new Date().toISOString();
    this.persist();
    return { topic, opinion, comment };
  }

  // 댓글 삭제
  deleteComment(wsId, topicId, opinionId, commentId) {
    const topic = this.getTopic(wsId, topicId);
    if (!topic) return null;
    const opinion = topic.opinions.find((o) => o.id === opinionId);
    if (!opinion) return null;
    const before = opinion.comments.length;
    opinion.comments = opinion.comments.filter((c) => c.id !== commentId);
    if (opinion.comments.length === before) return null;
    this.persist();
    return { topic, opinion };
  }

  // ---- Check / Decision ----
  toggleCheck(wsId, topicId, participantId) {
    const topic = this.getTopic(wsId, topicId);
    if (!topic) return null;
    if (topic.checks.includes(participantId)) {
      topic.checks = topic.checks.filter((c) => c !== participantId);
    } else {
      topic.checks.push(participantId);
    }
    this.recomputeDecisions(wsId);
    this.persist();
    return topic;
  }

  // 결정(완료) 상태 재계산.
  // 요구사항: "토픽에 참여한 모든 인원이 찬성 투표(check)를 했고,
  //            그 하위 토픽이 모두 완료(decided)이거나 해당 토픽이 최하단 토픽인 경우에만 완료된다."
  // 트리 하단부터 위로 수렴시키기 위해 반복한다.
  recomputeDecisions(wsId) {
    const ws = this.getWorkspace(wsId);
    if (!ws) return;
    let changed = true;
    let guard = 0;
    while (changed && guard < ws.topics.length + 1) {
      changed = false;
      guard += 1;
      for (const topic of ws.topics) {
        const children = ws.topics.filter((t) => t.parentId === topic.id);
        const hasChildren = children.length > 0;
        const isLeaf = !hasChildren; // 최하단 토픽 여부
        const allChildrenDecided = children.every((c) => c.status === 'decided');
        const hasMembers = topic.members.length > 0;
        const allMembersVoted =
          hasMembers && topic.members.every((m) => topic.checks.includes(m));

        // 하위 조건: 최하단이거나(=하위 없음) 모든 하위가 완료됨.
        const subtreeReady = isLeaf || allChildrenDecided;

        let shouldDecide;
        if (hasMembers) {
          // 참여자가 있으면 전원 찬성 투표 + 하위 조건 충족.
          shouldDecide = allMembersVoted && subtreeReady;
        } else {
          // 직접 참여자가 없는 순수 컨테이너 토픽: 하위가 있고 모두 완료되면 완료로 본다.
          // (참여자도 없고 하위도 없는 빈 토픽은 완료로 보지 않는다.)
          shouldDecide = hasChildren && allChildrenDecided;
        }
        const next = shouldDecide ? 'decided' : 'open';
        if (topic.status !== next) {
          topic.status = next;
          changed = true;
        }
      }
    }
  }
}

export const store = new Store();
export { Store };
