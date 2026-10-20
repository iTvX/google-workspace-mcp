/**
 * Unpack .zip and .gz files so what is inside them can be read.
 *
 * Some mail is only useful unpacked: DMARC aggregate reports arrive as a zipped
 * (Google) or gzipped (Microsoft, Yahoo) XML file, and an agent handed only the archive
 * needs a shell to see inside it. getAttachment unpacks such a file next to the saved
 * archive and returns the text inside, as it does for a text attachment.
 *
 * Node's zlib does the inflating; the zip container is read here, from its central
 * directory, for stored and deflated entries. Encrypted entries, ZIP64 and other
 * compression methods are skipped with a reason rather than guessed at. The limits keep
 * a hostile archive (a zip bomb, thousands of entries) from filling the disk or the reply.
 */

import * as path from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';

/** Most bytes unpacked from one archive, all files together. */
export const MAX_UNPACKED_BYTES = 25 * 1024 * 1024;
/** Most files unpacked from one zip. */
export const MAX_UNPACKED_FILES = 50;

export type ArchiveKind = 'zip' | 'gzip';

export interface UnpackedFile {
  /** The name inside the archive, as stored (may include folders). */
  name: string;
  data: Buffer;
}

export interface UnpackResult {
  files: UnpackedFile[];
  /** Entries left packed, each with the reason. */
  skipped: string[];
}

const ZIP_TYPES = ['application/zip', 'application/x-zip', 'application/x-zip-compressed'];
const GZIP_TYPES = ['application/gzip', 'application/x-gzip'];

/** Whether a file is an archive this module unpacks, judged by extension, then MIME type. */
export function archiveKind(filename: string, mimeType?: string): ArchiveKind | undefined {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.zip') return 'zip';
  if (ext === '.gz') return 'gzip';
  const type = (mimeType ?? '').toLowerCase();
  if (ZIP_TYPES.includes(type)) return 'zip';
  if (GZIP_TYPES.includes(type)) return 'gzip';
  return undefined;
}

/**
 * Unpack an archive. Throws a sentence when the file is not the archive it claims to be,
 * or is too big unpacked; a single bad entry in an otherwise good zip is only skipped.
 */
export function unpack(kind: ArchiveKind, filename: string, buffer: Buffer): UnpackResult {
  return kind === 'zip' ? unzip(buffer) : gunzip(filename, buffer);
}

const MB = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

function gunzip(filename: string, buffer: Buffer): UnpackResult {
  let data: Buffer;
  try {
    data = gunzipSync(buffer, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(`it unpacks to more than ${MB(MAX_UNPACKED_BYTES)}`);
    }
    throw new Error(`not a valid gzip file (${(err as Error).message})`);
  }
  const name = /\.gz$/i.test(filename) ? filename.slice(0, -3) : `${filename}.unpacked`;
  return { files: [{ name, data }], skipped: [] };
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** Offset of the end-of-central-directory record: 22 bytes, plus a comment of up to 64 KB. */
function findEndOfCentralDirectory(buffer: Buffer): number {
  const last = buffer.length - 22;
  for (let i = last; i >= 0 && i >= last - 0xffff; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

function unzip(buffer: Buffer): UnpackResult {
  const corrupt = () => new Error('not a valid zip file (its directory is damaged)');
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error('not a valid zip file (no central directory)');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) throw new Error('ZIP64 archives are not supported');

  const files: UnpackedFile[] = [];
  const skipped: string[] = [];
  let total = 0;

  for (let i = 0; i < count; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw corrupt();
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const packedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    // Bit 11: the name is UTF-8. Without it the spec says CP437; latin1 keeps ASCII intact.
    const name = buffer.toString(flags & 0x800 ? 'utf8' : 'latin1', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue; // a folder
    if (files.length >= MAX_UNPACKED_FILES) {
      skipped.push(`${name} (more than ${MAX_UNPACKED_FILES} files)`);
      continue;
    }
    if (flags & 0x1) { skipped.push(`${name} (encrypted)`); continue; }
    if (method !== 0 && method !== 8) { skipped.push(`${name} (compression method ${method})`); continue; }
    if (packedSize === 0xffffffff || size === 0xffffffff) { skipped.push(`${name} (ZIP64)`); continue; }
    if (total + size > MAX_UNPACKED_BYTES) {
      skipped.push(`${name} (past the ${MB(MAX_UNPACKED_BYTES)} unpack limit)`);
      continue;
    }

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw corrupt();
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    if (start + packedSize > buffer.length) throw corrupt();
    const packed = buffer.subarray(start, start + packedSize);

    try {
      // The declared size is only a claim; the inflate limit is what holds.
      const data = method === 0
        ? Buffer.from(packed)
        : inflateRawSync(packed, { maxOutputLength: Math.max(1, MAX_UNPACKED_BYTES - total) });
      total += data.length;
      files.push({ name, data });
    } catch (err) {
      skipped.push((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE'
        ? `${name} (past the ${MB(MAX_UNPACKED_BYTES)} unpack limit)`
        : `${name} (damaged: ${(err as Error).message})`);
    }
  }

  return { files, skipped };
}
