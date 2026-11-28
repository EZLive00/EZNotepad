// ============================================================
// test/lib/mkmedia.mjs —— 探针自己造测试文件
//
// 为什么要手写：图片/压缩包这类样本一旦入库就是二进制，改不动、看不清、
// 还容易越攒越大。这里按格式规范现造，几十行代码，跨平台无依赖。
//
// 只实现最小的那一份：PNG 用 store 方式的 zlib、ZIP 用 store（不压缩）。
// 目的只是「让程序认得出、放得出」，不是做一个完整的编码器。
// ============================================================
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync, gzipSync } from 'node:zlib';
import { join } from 'node:path';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

/** 纯色 PNG。颜色给 [r,g,b]，8 位真彩、无 alpha —— 够验收宽高和渲染 */
export function writePng(path, w, h, rgb = [230, 77, 46]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // color type: truecolor
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3);
    raw[off] = 0;                       // filter: none
    for (let x = 0; x < w; x++) {
      const p = off + 1 + x * 3;
      raw[p] = rgb[0]; raw[p + 1] = rgb[1]; raw[p + 2] = rgb[2];
    }
  }
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]));
}

/**
 * ZIP（store 方式，不压缩）。
 * files: [{ name: 'dir/a.txt', data: Buffer | string }]
 *
 * 路径分隔符故意用 `/`（zip 规范），但 Windows 上的压缩工具会写 `\` ——
 * media.rs 里那条「按归一化名字找下标」就是为它写的，别改成 by_name。
 */
export function writeZip(path, files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);        // 文件名是 UTF-8
    lh.writeUInt16LE(0, 8);             // store
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += lh.length + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  writeFileSync(path, Buffer.concat([...locals, cd, eocd]));
}

/**
 * 一段 WAV：8 kHz、单声道、16 位 PCM，0.4 秒的 440 Hz 正弦。
 * 用它验「音视频真的能放」—— CSP 少写一条 media-src，图上一切正常，
 * 只有播的时候是死的。
 */
export function writeWav(path, seconds = 0.4) {
  const rate = 8000;
  const n = Math.floor(rate * seconds);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000);
    data.writeInt16LE(v, i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);          // PCM
  head.writeUInt16LE(1, 22);          // 单声道
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);   // byte rate
  head.writeUInt16LE(2, 32);          // block align
  head.writeUInt16LE(16, 34);         // bits
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([head, data]));
}

/**
 * tar.gz（ustar，store）。tar 头就是 512 字节纯文本字段，
 * 唯一要小心的是校验和：算的时候那 8 个字节必须先当空格。
 */
export function writeTarGz(path, files) {
  const blocks = [];
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const head = Buffer.alloc(512);
    head.write(f.name, 0, 100, 'utf8');
    head.write('0000644\0', 100);                        // mode
    head.write('0000000\0', 108);                        // uid
    head.write('0000000\0', 116);                        // gid
    head.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    head.write('00000000000\0', 136);                    // mtime
    head.write('        ', 148);                          // 校验和先占 8 个空格
    head.write('0', 156);                                 // 普通文件
    head.write('ustar\0', 257);
    head.write('00', 263);
    let sum = 0;
    for (const b of head) sum += b;
    head.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(head, data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));                        // 结束标记：两个空块
  writeFileSync(path, gzipSync(Buffer.concat(blocks)));
}

/** 准备一个干净的目录，返回路径 */
export function makeDir(base) {
  mkdirSync(base, { recursive: true });
  return (n) => join(base, n);
}
