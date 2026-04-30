// Minimal ZIP builder — no external deps.
// Produces a valid ZIP archive (PKZIP format, stored/deflated entries).
// Uses node:zlib deflateRawSync for compression.

import { deflateRawSync } from 'node:zlib';

interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

const crc32Table: Int32Array = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c;
  }
  return t;
})();

const crc32 = (buf: Buffer): number => {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i] ?? 0;
    const idx = (crc ^ byte) & 0xff;
    const tableVal = crc32Table[idx] ?? 0;
    crc = tableVal ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const dosDate = (d: Date): { date: number; time: number } => {
  const date =
    (((d.getFullYear() - 1980) & 0x7f) << 9) |
    (((d.getMonth() + 1) & 0x0f) << 5) |
    (d.getDate() & 0x1f);
  const time =
    ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
  return { date, time };
};

const writeUint16LE = (buf: Buffer, offset: number, val: number): void => {
  buf.writeUInt16LE(val >>> 0, offset);
};

const writeUint32LE = (buf: Buffer, offset: number, val: number): void => {
  buf.writeUInt32LE(val >>> 0, offset);
};

export const buildZip = (entries: ReadonlyArray<ZipEntry>): Buffer => {
  const now = new Date();
  const { date: modDate, time: modTime } = dosDate(now);

  const localHeaders: Buffer[] = [];
  const centralDirs: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const compressed = deflateRawSync(entry.data, { level: 6 });
    const useCompressed = compressed.length < entry.data.length;
    const compData = useCompressed ? compressed : entry.data;
    const compMethod = useCompressed ? 8 : 0;

    // Local file header (30 bytes + name + data)
    const lhSize = 30 + nameBytes.length;
    const lh = Buffer.alloc(lhSize);
    writeUint32LE(lh, 0, 0x04034b50); // signature
    writeUint16LE(lh, 4, 20); // version needed (2.0)
    writeUint16LE(lh, 6, 0x0800); // flags: UTF-8 name
    writeUint16LE(lh, 8, compMethod);
    writeUint16LE(lh, 10, modTime);
    writeUint16LE(lh, 12, modDate);
    writeUint32LE(lh, 14, crc);
    writeUint32LE(lh, 18, compData.length);
    writeUint32LE(lh, 22, entry.data.length);
    writeUint16LE(lh, 26, nameBytes.length);
    writeUint16LE(lh, 28, 0); // extra length
    nameBytes.copy(lh, 30);

    localHeaders.push(lh);
    localHeaders.push(compData);

    // Central directory record (46 bytes + name)
    const cdSize = 46 + nameBytes.length;
    const cd = Buffer.alloc(cdSize);
    writeUint32LE(cd, 0, 0x02014b50); // signature
    writeUint16LE(cd, 4, 63); // version made by (Unix, 6.3)
    writeUint16LE(cd, 6, 20); // version needed
    writeUint16LE(cd, 8, 0x0800); // flags: UTF-8
    writeUint16LE(cd, 10, compMethod);
    writeUint16LE(cd, 12, modTime);
    writeUint16LE(cd, 14, modDate);
    writeUint32LE(cd, 16, crc);
    writeUint32LE(cd, 20, compData.length);
    writeUint32LE(cd, 24, entry.data.length);
    writeUint16LE(cd, 28, nameBytes.length);
    writeUint16LE(cd, 30, 0); // extra length
    writeUint16LE(cd, 32, 0); // comment length
    writeUint16LE(cd, 34, 0); // disk start
    writeUint16LE(cd, 36, 0); // internal attrs
    writeUint32LE(cd, 38, 0); // external attrs
    writeUint32LE(cd, 42, offset); // local header offset
    nameBytes.copy(cd, 46);
    centralDirs.push(cd);

    offset += lhSize + compData.length;
  }

  const cdOffset = offset;
  const cdBuf = Buffer.concat(centralDirs);
  const cdSize = cdBuf.length;

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  writeUint32LE(eocd, 0, 0x06054b50); // signature
  writeUint16LE(eocd, 4, 0); // disk number
  writeUint16LE(eocd, 6, 0); // disk with cd
  writeUint16LE(eocd, 8, entries.length); // entries on disk
  writeUint16LE(eocd, 10, entries.length); // total entries
  writeUint32LE(eocd, 12, cdSize);
  writeUint32LE(eocd, 16, cdOffset);
  writeUint16LE(eocd, 20, 0); // comment length

  return Buffer.concat([...localHeaders, cdBuf, eocd]);
};

export type { ZipEntry };
