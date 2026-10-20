/**
 * Gmail attachment handler — downloads or views email attachments.
 *
 * The agent discovers attachments via the `read` operation, which lists
 * filenames and sizes. Then calls `getAttachment` to save to workspace,
 * or `viewAttachment` to view images inline without saving.
 *
 * Flow: read → see filenames → getAttachment/viewAttachment(messageId, filename)
 */

import { call } from '../../google/client.js';
import { requireString } from '../../server/handlers/validate.js';
import { saveToWorkspace, formatFileOutput, isImageFile, buildImageBlock, getImageMimeType } from '../../executor/file-output.js';
import { archiveKind, unpack, type UnpackResult } from '../../executor/archive.js';
import { extractAttachments, type AttachmentRef, type HandlerResponse } from '../../server/formatting/markdown.js';

/** Fetch raw attachment data by messageId and filename. Returns the buffer and metadata. */
async function fetchAttachmentData(
  messageId: string,
  filename: string,
  account: string,
): Promise<{ buffer: Buffer; match: AttachmentRef }> {
  // Read the message to find the attachment ID for this filename
  const msg = await call('gmail', 'users.messages.get', {
    userId: 'me',
    id: messageId,
  }, { account }) as Record<string, unknown>;

  const allAttachments = extractAttachments(msg.payload);

  const match = allAttachments.find(a => a.filename === filename);
  if (!match) {
    const available = allAttachments.map(a => a.filename).join(', ') || '(none)';
    throw new Error(
      `Attachment '${filename}' not found in message ${messageId}. ` +
      `Available attachments: ${available}`,
    );
  }

  // Fetch the attachment data
  const data = await call('gmail', 'users.messages.attachments.get', {
    userId: 'me',
    messageId,
    id: match.attachmentId,
  }, { account }) as Record<string, unknown>;

  const base64Data = String(data.data ?? '');

  if (!base64Data) {
    throw new Error('Attachment data is empty');
  }

  // Decode base64url to buffer
  const base64Standard = base64Data.replace(/-/g, '+').replace(/_/g, '/');
  const buffer = Buffer.from(base64Standard, 'base64');

  return { buffer, match };
}

/**
 * Download an email attachment by filename — saves to workspace.
 */
export async function handleGetAttachment(
  params: Record<string, unknown>,
  account: string,
): Promise<HandlerResponse> {
  const messageId = requireString(params, 'messageId');
  const filename = requireString(params, 'filename');

  const { buffer, match } = await fetchAttachmentData(messageId, filename, account);
  const output = await saveToWorkspace(filename, buffer, match.mimeType);
  const unpacked = await unpackToWorkspace(filename, match.mimeType, buffer);

  return {
    text: [formatFileOutput(output), ...unpacked.text].join('\n\n'),
    refs: {
      filename: output.filename,
      path: output.path,
      size: output.size,
      messageId,
      ...(output.content ? { content: output.content } : {}),
      ...(unpacked.files.length > 0 ? { unpacked: unpacked.files } : {}),
    },
    ...(output.imageBlock ? { content: [output.imageBlock] } : {}),
  };
}

/**
 * A .zip or .gz attachment is also unpacked into the workspace, and the text inside it
 * returned the way a text attachment's is — so a zipped DMARC report reads as its XML,
 * with no shell needed. The archive itself is saved either way; when it will not unpack,
 * the reply says why instead of failing the download.
 */
async function unpackToWorkspace(
  filename: string,
  mimeType: string,
  buffer: Buffer,
): Promise<{ text: string[]; files: Array<{ filename: string; path: string; size: number }> }> {
  const kind = archiveKind(filename, mimeType);
  if (!kind) return { text: [], files: [] };

  let result: UnpackResult;
  try {
    result = unpack(kind, filename, buffer);
  } catch (err) {
    return { text: [`_Not unpacked: ${filename} — ${(err as Error).message}._`], files: [] };
  }

  const text: string[] = [];
  const files: Array<{ filename: string; path: string; size: number }> = [];
  const skipped = [...result.skipped];
  const used = new Set<string>();
  for (const [i, file] of result.files.entries()) {
    // Flat in the workspace, by the entry's own name; folders inside the archive are dropped.
    let name = file.name.split(/[/\\]/).pop() || `file-${i + 1}`;
    if (used.has(name)) name = `${i + 1}-${name}`;
    used.add(name);
    try {
      const out = await saveToWorkspace(name, file.data);
      text.push(formatFileOutput(out));
      files.push({ filename: out.filename, path: out.path, size: out.size });
    } catch (err) {
      skipped.push(`${file.name} (${(err as Error).message})`);
    }
  }

  const count = `${files.length} file${files.length === 1 ? '' : 's'}`;
  text.unshift(`### Unpacked from ${filename} (${count})`);
  if (skipped.length > 0) text.push(`_Left packed: ${skipped.join('; ')}._`);
  return { text, files };
}

/**
 * View an image attachment inline without saving to workspace.
 */
export async function handleViewAttachment(
  params: Record<string, unknown>,
  account: string,
): Promise<HandlerResponse> {
  const messageId = requireString(params, 'messageId');
  const filename = requireString(params, 'filename');

  const { buffer, match } = await fetchAttachmentData(messageId, filename, account);

  if (!isImageFile(filename, match.mimeType)) {
    throw new Error(
      `"${filename}" (${match.mimeType}) is not a viewable image type. ` +
      `Use getAttachment to download it instead.`,
    );
  }

  const imageBlock = buildImageBlock(buffer, filename, match.mimeType);
  if (!imageBlock) {
    throw new Error(
      `Image too large to view inline (${(buffer.length / 1024 / 1024).toFixed(1)} MB). ` +
      `Use getAttachment to download it instead.`,
    );
  }

  return {
    text: `## ${filename}\n\n**Type:** ${getImageMimeType(filename, match.mimeType)}\n**Size:** ${buffer.length} bytes\n\n_Image displayed inline below. Use getAttachment to save to workspace._`,
    refs: { filename, messageId, mimeType: match.mimeType, size: buffer.length },
    content: [imageBlock],
  };
}
