/**
 * PNG → ICO без сторонних пакетов.
 *
 * Иконка нужна дважды: в самом exe и в установщике. electron-builder умеет
 * конвертировать сам, но только через кэш winCodeSign, который на этой машине
 * не распаковывается (симлинки требуют прав администратора). ICO с 2001 года
 * умеет хранить PNG внутри как есть — значит достаточно собрать заголовок.
 *
 * Запуск: node desktop/make-ico.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const png = readFileSync(join(HERE, 'build', 'icon.png'));

// Размер берём из IHDR: в ICO поле ширины однобайтовое, 256 записывается нулём.
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);   // reserved
header.writeUInt16LE(1, 2);   // тип: 1 — иконка
header.writeUInt16LE(1, 4);   // одна картинка

const entry = Buffer.alloc(16);
entry.writeUInt8(width >= 256 ? 0 : width, 0);
entry.writeUInt8(height >= 256 ? 0 : height, 1);
entry.writeUInt8(0, 2);       // палитра не используется
entry.writeUInt8(0, 3);       // reserved
entry.writeUInt16LE(1, 4);    // цветовые плоскости
entry.writeUInt16LE(32, 6);   // бит на пиксель
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(header.length + entry.length, 12);

writeFileSync(join(HERE, 'build', 'icon.ico'), Buffer.concat([header, entry, png]));
console.log(`icon.ico собран из PNG ${width}×${height}, ${png.length} байт`);
