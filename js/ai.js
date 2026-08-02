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
import { withSnippets, noteText } from './map.js';
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

export async function buildContext(question, { limit = DEFAULT_LIMIT, full = false } = {}) {
  const { results, terms } = await searchCorpus(question, limit);
  // Фрагмент — это несколько сотен символов вокруг совпадения; «целиком» —
  // вся заметка. Второе точнее и заметно дороже, поэтому включается вручную.
  await withSnippets(results, terms, limit);
  const bodies = await Promise.all(results.map(async r => {
    if (!full) return r.frag || '';
    try { return (await noteText(r.path)).replace(/^---\n[\s\S]*?\n---\n?/, ''); }
    catch { return r.frag || ''; }
  }));
  const parts = results.map((r, i) => {
    const head = r.chain ? `${r.path} › ${r.chain}` : r.path;
    return `--- ${head} ---\n${bodies[i]}`;
  });
  const text = parts.join('\n\n');
  return { results, text, tokensRough: Math.round(text.length / 3) };
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
export const askClaude = (question, ctx, opts = {}) =>
  callClaude(SYSTEM_PROMPT, `=== ФРАГМЕНТЫ ИЗ ПАМЯТИ ===\n\n${ctx.text}\n\n=== ВОПРОС ===\n\n${question}`, opts);

export async function callClaude(system, userContent, { mode = 'fast', onText, signal } = {}) {
  const { key } = getAiSettings();
  if (!key) throw new AiError('нет ключа Anthropic — режим «здесь» недоступен');
  const m = MODES[mode] || MODES.fast;

  // В десктопе запрос уходит из главного процесса: у него нет CORS, поэтому не
  // нужны браузерные послабления, а ключ не светится в сетевом слое страницы.
  if (typeof window !== 'undefined' && window.shardsNative?.ask) {
    const r = await window.shardsNative.ask(key, {
      model: MODEL, stream: true, system,
      messages: [{ role: 'user', content: userContent }], ...m.body,
    }, chunk => onText && onText(chunk, null));
    if (!r.ok) {
      if (r.status === 401) throw new AiError('ключ Anthropic не принят (401)');
      if (r.status === 429) throw new AiError('лимит запросов (429) — подождите минуту');
      throw new AiError(r.text || 'запрос не прошёл');
    }
    if (r.stop === 'refusal') throw new AiError('модель отклонила запрос (refusal)');
    return { text: r.text, stop: r.stop };
  }

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
        model: MODEL, stream: true, system,
        messages: [{ role: 'user', content: userContent }],
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

/* ── помощники ────────────────────────────────────────────────────────────────
   Три вещи, где модель уместна, а механика не справляется: разметить заметку
   словами из уже сложившегося словаря вальта, коротко описать созвездие и
   собрать недельную сводку.

   Каждый помощник — это пара «система + запрос» и разбор ответа. Пара нужна
   отдельно от вызова, потому что без ключа всё то же самое уходит в буфер и
   вставляется в любой чат: помощник не должен быть привилегией платного ключа.

   Отдельное правило во всех промптах — не выдумывать теги. Свежепридуманный тег
   не соединяет заметку ни с чем, он только выглядит как работа. */
export const HELPERS = {
  markup: ({ note, text, tags, neighbours }) => ({
    title: `РАЗМЕТИТЬ «${note.title}»`,
    system: 'Ты помогаешь разметить заметку в личном обсидиан-вальте. Отвечай строго в заданном формате, без пояснений и вступлений.',
    user: `Заметка «${note.title}» (${note.path}):
"""
${text.slice(0, 6000)}
"""

Теги, которые уже живут в вальте (число — сколько заметок помечено):
${tags.map(([t, n]) => `#${t} (${n})`).join(', ') || '(тегов пока нет)'}

Похожие заметки по словам и связям:
${neighbours.map(n => `- ${n.title}${n.tags?.length ? ` [${n.tags.map(t => '#' + t).join(' ')}]` : ''}`).join('\n') || '(нет)'}

Ответь ровно двумя строками:
ТЕГИ: до пяти тегов через запятую, только из списка выше — новый придумывай лишь если ни один существующий не подходит, и не больше одного.
СВЯЗИ: до трёх заголовков из списка похожих, с которыми эту заметку стоит связать по существу, через запятую. Если связывать не с чем — напиши «нет».`,
    parse: out => {
      const line = re => (out.match(re)?.[1] || '').split(/\s*,\s*/).map(s => s.trim().replace(/^#/, '')).filter(s => s && !/^нет$/i.test(s));
      return { tags: line(/ТЕГИ:\s*(.+)/i), links: line(/СВЯЗИ:\s*(.+)/i) };
    },
  }),

  cluster: ({ label, notes }) => ({
    title: `ОПИСАТЬ СОЗВЕЗДИЕ «${label}»`,
    system: 'Ты описываешь группу заметок из личного вальта. Коротко, по-русски, без воды и без выдумывания фактов, которых нет в заголовках.',
    user: `Группа собрана механически — по связям между заметками. Её заголовки:
${notes.map(n => `- ${n.title} (${n.path})`).join('\n')}

Ответь тремя строками:
ИМЯ: два-три слова, как назвать эту группу.
О ЧЁМ: одно предложение — что их объединяет.
ЧТО НЕ НА МЕСТЕ: заголовки, которые к остальным явно не относятся, через запятую (или «всё на месте»).`,
    parse: out => ({
      name: (out.match(/ИМЯ:\s*(.+)/i)?.[1] || '').trim(),
      about: (out.match(/О ЧЁМ:\s*(.+)/i)?.[1] || '').trim(),
      odd: (out.match(/ЧТО НЕ НА МЕСТЕ:\s*(.+)/i)?.[1] || '').trim(),
      raw: out,
    }),
  }),

  digest: ({ days, notes, unsorted }) => ({
    title: `СВОДКА ЗА ${days} ${days === 7 ? 'ДНЕЙ' : 'ДН.'}`,
    system: 'Ты подводишь итог недели по личному вальту. Только то, что видно из заголовков и фрагментов; ничего не додумывай.',
    user: `Заметки, которых касались за последние ${days} дней:
${notes.map(n => `- ${n.title} (${n.path}, правка ${String(n.meta.h || '').slice(0, 10)})${n.frag ? `\n  ${n.frag.slice(0, 300)}` : ''}`).join('\n')}

Неразобранное (без тегов или без связей): ${unsorted.map(n => n.title).join(', ') || 'нет'}

Ответь по-русски: три-пять пунктов «что происходило», затем строка «ЧТО ПОДВИСЛО:» с тем, что начато и брошено, затем «ЧТО РАЗОБРАТЬ:» — три заметки из неразобранного, которые важнее прочих, и почему.`,
    parse: out => ({ raw: out }),
  }),
};

// Тот же пакет, но в буфер: без ключа помощники работают ровно так же, только
// ответ приносит человек из своего чата.
export const packHelper = h => `${h.system}\n\n${h.user}`;

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
