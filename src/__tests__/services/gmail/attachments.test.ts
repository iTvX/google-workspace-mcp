/**
 * getAttachment on the mail that broke it: a DMARC report.
 *
 * Google sends each DMARC aggregate report as a message that is nothing but one zip — no
 * text part, the file on the payload itself. The attachment lookup used to start at
 * `payload.parts`, so it said "Attachment not found" for a file `read` could not list
 * either. And once found, a zip is useless to an agent without a shell, so getAttachment
 * now also unpacks it and returns the XML inside.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { deflateRawSync, gzipSync } from 'node:zlib';

vi.mock('../../../google/client.js');
import { call } from '../../../google/client.js';
import { handleGetAttachment, handleViewAttachment } from '../../../services/gmail/attachments.js';

const mockCall = call as MockedFunction<typeof call>;

const ACCOUNT = 'me@example.com';
const ZIP_NAME = 'google.com!example.com!1746057600!1746143999.zip';
const XML_NAME = 'google.com!example.com!1746057600!1746143999.xml';
const REPORT_XML = '<?xml version="1.0"?><feedback><record><row><source_ip>203.0.113.7</source_ip></row></record></feedback>';

const root = path.join(os.tmpdir(), `gws-getatt-${process.pid}-${Date.now()}`);
const workspace = path.join(root, 'workspace');
const originalWorkspaceDir = process.env.WORKSPACE_DIR;

/** A one-entry zip, deflated, as Google builds its reports. */
function zipOf(name: string, content: string): Buffer {
  const data = Buffer.from(content);
  const packed = deflateRawSync(data);
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + nameBytes.length, 12);
  end.writeUInt32LE(30 + nameBytes.length + packed.length, 16);
  return Buffer.concat([local, nameBytes, packed, central, nameBytes, end]);
}

/** Gmail serving one message whose payload is `payload`, and `bytes` for its attachment. */
function gmailServes(payload: Record<string, unknown>, bytes: Buffer): void {
  mockCall.mockImplementation(async (_service, method) => {
    if (method === 'users.messages.get') return { id: 'msg-1', payload } as never;
    if (method === 'users.messages.attachments.get') return { data: bytes.toString('base64url') } as never;
    throw new Error(`unexpected call ${method}`);
  });
}

/** The payload of a Google DMARC report: the zip is the message. */
const dmarcPayload = (filename = ZIP_NAME, mimeType = 'application/zip') => ({
  mimeType,
  filename,
  headers: [{ name: 'From', value: 'noreply-dmarc-support@google.com' }],
  body: { attachmentId: 'att-zip', size: 714 },
});

beforeEach(async () => {
  process.env.WORKSPACE_DIR = workspace;
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(workspace, { recursive: true });
});

afterEach(() => mockCall.mockReset());

afterAll(async () => {
  if (originalWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
  else process.env.WORKSPACE_DIR = originalWorkspaceDir;
  await fs.rm(root, { recursive: true, force: true });
});

describe('getAttachment: a message that is one attached file', () => {
  it('finds the zip on the payload, saves it, and returns the XML inside', async () => {
    gmailServes(dmarcPayload(), zipOf(XML_NAME, REPORT_XML));

    const result = await handleGetAttachment({ messageId: 'msg-1', filename: ZIP_NAME }, ACCOUNT);

    expect(result.text).toContain(`**${ZIP_NAME}** saved to workspace`);
    expect(result.text).toContain(`### Unpacked from ${ZIP_NAME} (1 file)`);
    expect(result.text).toContain('<source_ip>203.0.113.7</source_ip>');
    expect(result.refs.unpacked).toEqual([
      { filename: XML_NAME, path: path.join(workspace, XML_NAME), size: REPORT_XML.length },
    ]);
    expect((await fs.readdir(workspace)).sort()).toEqual([XML_NAME, ZIP_NAME].sort());
    expect(await fs.readFile(path.join(workspace, XML_NAME), 'utf-8')).toBe(REPORT_XML);
  });

  it('unpacks a gzipped report the same way', async () => {
    const gzName = 'enterprise.protection.outlook.com!example.com!1!2.xml.gz';
    gmailServes(dmarcPayload(gzName, 'application/gzip'), gzipSync(REPORT_XML));

    const result = await handleGetAttachment({ messageId: 'msg-1', filename: gzName }, ACCOUNT);

    expect(result.text).toContain('<source_ip>203.0.113.7</source_ip>');
    expect(result.refs.unpacked).toEqual([
      { filename: gzName.slice(0, -3), path: path.join(workspace, gzName.slice(0, -3)), size: REPORT_XML.length },
    ]);
  });

  it('keeps the download, and says why, when the archive will not unpack', async () => {
    gmailServes(dmarcPayload(), Buffer.from('not really a zip'));

    const result = await handleGetAttachment({ messageId: 'msg-1', filename: ZIP_NAME }, ACCOUNT);

    expect(result.text).toContain(`**${ZIP_NAME}** saved to workspace`);
    expect(result.text).toContain(`_Not unpacked: ${ZIP_NAME} — not a valid zip file (no central directory)._`);
    expect(result.refs.unpacked).toBeUndefined();
    expect(await fs.readdir(workspace)).toEqual([ZIP_NAME]);
  });

  it('keeps an entry named to climb out of the workspace inside it', async () => {
    gmailServes(dmarcPayload(), zipOf('../../escape.xml', REPORT_XML));

    const result = await handleGetAttachment({ messageId: 'msg-1', filename: ZIP_NAME }, ACCOUNT);

    expect(result.refs.unpacked).toEqual([
      { filename: 'escape.xml', path: path.join(workspace, 'escape.xml'), size: REPORT_XML.length },
    ]);
    await expect(fs.access(path.join(root, 'escape.xml'))).rejects.toThrow();
  });

  it('does not try to unpack an attachment that is not an archive', async () => {
    gmailServes(dmarcPayload('notes.txt', 'text/plain'), Buffer.from('just notes'));

    const result = await handleGetAttachment({ messageId: 'msg-1', filename: 'notes.txt' }, ACCOUNT);

    expect(result.text).not.toContain('Unpacked');
    expect(result.text).toContain('just notes');
    expect(result.refs.unpacked).toBeUndefined();
  });
});

describe('viewAttachment: a message that is one attached image', () => {
  it('finds the image on the payload', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    gmailServes({ mimeType: 'image/png', filename: 'scan.png', body: { attachmentId: 'att-png', size: png.length } }, png);

    const result = await handleViewAttachment({ messageId: 'msg-1', filename: 'scan.png' }, ACCOUNT);

    expect(result.content?.[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
  });
});
