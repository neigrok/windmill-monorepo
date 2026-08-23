// A store-only (method 0, no compression) ZIP writer emitting raw bytes: local file headers, a
// central directory and an end-of-central-directory record, all little-endian.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const DOS_TIME = 0;
const DOS_DATE = 0x21; // 1980-01-01 — the ZIP epoch, so archives are byte-for-byte deterministic
const UTF8_FLAG = 0x0800;
const VERSION = 20; // 2.0 — the floor for store + UTF-8 names
const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;

export function storeZip(files) {
  const encoder = new TextEncoder();
  const entries = files.map((file) => {
    const data = encoder.encode(file.text ?? '');
    return { name: encoder.encode(file.name), data, crc: crc32(data), offset: 0 };
  });

  const localBytes = entries.reduce((sum, entry) => sum + LOCAL_HEADER + entry.name.length + entry.data.length, 0);
  const centralBytes = entries.reduce((sum, entry) => sum + CENTRAL_HEADER + entry.name.length, 0);
  const out = new Uint8Array(localBytes + centralBytes + END_RECORD);
  const view = new DataView(out.buffer);

  let at = 0;
  for (const entry of entries) {
    entry.offset = at;
    at = writeLocalHeader(view, out, at, entry);
  }
  const centralStart = at;
  for (const entry of entries) at = writeCentralHeader(view, out, at, entry);
  writeEndRecord(view, at, entries.length, centralBytes, centralStart);

  return out;
}

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function writeLocalHeader(view, out, at, entry) {
  view.setUint32(at, 0x04034b50, true); // "PK\3\4"
  view.setUint16(at + 4, VERSION, true);
  view.setUint16(at + 6, UTF8_FLAG, true);
  view.setUint16(at + 8, 0, true); // method: store
  view.setUint16(at + 10, DOS_TIME, true);
  view.setUint16(at + 12, DOS_DATE, true);
  view.setUint32(at + 14, entry.crc, true);
  view.setUint32(at + 18, entry.data.length, true); // compressed size == raw size
  view.setUint32(at + 22, entry.data.length, true);
  view.setUint16(at + 26, entry.name.length, true);
  view.setUint16(at + 28, 0, true); // extra field length
  out.set(entry.name, at + LOCAL_HEADER);
  out.set(entry.data, at + LOCAL_HEADER + entry.name.length);
  return at + LOCAL_HEADER + entry.name.length + entry.data.length;
}

function writeCentralHeader(view, out, at, entry) {
  view.setUint32(at, 0x02014b50, true); // "PK\1\2"
  view.setUint16(at + 4, VERSION, true); // version made by
  view.setUint16(at + 6, VERSION, true); // version needed
  view.setUint16(at + 8, UTF8_FLAG, true);
  view.setUint16(at + 10, 0, true); // method: store
  view.setUint16(at + 12, DOS_TIME, true);
  view.setUint16(at + 14, DOS_DATE, true);
  view.setUint32(at + 16, entry.crc, true);
  view.setUint32(at + 20, entry.data.length, true);
  view.setUint32(at + 24, entry.data.length, true);
  view.setUint16(at + 28, entry.name.length, true);
  view.setUint16(at + 30, 0, true); // extra field length
  view.setUint16(at + 32, 0, true); // comment length
  view.setUint16(at + 34, 0, true); // disk number start
  view.setUint16(at + 36, 0, true); // internal attributes
  view.setUint32(at + 38, 0, true); // external attributes
  view.setUint32(at + 42, entry.offset, true); // offset of the local header
  out.set(entry.name, at + CENTRAL_HEADER);
  return at + CENTRAL_HEADER + entry.name.length;
}

function writeEndRecord(view, at, count, centralBytes, centralStart) {
  view.setUint32(at, 0x06054b50, true); // "PK\5\6"
  view.setUint16(at + 4, 0, true); // this disk number
  view.setUint16(at + 6, 0, true); // disk with the central directory
  view.setUint16(at + 8, count, true); // central records on this disk
  view.setUint16(at + 10, count, true); // total central records
  view.setUint32(at + 12, centralBytes, true);
  view.setUint32(at + 16, centralStart, true);
  view.setUint16(at + 20, 0, true); // archive comment length
}
