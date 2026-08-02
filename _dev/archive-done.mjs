/**
 * Перевод разобранных улик в архив.
 *
 * Улика уезжает в `archive/` не по расписанию и не оптом, а тогда, когда она
 * заслужила: из неё вынули знание, и это знание прошло проверку. До тех пор она
 * лежит на месте, потому что она ещё рабочий материал, а не история.
 *
 * Что проверяется перед переносом:
 *   1. на улику ссылается хотя бы один осколок полем `источник`;
 *   2. осколков не меньше порога — одна ссылка с файла в 35 КБ значит, что
 *      извлечение прошло формально, а не по существу;
 *   3. `shard-lint` на всём корпусе осколков зелёный.
 *
 * Ссылки при переносе не ломаются: и Обсидиан, и сборщик карты резолвят
 * `[[имя]]` по имени файла, а не по пути. Поэтому `источник` продолжает вести
 * куда надо, а `git mv` сохраняет историю.
 *
 * По умолчанию только показывает. Перенос — с `--apply`.
 *
 * Запуск: node _dev/archive-done.mjs [--vault <путь>] [--min 5] [--apply]
 */

import { readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, posix, dirname } from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const VAULT = resolve(flag('vault', 'C:/Users/sasha/Documents/Obsidian Vault'));
const MIN = Number(flag('min', 5));
const APPLY = args.includes('--apply');
const DEST = 'archive/улики';

const map = JSON.parse(readFileSync(join(VAULT, '_машина/карта/карта.json'), 'utf8').replace(/^\uFEFF/, '')).notes;
const base = p => posix.basename(p).replace(/\.md$/i, '');

// Кто на кого ссылается как на источник.
const counts = new Map();
for (const n of map) {
  if (n.kl !== 'утверждение') continue;
  for (const [to, type] of n.ln || []) {
    if (type !== 'source' || !map[to]) continue;
    counts.set(map[to].p, (counts.get(map[to].p) || 0) + 1);
  }
}

const улики = map.filter(n => n.kl === 'улика' && !n.p.startsWith('archive/') && !n.p.startsWith('_tools/queue/'));
const готовы = улики.filter(u => (counts.get(u.p) || 0) >= MIN);
const рано = улики.filter(u => (counts.get(u.p) || 0) > 0 && (counts.get(u.p) || 0) < MIN);

console.log(`Улик вне архива: ${улики.length}. Разобрано достаточно (≥${MIN} осколков): ${готовы.length}. Начато, но мало: ${рано.length}.\n`);
for (const u of готовы) console.log(`  ${String(counts.get(u.p)).padStart(3)} осколков  ${u.p}`);
if (рано.length) {
  console.log('\nЭти трогать рано:');
  for (const u of рано) console.log(`  ${String(counts.get(u.p)).padStart(3)} осколков  ${u.p}`);
}

if (!готовы.length) { console.log('\nПереносить нечего.'); process.exit(0); }

if (!APPLY) {
  console.log(`\nЭто сухой прогон. Перенос в ${DEST}/ — с флагом --apply.`);
  process.exit(0);
}

// Линтер — последний рубеж: пока в осколках есть ошибки, улики остаются на
// месте, иначе потерянный первоисточник некому будет предъявить.
try {
  execFileSync(process.execPath, [join(dirname(new URL(import.meta.url).pathname.slice(1)), 'shard-lint.mjs'), '--vault', VAULT], { stdio: 'pipe' });
} catch {
  console.error('\nshard-lint нашёл ошибки в осколках — перенос отменён. Сначала почини осколки.');
  process.exit(1);
}

mkdirSync(join(VAULT, DEST), { recursive: true });
let moved = 0;
for (const u of готовы) {
  const target = posix.join(DEST, posix.basename(u.p));
  if (existsSync(join(VAULT, target))) { console.error(`  пропуск: ${target} уже существует`); continue; }
  execFileSync('git', ['mv', u.p, target], { cwd: VAULT });
  moved++;
}
console.log(`\nПеренесено улик: ${moved} → ${DEST}/. Ссылки «источник» продолжают работать: резолв идёт по имени файла.`);
