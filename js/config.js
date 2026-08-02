export const DEFAULT_URL = 'https://vault-mcp.vault-78edd5.workers.dev/mcp';
export const APP_NAME = 'SHARDS';
// приложение (github pages / localhost) против песочницы предпросмотра
export const IS_APP = /(^|\.)github\.io$|^localhost$|^127\./.test(location.hostname);
// без янтарного (#f0a860) — он зарезервирован под выбор/акцент
export const ZONE_PALETTE = ['#57d9c9', '#a48cf0', '#e07a8a', '#7fc98f', '#5ba0e0', '#e8b84b', '#d8c060', '#8a97b8'];
export const INDEX_DIR = '_машина/индекс';
export const SYNONYMS_PATH = '_машина/синонимы.md';
export const DAILY_DIR = 'daily';              // дневные файлы: daily/ГГГГ-ММ-ДД.md
export const DAILY_THOUGHTS = 'Мысли';         // раздел дневной заметки для быстрой записи
export const INDEX_REBUILD_MS = 35000;         // задержка перезагрузки корпуса без indexTouched

/* ── разговор с ИИ ────────────────────────────────────────────────────────── */
export const AI_URL = 'https://api.anthropic.com/v1/messages';
export const AI_VERSION = '2023-06-01';
export const MODEL = 'claude-opus-5';

/* ── созвездия ────────────────────────────────────────────────────────────────
   Зона — это папка, но не всякая папка одинаково полезна как созвездие.
   `brain` — треть корпуса, и внутри неё журнал сессий (brain/log) живёт своей
   жизнью: он упоминает всё подряд и по смыслу противоположен заметке, которая
   теме посвящена. Поэтому крупные папки разбиваются по второму уровню.

   Порог: папка крупнее SPLIT_MIN дробится, подпапка становится своим созвездием
   от SUBZONE_MIN узлов; мелочь остаётся в родительском. */
export const SPLIT_MIN = 26;
export const SUBZONE_MIN = 8;

// Журналы и очередь — фон карты, а не её содержание: тот же принцип, что в
// авторитете источника у поиска (вес 0.4). Рисуем приглушённо-серым.
export const CHRONICLE_ZONES = [/^brain\/log$/i, /^_tools\/queue$/i, /^Учёба\/Лог сессий$/i];
export const CHRONICLE_COLOR = '#6f7d84';

// Человеческие имена созвездий. Ключ — путь папки, значение — подпись на карте.
// Чего нет в словаре, показывается как есть: вальт растёт, и приложение не должно
// прятать новую папку только потому, что о ней ещё не знает.
export const ZONE_NAMES = {
  'brain': 'МОЗГ',
  'brain/log': 'ЖУРНАЛ',
  'brain/decisions': 'РЕШЕНИЯ',
  'people': 'ЛЮДИ',
  'daily': 'ДНИ',
  'projects': 'ПРОЕКТЫ',
  'resources': 'РЕСУРСЫ',
  'resources/Система памяти': 'ПАМЯТЬ',
  'areas': 'СФЕРЫ',
  '_tools': 'МАШИНА',
  '_tools/queue': 'ОЧЕРЕДЬ',
  '_tools/vault-mcp': 'ВОРКЕР',
  'Учёба': 'УЧЁБА',
  'Учёба/Лог сессий': 'ЛОГ УЧЁБЫ',
  'корень': 'КОРЕНЬ',
};
