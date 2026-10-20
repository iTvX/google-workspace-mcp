/**
 * Unpacking .zip and .gz attachments.
 *
 * DMARC aggregate reports are the case this exists for: Google sends a zip holding one
 * XML file, Microsoft and Yahoo a gzipped XML file. The zips here are built byte by byte
 * so each test controls exactly what the central directory claims, which is also how the
 * hostile cases (a size that lies, an entry that unpacks to gigabytes) are made.
 */
import { describe, expect, it } from 'vitest';
import { deflateRawSync, gzipSync } from 'node:zlib';

import { archiveKind, unpack, MAX_UNPACKED_BYTES, MAX_UNPACKED_FILES } from '../../executor/archive.js';

interface Entry {
  name: string;
  data: Buffer;
  /** 0 stored, 8 deflated (default), anything else is written as-is. */
  method?: number;
  flags?: number;
  /** What the directory claims the unpacked size is; the real size by default. */
  declaredSize?: number;
}

/** A zip archive: local headers and data, then the central directory, then its end record. */
function makeZip(entries: Entry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 8;
    const packed = method === 8 ? deflateRawSync(e.data) : e.data;
    const name = Buffer.from(e.name, 'utf8');
    const flags = (e.flags ?? 0) | 0x800;
    const size = e.declaredSize ?? e.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(packed.length, 20);
    record.writeUInt32LE(size, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);

    chunks.push(local, name, packed);
    central.push(record, name);
    offset += 30 + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}

const REPORT_XML = '<?xml version="1.0" encoding="UTF-8" ?>\n<feedback><report_metadata>'
  + '<org_name>google.com</org_name></report_metadata><record><row><source_ip>203.0.113.7</source_ip>'
  + '<count>3</count></row></record></feedback>\n';

describe('archiveKind', () => {
  it('knows zip and gzip by extension, whatever the MIME type says', () => {
    expect(archiveKind('google.com!example.com!1746057600!1746143999.zip', 'application/zip')).toBe('zip');
    expect(archiveKind('report.ZIP')).toBe('zip');
    expect(archiveKind('enterprise.protection.outlook.com!example.com!1!2.xml.gz', 'application/octet-stream')).toBe('gzip');
  });

  it('falls back to the MIME type when the name has no archive extension', () => {
    expect(archiveKind('report', 'application/x-zip-compressed')).toBe('zip');
    expect(archiveKind('report', 'application/gzip')).toBe('gzip');
  });

  it('leaves alone files that are zips underneath but not archives to unpack', () => {
    expect(archiveKind('budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBeUndefined();
    expect(archiveKind('letter.docx')).toBeUndefined();
    expect(archiveKind('invoice.pdf', 'application/pdf')).toBeUndefined();
  });
});

describe('unpack: zip', () => {
  it('unpacks a Google DMARC report to its XML', () => {
    const name = 'google.com!example.com!1746057600!1746143999.xml';
    const result = unpack('zip', 'r.zip', makeZip([{ name, data: Buffer.from(REPORT_XML) }]));
    expect(result.skipped).toEqual([]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].name).toBe(name);
    expect(result.files[0].data.toString('utf-8')).toBe(REPORT_XML);
  });

  it('reads stored and deflated entries, and passes over folders', () => {
    const result = unpack('zip', 'r.zip', makeZip([
      { name: 'reports/', data: Buffer.alloc(0), method: 0 },
      { name: 'reports/a.xml', data: Buffer.from('<a/>'), method: 0 },
      { name: 'reports/b.xml', data: Buffer.from('<b/>') },
    ]));
    expect(result.files.map((f) => [f.name, f.data.toString()])).toEqual([
      ['reports/a.xml', '<a/>'],
      ['reports/b.xml', '<b/>'],
    ]);
  });

  it('skips encrypted entries and unknown compression, with the reason, and keeps the rest', () => {
    const result = unpack('zip', 'r.zip', makeZip([
      { name: 'secret.xml', data: Buffer.from('xx'), method: 0, flags: 0x1 },
      { name: 'bzip2.xml', data: Buffer.from('xx'), method: 12 },
      { name: 'plain.xml', data: Buffer.from('<ok/>') },
    ]));
    expect(result.files.map((f) => f.name)).toEqual(['plain.xml']);
    expect(result.skipped).toEqual(['secret.xml (encrypted)', 'bzip2.xml (compression method 12)']);
  });

  it(`unpacks at most ${MAX_UNPACKED_FILES} files`, () => {
    const entries = Array.from({ length: MAX_UNPACKED_FILES + 1 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.from(`${i}`) }));
    const result = unpack('zip', 'many.zip', makeZip(entries));
    expect(result.files).toHaveLength(MAX_UNPACKED_FILES);
    expect(result.skipped).toEqual([`f${MAX_UNPACKED_FILES}.txt (more than ${MAX_UNPACKED_FILES} files)`]);
  });

  it('refuses an entry whose declared size is past the limit, without inflating it', () => {
    const huge = Buffer.alloc(MAX_UNPACKED_BYTES + 1);
    const result = unpack('zip', 'bomb.zip', makeZip([{ name: 'bomb.bin', data: huge }]));
    expect(result.files).toEqual([]);
    expect(result.skipped).toEqual(['bomb.bin (past the 25 MB unpack limit)']);
  });

  it('stops an entry that lies about its size once it unpacks past the limit', () => {
    const huge = Buffer.alloc(MAX_UNPACKED_BYTES + 1);
    const result = unpack('zip', 'bomb.zip', makeZip([
      { name: 'small.xml', data: Buffer.from('<ok/>') },
      { name: 'liar.bin', data: huge, declaredSize: 10 },
    ]));
    expect(result.files.map((f) => f.name)).toEqual(['small.xml']);
    expect(result.skipped).toEqual(['liar.bin (past the 25 MB unpack limit)']);
  });

  it('says so when the file is not a zip at all', () => {
    expect(() => unpack('zip', 'r.zip', Buffer.from('this is not a zip archive at all'))).toThrow(/no central directory/);
  });

  it('says so when the directory points past the end of the file', () => {
    const zip = makeZip([{ name: 'a.xml', data: Buffer.from('<a/>') }]);
    zip.writeUInt32LE(0x7fffffff, zip.length - 22 + 16); // central directory offset
    expect(() => unpack('zip', 'r.zip', zip)).toThrow(/damaged/);
  });
});

describe('unpack: gzip', () => {
  it('unpacks a gzipped DMARC report and drops the .gz from its name', () => {
    const name = 'enterprise.protection.outlook.com!example.com!1746057600!1746143999.xml.gz';
    const result = unpack('gzip', name, gzipSync(REPORT_XML));
    expect(result.files).toHaveLength(1);
    expect(result.files[0].name).toBe(name.slice(0, -3));
    expect(result.files[0].data.toString('utf-8')).toBe(REPORT_XML);
  });

  it('names the output after the file when it has no .gz to drop', () => {
    expect(unpack('gzip', 'report', gzipSync('x')).files[0].name).toBe('report.unpacked');
  });

  it('refuses a file that unpacks past the limit', () => {
    expect(() => unpack('gzip', 'bomb.gz', gzipSync(Buffer.alloc(MAX_UNPACKED_BYTES + 1))))
      .toThrow(/unpacks to more than 25 MB/);
  });

  it('says so when the file is not gzip', () => {
    expect(() => unpack('gzip', 'r.xml.gz', Buffer.from('plain text'))).toThrow(/not a valid gzip file/);
  });
});
