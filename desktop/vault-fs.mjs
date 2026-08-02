/**
 * Вальт напрямую с диска — то, ради чего десктопное приложение вообще нужно.
 *
 * В браузере путь к заметкам один: воркер → GitHub Contents API → сеть → секрет.
 * На своей машине вальт лежит в обычной папке, и ходить за ним в интернет
 * бессмысленно: чтение мгновенное, запись мгновенная, интернет не нужен вовсе,
 * секрет вводить незачем.
 *
 * Набор операций тот же, что у vault-mcp, и тексты ответов и ошибок повторяют
 * воркер буква в букву: приложение разбирает их регулярками, и «улучшенная»
 * формулировка здесь сломала бы ветвление записи ровно так же, как в бою.
 */
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { prepareChunks, parseSynonyms, rankFiles, excerpt } from '../js/search.js';

const INDEX_DIR = '_машина/индекс';
const SYNONYMS = '_машина/синонимы.md';

export class VaultFs {
  constructor(root) { this.root = root; this._index = null; }

  _safe(p) {
    const clean = String(p || '').replace(/^[\\/]+|[\\/]+$/g, '').replace(/\\/g, '/');
    if (clean.split('/').includes('..')) throw new Error('плохой путь');
    return clean;
  }
  _abs(p) { return join(this.root, ...this._safe(p).split('/')); }

  async read(path) {
    const f = this._abs(path);
    if (!existsSync(f)) return null;
    const st = await stat(f);
    if (st.isDirectory()) throw new Error(`${path} — это папка, не файл`);
    return readFile(f, 'utf8');
  }

  async write(path, text) {
    const f = this._abs(path);
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, text, 'utf8');
    this._index = null;   // индекс мог устареть — пересоберём лениво
    return createHash('sha1').update(text).digest('hex').slice(0, 7);
  }

  async list(path) {
    const clean = this._safe(path);
    const root = this._abs(clean);
    if (!existsSync(root)) throw new Error('GitHub 404');
    const out = [];
    for (const e of await readdir(root, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules' || e.name === '.obsidian') continue;
      const rel = clean ? `${clean}/${e.name}` : e.name;
      const size = e.isFile() ? (await stat(join(root, e.name))).size : 0;
      out.push({ type: e.isDirectory() ? 'dir' : 'file', path: rel, size });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path, 'ru'));
  }

  /* ── разделы ────────────────────────────────────────────────────────────── */

  static cleanH = s => s.replace(/ /g, ' ').trim().toLowerCase();

  static findHeading(lines, heading) {
    const want = VaultFs.cleanH(heading);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
      if (m && VaultFs.cleanH(m[2]) === want) return { index: i, level: m[1].length };
    }
    return null;
  }
  static sectionEnd(lines, from, level) {
    for (let i = from + 1; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,6})\s+/);
      if (m && m[1].length <= level) return i;
    }
    return lines.length;
  }
  static headingList(lines, limit = 100) {
    const out = [];
    for (const l of lines) {
      const m = l.match(/^(#{1,6})\s+(.*)$/);
      if (m) out.push(`${'  '.repeat(m[1].length - 1)}${m[1]} ${m[2]}`);
      if (out.length >= limit) break;
    }
    return out;
  }
  // Пустая строка между вставкой и соседями нужна почти всегда — но не между
  // пунктами одного списка: иначе подряд идущие мысли разъезжаются.
  static isListItem = s => /^\s*(?:[-*+]\s|\d+[.)]\s)/.test(s || '');

  static applyPatch(text, { heading, content, operation }) {
    const lines = text.replace(/\r/g, '').split('\n');
    const found = VaultFs.findHeading(lines, heading);
    if (!found) {
      const have = VaultFs.headingList(lines, 25).map(h => h.trim()).join(' | ');
      throw new Error(`Заголовок «${heading}» не найден. Есть: ${have || 'заголовков нет'}`);
    }
    const end = VaultFs.sectionEnd(lines, found.index, found.level);
    const block = content.replace(/\s+$/, '').split('\n');
    if (operation === 'replace') {
      lines.splice(found.index + 1, end - found.index - 1, '', ...block, '');
      return lines.join('\n');
    }
    if (operation === 'prepend') {
      let at = found.index + 1;
      while (at < lines.length && lines[at].trim() === '') at++;
      const glue = VaultFs.isListItem(block[block.length - 1]) && VaultFs.isListItem(lines[at]) ? [] : [''];
      lines.splice(at, 0, ...block, ...glue);
      return lines.join('\n');
    }
    let at = end;
    while (at > found.index + 1 && lines[at - 1].trim() === '') at--;
    const glue = VaultFs.isListItem(lines[at - 1]) && VaultFs.isListItem(block[0]) ? [] : [''];
    lines.splice(at, 0, ...glue, ...block);
    return lines.join('\n');
  }

  /* ── поиск ──────────────────────────────────────────────────────────────── */

  async index() {
    if (this._index) return this._index;
    const raw = [];
    for (const e of await this.list(INDEX_DIR)) {
      if (e.type !== 'file' || !e.path.endsWith('.json') || e.path.endsWith('meta.json')) continue;
      raw.push(...JSON.parse(await this.read(e.path)));
    }
    const syn = await this.read(SYNONYMS).catch(() => '');
    this._index = { chunks: prepareChunks(raw), synonyms: parseSynonyms(syn || '') };
    return this._index;
  }

  /* ── инструменты (тот же контракт, что у воркера) ───────────────────────── */

  async call(name, args = {}) {
    switch (name) {
      case 'vault_read': {
        const t = await this.read(args.path);
        if (t == null) throw new Error(`Файла ${args.path} нет`);
        return t;
      }
      case 'vault_list':
        return (await this.list(args.path || '')).map(e =>
          `${e.type === 'dir' ? '[папка] ' : ''}${e.path}${e.type === 'file' ? ` (${e.size} б)` : ''}`).join('\n');
      case 'vault_section': {
        const text = await this.read(args.path);
        if (text == null) throw new Error(`Файла ${args.path} нет`);
        const lines = text.split('\n');
        if (!args.heading) return `${args.path} — ${text.length} символов. Заголовки:\n${VaultFs.headingList(lines).join('\n') || '(заголовков нет)'}\n\nvault_section(path, heading) вернёт один раздел.`;
        const found = VaultFs.findHeading(lines, args.heading);
        if (!found) throw new Error(`Заголовка «${args.heading}» нет. Есть:\n${VaultFs.headingList(lines, 30).join('\n')}`);
        const end = VaultFs.sectionEnd(lines, found.index, found.level);
        const body = lines.slice(found.index, end).join('\n').replace(/\s+$/, '');
        return `${body}\n\n— раздел «${args.heading}» из ${args.path} (${body.length} из ${text.length} символов файла)`;
      }
      case 'vault_search': {
        const limit = Math.min(Math.max(args.limit || 6, 1), 20);
        const { chunks, synonyms } = await this.index();
        const { files, terms } = rankFiles(chunks, args.query, synonyms, limit);
        if (!files.length) return `По запросу «${args.query}» в заметках совпадений нет (искал по ${chunks.length} фрагментам).\nНигде не встречается. Скажи, что этого в памяти нет — не достраивай ответ по догадке.`;
        const out = files.map(({ p, best, n }) => {
          const chain = best.c.h.length ? ` › ${best.c.h.join(' › ')}` : '';
          const more = n > 1 ? `  (ещё ${n - 1} ${n - 1 === 1 ? 'фрагмент' : 'фрагмента'} в этом файле)` : '';
          return `**${p}**${chain}${more}\n${excerpt(best.c.t, terms)}`;
        });
        return [out.join('\n\n'), '', 'Это фрагменты, а не ответ. Если прямого ответа в них нет — прочитай нужный файл (vault_section по заголовку выше или vault_read целиком), а если и там нет — так и скажи, что в памяти этого нет.'].join('\n');
      }
      case 'vault_patch': {
        const text = await this.read(args.path);
        if (text == null) throw new Error(`Файла ${args.path} нет. Создай через vault_create.`);
        const op = ['append', 'replace'].includes(args.operation) ? args.operation : 'prepend';
        const updated = VaultFs.applyPatch(text, { heading: args.heading, content: args.content, operation: op });
        const c = await this.write(args.path, updated);
        return `Записано в ${args.path} под «${args.heading}» (${op}). Коммит ${c}. Было ${text.length} символов, стало ${updated.length}.`;
      }
      case 'vault_append': {
        const text = await this.read(args.path);
        const updated = (text ? text.replace(/\s+$/, '') + '\n\n' : '') + args.content.replace(/\s+$/, '') + '\n';
        const c = await this.write(args.path, updated);
        return `${text ? 'Дописано в' : 'Создан'} ${args.path}. Коммит ${c}.`;
      }
      case 'vault_create': {
        if (await this.read(args.path) != null) throw new Error(`${args.path} уже существует. Используй vault_patch или vault_append.`);
        const c = await this.write(args.path, args.content);
        return `Создан ${args.path}. Коммит ${c}.`;
      }
      default:
        throw new Error(`Неизвестный инструмент: ${name}`);
    }
  }
}

// Похоже ли это на вальт: проверяем по индексу или по папке daily, чтобы человек
// не выбрал случайную папку и не получил пустую карту без объяснений.
export async function looksLikeVault(root) {
  return existsSync(join(root, '_машина', 'индекс')) || existsSync(join(root, 'daily'));
}
