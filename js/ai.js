// Разговор с ИИ поверх собственной памяти.
//
// Три режима, потому что три реальных ситуации:
//
// 1. ПАКЕТ — приложение собирает готовый контекст (вопрос + найденные фрагменты
//    + правило «нет в памяти — так и скажи») и кладёт в буфер обмена. Дальше
//    его можно вставить в любой чат: Claude, ChatGPT, что угодно. Работает
//    всегда, ничего не стоит, ключ не нужен. Это основной режим.
// 2. ЗДЕСЬ — прямой вызов Messages API из браузера. Нужен ключ Anthropic
//    (отдельная оплата, подписка Claude его не даёт). Ключ живёт только в
//    localStorage этого устройства — как и секрет воркера.
// 3. MCP — вальт уже подключается к Claude и другим ИИ как MCP-сервер; экран
//    «подключить ИИ» отдаёт адрес и конфиг, чтобы не искать их по заметкам.
//
// Ключ в браузере — осознанный компромисс, и документация Anthropic называет
// его опасным: любой, у кого есть доступ к устройству, может его достать.
// Поэтому режим 2 включается только вручную, а приложение полноценно работает
// и без него.
import { corpus, searchCorpus } from './corpus.js';
import { MODEL, AI_URL, AI_VERSION } from './config.js';

const LS_KEY = 'shards.ai';
export const getAiSettings = () => { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; } };
export const saveAiSettings = s => localStorage.setItem(LS_KEY, JSON.stringify({ ...getAiSettings(), ...s }));
export const forgetKey = () => saveAiSettings({ key: '' });

/* ── пакет контекста ──────────────────────────────────────────────────────── */

// Правило взято из самой системы памяти: индекс механический, выдумать факт он
// не может — а вот отвечающий может достроить ответ по догадке. Поэтому запрет
// на догадку идёт в промпт явно.
export const SYSTEM_PROMPT = `Ты отвечаешь на вопросы по личной памяти Александра — обсидиан-вальту, который он ведёт годами.

Правила:
- Отвечай ТОЛЬКО по приведённым фрагментам. Если прямого ответа в них нет — так и скажи: «этого в памяти нет». Не достраивай ответ по догадке и не смешивай факты из разных заметок в одно утверждение.
- Ссылайся на источник: путь заметки в скобках после утверждения.
- Отвечай по-русски, коротко и по делу. Даты — как в заметках.
- Если фрагменты противоречат друг другу, скажи об этом прямо и покажи оба.`;

// Сколько фрагментов класть в пакет: больше — точнее, но дороже и медленнее.
const DEFAULT_LIMIT = 8;

export function buildContext(question, { limit = DEFAULT_LIMIT, full = false } = {}) {
  const { results } = searchCorpus(question, limit);
  const parts = results.map(r => {
    const note = corpus.byPath.get(r.path);
    const body = full && note ? note.text : r.frag;
    const head = r.chain ? `${r.path} › ${r.chain}` : r.path;
    return `--- ${head} ---\n${body}`;
  });
  return {
    results,
    text: parts.join('\n\n'),
    tokensRough: Math.round(parts.join('\n\n').length / 3),
  };
}

// Готовый текст для вставки в любой чат: инструкция, фрагменты, вопрос.
export const packForChat = (question, ctx) =>
  `${SYSTEM_PROMPT}\n\n=== ФРАГМЕНТЫ ИЗ ПАМЯТИ ===\n\n${ctx.text}\n\n=== ВОПРОС ===\n\n${question}`;

/* ── прямой вызов Messages API ────────────────────────────────────────────── */

// Быстро — извлечение из готовых фрагментов, тут думать особо не над чем.
// Тщательно — адаптивное мышление, когда нужно сопоставить противоречия.
export const MODES = {
  fast: { label: 'БЫСТРО', body: { output_config: { effort: 'low' }, thinking: { type: 'disabled' }, max_tokens: 4000 } },
  deep: { label: 'ТЩАТЕЛЬНО', body: { output_config: { effort: 'high' }, thinking: { type: 'adaptive' }, max_tokens: 16000 } },
};

export class AiError extends Error {}

// Стриминг обязателен: ответ идёт по мере генерации, и длинный разбор не
// упирается в таймаут соединения.
export async function askClaude(question, ctx, { mode = 'fast', onText, signal } = {}) {
  const { key } = getAiSettings();
  if (!key) throw new AiError('нет ключа Anthropic — режим «здесь» недоступен');
  const m = MODES[mode] || MODES.fast;

  let res;
  try {
    res = await fetch(AI_URL, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': AI_VERSION,
        // Тот же заголовок, что SDK ставит при dangerouslyAllowBrowser —
        // без него браузерный запрос отсекается ещё на CORS-проверке.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `=== ФРАГМЕНТЫ ИЗ ПАМЯТИ ===\n\n${ctx.text}\n\n=== ВОПРОС ===\n\n${question}`,
        }],
        ...m.body,
      }),
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new AiError('браузер не пустил запрос к api.anthropic.com (сеть или CORS)');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 401) throw new AiError('ключ Anthropic не принят (401)');
    if (res.status === 429) throw new AiError('лимит запросов (429) — подождите минуту');
    throw new AiError(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  // Разбор SSE: интересуют только текстовые дельты и признак отказа.
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', out = '', stop = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      let ev;
      try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        out += ev.delta.text;
        onText && onText(ev.delta.text, out);
      } else if (ev.type === 'message_delta' && ev.delta?.stop_reason) {
        stop = ev.delta.stop_reason;
      } else if (ev.type === 'error') {
        throw new AiError(ev.error?.message || 'ошибка потока');
      }
    }
  }
  // Отказ приходит как обычный ответ со stop_reason: "refusal" — не как ошибка.
  if (stop === 'refusal') throw new AiError('модель отклонила запрос (refusal)');
  return { text: out, stop };
}

/* ── подключение вальта к другим ИИ ───────────────────────────────────────── */

// Вальт уже отдаётся как MCP-сервер — приложение просто показывает, куда
// смотреть, чтобы не искать адрес по заметкам с телефона.
export const mcpConfig = url => JSON.stringify({
  mcpServers: {
    'vault-memory': {
      type: 'http',
      url: url || '',
      headers: { Authorization: 'Bearer ВАШ_СЕКРЕТ' },
    },
  },
}, null, 2);
