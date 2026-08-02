// Построчный дифф для конфликтов правки.
//
// Нужен ровно в одном месте: файл изменился с другого устройства, пока раздел
// правили здесь. Показать «перечитайте и повторите» мало — человек должен видеть,
// ЧТО именно разошлось, иначе он либо затрёт чужую правку, либо потеряет свою.
//
// Алгоритм — классическая LCS по строкам. Разделы вальта это десятки строк,
// квадратичная таблица здесь дешевле любой зависимости.

export function diffLines(oldText, newText) {
  const a = (oldText || '').replace(/\s+$/, '').split('\n');
  const b = (newText || '').replace(/\s+$/, '').split('\n');
  const n = a.length, m = b.length;
  // на всякий случай: гигантские тексты не диффим построчно
  if (n * m > 400000) return [{ type: 'del', text: a.join('\n') }, { type: 'add', text: b.join('\n') }];

  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  const push = (type, text) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += '\n' + text;
    else out.push({ type, text });
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) { push('same', a[i]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { push('del', a[i]); i++; }
    else { push('add', b[j]); j++; }
  }
  while (i < n) push('del', a[i++]);
  while (j < m) push('add', b[j++]);
  return out;
}

export const hasChanges = parts => parts.some(p => p.type !== 'same');

// Схлопывание длинных совпадающих кусков: в конфликте важно расхождение,
// а не общий текст вокруг него.
export function collapseSame(parts, keep = 2) {
  return parts.flatMap(p => {
    if (p.type !== 'same') return [p];
    const lines = p.text.split('\n');
    if (lines.length <= keep * 2 + 1) return [p];
    return [
      { type: 'same', text: lines.slice(0, keep).join('\n') },
      { type: 'skip', text: `… ещё ${lines.length - keep * 2} ${lines.length - keep * 2 === 1 ? 'строка' : 'строк'} без изменений …` },
      { type: 'same', text: lines.slice(-keep).join('\n') },
    ];
  });
}
