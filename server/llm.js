// server/llm.js
// LLM 보조 기능. 외부 API 키(OPENAI_API_KEY)가 있으면 LLM을 호출하고,
// 없으면 규칙 기반(rule-based) 폴백으로 동일한 인터페이스를 제공한다.
// 이렇게 하면 키 없이도 전체 데모가 동작한다.
//
// 제공 기능 (topic.md 7번, 12번, 13번):
//   - checkOpinions(): 상충/중복 의견 감지, 유사도 계산
//   - suggestSubtopics(): 하위 토픽 추천
//   - summarizeWorkspace(): 결정된 토픽을 마크다운으로 정리 + 미결정 안건 목록

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
// OpenAI 호환 API(Azure OpenAI, Groq, Together, 로컬 LLM 등)를 위한 base URL 설정.
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');

export function isLLMEnabled() {
  return Boolean(OPENAI_API_KEY);
}

// ---------- 텍스트 유사도 (규칙 기반) ----------

const STOPWORDS = new Set([
  '그', '이', '저', '것', '수', '및', '등', '을', '를', '은', '는', '이다', '하다',
  '의', '가', '에', '에서', '으로', '로', '와', '과', '도', '하자', '하고', '한다',
]);

// 한국어 조사/어미 목록. 어절 끝에서 제거하여 어간을 정규화한다.
// 예: "사용하자" → "사용", "C++을" → "c++", "기후를" → "기후"
const JOSA_EOMI = [
  '으로써', '으로서', '에서는', '에게서', '이라고', '라고', '으로', '에서', '에게',
  '까지', '부터', '보다', '처럼', '만큼', '이나', '이란', '이라', '하자', '하고',
  '한다', '하는', '하여', '해서', '했다', '한', '할', '함', '을', '를', '은', '는',
  '이', '가', '에', '와', '과', '도', '의', '만', '로', '고', '며', '지', '해',
];

// 어절에서 뒤쪽 조사/어미를 한 번 벗겨 어간에 가깝게 만든다.
function stem(word) {
  for (const suf of JOSA_EOMI) {
    if (word.length > suf.length && word.endsWith(suf)) {
      return word.slice(0, word.length - suf.length);
    }
  }
  return word;
}

// "C++을", "AI는" 처럼 영문/기호 어간 뒤에 한글 조사가 붙은 경우 조사만 제거한다.
// 예: "c++을" → "c++", "ai는" → "ai"
function stripKoreanSuffix(word) {
  const m = /^([a-z0-9+#.]+)([\uac00-\ud7a3]+)$/.exec(word);
  if (m) return m[1];
  return word;
}

function tokenize(text) {
  // 기호를 공백으로 바꾸되, 기술 용어에서 의미가 있는 + # . 는 보존한다 (C++, C#, node.js).
  const cleaned = (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.\s]/gu, ' ');
  return cleaned
    .split(/\s+/)
    .map((w) => w.replace(/^[.]+|[.]+$/g, '')) // 앞뒤 마침표 제거 (문장부호로 쓰인 경우)
    .filter(Boolean)
    .map((w) => (/[+#]/.test(w) ? stripKoreanSuffix(w) : stem(w))) // 기술용어는 조사만, 그 외 어간처리
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

// 문자 단위 bigram 집합. 조사/어미가 남아도 부분 일치를 잡아낸다.
function bigrams(text) {
  const s = (text || '').toLowerCase().replace(/\s+/g, '');
  const grams = new Set();
  for (let i = 0; i < s.length - 1; i++) grams.add(s.slice(i, i + 2));
  return grams;
}

function jaccard(sa, sb) {
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// 자카드 유사도 (0~1).
// 어절(어간) 자카드와 문자 bigram 자카드를 결합해 한국어 어미 변화에 강건하게 만든다.
export function similarity(a, b) {
  const tokenSim = jaccard(new Set(tokenize(a)), new Set(tokenize(b)));
  const gramSim = jaccard(bigrams(a), bigrams(b));
  // 어절 일치를 우선(가중치 0.6)하되, bigram으로 보강(0.4).
  return Math.max(tokenSim, tokenSim * 0.6 + gramSim * 0.4);
}

// 상충(반대) 신호 감지: 부정/반대 키워드가 한쪽에만 있으면서 주제어가 겹치는 경우.
const NEGATION = ['반대', '아니', '안 ', '하지 말', '별로', '싫', '문제', '어렵', '위험', '비추'];

function hasNegation(text) {
  const t = (text || '').toLowerCase();
  return NEGATION.some((n) => t.includes(n));
}

// 두 텍스트가 공유하는 어간 토큰 (핵심어 겹침 판정용)
function sharedTokens(a, b) {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  const shared = [];
  for (const t of sa) if (sb.has(t)) shared.push(t);
  return shared;
}

// ---------- 공개 함수 ----------

// 새 의견이 기존 의견들과 중복/상충되는지 분석
export async function checkOpinions(newContent, existingOpinions) {
  if (OPENAI_API_KEY) {
    try {
      return await llmCheckOpinions(newContent, existingOpinions);
    } catch (err) {
      console.error('[llm] checkOpinions LLM 실패, 폴백 사용:', err.message);
    }
  }
  return ruleCheckOpinions(newContent, existingOpinions);
}

function ruleCheckOpinions(newContent, existingOpinions) {
  const results = [];
  for (const op of existingOpinions) {
    const sim = similarity(newContent, op.content);
    const shared = sharedTokens(newContent, op.content);
    const negationDiffers = hasNegation(newContent) !== hasNegation(op.content);
    if (sim >= 0.5) {
      results.push({ opinionId: op.id, type: 'duplicate', similarity: sim, shared });
    } else if (negationDiffers && (sim >= 0.2 || shared.length > 0)) {
      // 부정 신호가 한쪽에만 있고, 유사하거나 핵심어를 공유하면 상충으로 본다.
      // 예: "C++을 사용하자" vs "C++은 반대" → 'c++' 공유 + 한쪽만 부정 → conflict
      results.push({ opinionId: op.id, type: 'conflict', similarity: sim, shared });
    } else if (sim >= 0.3) {
      results.push({ opinionId: op.id, type: 'related', similarity: sim, shared });
    }
  }
  results.sort((a, b) => b.similarity - a.similarity);
  const summary = buildCheckSummary(results);
  return { engine: 'rule', results, summary };
}

function buildCheckSummary(results) {
  const dup = results.filter((r) => r.type === 'duplicate').length;
  const conf = results.filter((r) => r.type === 'conflict').length;
  if (dup === 0 && conf === 0) return '기존 의견과 큰 충돌이나 중복이 없습니다.';
  const parts = [];
  if (dup) parts.push(`중복 가능성이 있는 의견 ${dup}건`);
  if (conf) parts.push(`상충 가능성이 있는 의견 ${conf}건`);
  return parts.join(', ') + '이 감지되었습니다.';
}

// 토픽 제목과 기존 의견을 바탕으로 하위 토픽 추천
export async function suggestSubtopics(topicTitle, opinions) {
  if (OPENAI_API_KEY) {
    try {
      return await llmSuggestSubtopics(topicTitle, opinions);
    } catch (err) {
      console.error('[llm] suggestSubtopics LLM 실패, 폴백 사용:', err.message);
    }
  }
  return ruleSuggestSubtopics(topicTitle, opinions);
}

function ruleSuggestSubtopics(topicTitle, opinions) {
  // 의견에서 빈도가 높은 키워드를 뽑아 하위 토픽 후보로 제시.
  const freq = new Map();
  for (const op of opinions) {
    for (const tok of tokenize(op.content)) {
      freq.set(tok, (freq.get(tok) || 0) + 1);
    }
  }
  const topKeywords = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([w]) => w);

  const suggestions = topKeywords.map((k) => `${k} 관련 세부 논의`);
  // 의견이 적을 때를 위한 일반적 템플릿 보강
  const generic = ['필요 자료 조사', '대안 비교', '일정/우선순위'];
  for (const g of generic) {
    if (suggestions.length >= 3) break;
    if (!suggestions.includes(g)) suggestions.push(g);
  }
  return { engine: 'rule', suggestions: suggestions.slice(0, 3) };
}

// 워크스페이스 전체를 마크다운으로 정리 (결정된 토픽 + 미결정 안건)
export async function summarizeWorkspace(workspace) {
  if (OPENAI_API_KEY) {
    try {
      return await llmSummarize(workspace);
    } catch (err) {
      console.error('[llm] summarize LLM 실패, 폴백 사용:', err.message);
    }
  }
  return ruleSummarize(workspace);
}

function participantName(workspace, id) {
  return workspace.participants.find((p) => p.id === id)?.name || '알 수 없음';
}

function ruleSummarize(workspace) {
  const roots = workspace.topics.filter((t) => !t.parentId);
  const lines = [`# ${workspace.name} 회의 정리`, ''];

  const renderTopic = (topic, depth) => {
    const indent = '  '.repeat(depth);
    const badge = topic.status === 'decided' ? '✅ 결정됨' : '🕓 논의 중';
    lines.push(`${indent}- **${topic.title}** (${badge})`);
    for (const op of topic.opinions) {
      lines.push(`${indent}  - 의견 (${participantName(workspace, op.authorId)}): ${op.content}`);
      for (const c of op.comments) {
        lines.push(`${indent}    - 코멘트 (${participantName(workspace, c.authorId)}): ${c.content}`);
      }
    }
    const children = workspace.topics.filter((t) => t.parentId === topic.id);
    for (const child of children) renderTopic(child, depth + 1);
  };

  lines.push('## 결정된 토픽 및 논의 내용', '');
  if (roots.length === 0) lines.push('_아직 토픽이 없습니다._');
  for (const root of roots) renderTopic(root, 0);

  const pending = workspace.topics.filter((t) => t.status !== 'decided');
  lines.push('', '## 회의가 필요한 안건 (미결정)', '');
  if (pending.length === 0) {
    lines.push('_모든 안건이 결정되었습니다. 🎉_');
  } else {
    for (const t of pending) {
      const reason = pendingReason(workspace, t);
      lines.push(`- **${t.title}** — ${reason}`);
    }
  }
  return { engine: 'rule', markdown: lines.join('\n') };
}

function pendingReason(workspace, topic) {
  const children = workspace.topics.filter((t) => t.parentId === topic.id);
  const undecidedChildren = children.filter((c) => c.status !== 'decided');
  if (topic.members.length === 0) return '참여자가 없어 논의가 시작되지 않음';
  const notChecked = topic.members.filter((m) => !topic.checks.includes(m));
  if (notChecked.length > 0) {
    return `${notChecked.length}명이 아직 동의(체크)하지 않음`;
  }
  if (undecidedChildren.length > 0) {
    return `하위 토픽 ${undecidedChildren.length}개가 아직 결정되지 않음`;
  }
  return '추가 논의 필요';
}

// ---------- OpenAI 호출 (키가 있을 때만) ----------

async function callOpenAI(messages, { json = false } = {}) {
  const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      temperature: 0.2,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

async function llmCheckOpinions(newContent, existingOpinions) {
  const list = existingOpinions.map((o, i) => `${i + 1}. [${o.id}] ${o.content}`).join('\n');
  const content = await callOpenAI(
    [
      {
        role: 'system',
        content:
          '너는 회의 의견 분석기다. 새 의견이 기존 의견들과 중복/상충/관련되는지 판단해 JSON으로 답한다. ' +
          '형식: {"results":[{"opinionId":"...","type":"duplicate|conflict|related","similarity":0~1}],"summary":"한국어 한 문장"}',
      },
      { role: 'user', content: `새 의견: ${newContent}\n\n기존 의견들:\n${list || '(없음)'}` },
    ],
    { json: true },
  );
  const parsed = JSON.parse(content);
  return { engine: 'llm', results: parsed.results ?? [], summary: parsed.summary ?? '' };
}

async function llmSuggestSubtopics(topicTitle, opinions) {
  const list = opinions.map((o) => `- ${o.content}`).join('\n');
  const content = await callOpenAI(
    [
      {
        role: 'system',
        content:
          '너는 회의 진행 보조자다. 토픽과 의견을 보고 논의를 나눌 하위 토픽 3개를 추천해 JSON으로 답한다. ' +
          '형식: {"suggestions":["...","...","..."]} (각 항목은 한국어 짧은 구절)',
      },
      { role: 'user', content: `토픽: ${topicTitle}\n의견:\n${list || '(없음)'}` },
    ],
    { json: true },
  );
  const parsed = JSON.parse(content);
  return { engine: 'llm', suggestions: (parsed.suggestions ?? []).slice(0, 3) };
}

async function llmSummarize(workspace) {
  const context = JSON.stringify(
    {
      name: workspace.name,
      participants: workspace.participants.map((p) => ({ id: p.id, name: p.name })),
      topics: workspace.topics,
    },
    null,
    2,
  );
  const content = await callOpenAI([
    {
      role: 'system',
      content:
        '너는 회의록 정리 보조자다. 주어진 워크스페이스(토픽 트리/의견/코멘트/결정상태)를 한국어 마크다운으로 정리한다. ' +
        '결정된 토픽 내용과, 아직 결정되지 않아 회의가 필요한 안건을 구분해서 정리하라.',
    },
    { role: 'user', content: context },
  ]);
  return { engine: 'llm', markdown: content };
}
