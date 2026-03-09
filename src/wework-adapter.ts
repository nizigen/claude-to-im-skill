/**
 * WeChat Work (企业微信) Adapter — implements BaseChannelAdapter for WeChat Work.
 *
 * Uses an HTTP callback server to receive messages and the REST API to send.
 * The user must configure a callback URL in WeChat Work admin console pointing
 * to this server (directly or via a tunnel like ngrok/cloudflare).
 *
 * Message encryption uses AES-256-CBC with the EncodingAESKey from config.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import type {
  ChannelType,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from 'claude-to-im/src/lib/bridge/types.js';
import { BaseChannelAdapter, registerAdapterFactory } from 'claude-to-im/src/lib/bridge/channel-adapter.js';
import { getBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';

const DEDUP_MAX = 1000;
const MAX_TEXT_LENGTH = 2048;

// ── XML helpers ─────────────────────────────────────────────

function extractXmlValue(xml: string, tag: string): string {
  const re = new RegExp(
    `<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}>([^<]*)</${tag}>`,
  );
  const match = xml.match(re);
  return match ? (match[1] || match[2] || '') : '';
}

// ── WeChat Work crypto ──────────────────────────────────────

function decodeAESKey(encodingAESKey: string): Buffer {
  return Buffer.from(encodingAESKey + '=', 'base64');
}

function sha1(...args: string[]): string {
  return crypto.createHash('sha1').update(args.sort().join('')).digest('hex');
}

function decrypt(encrypted: string, aesKey: Buffer, corpId: string): string {
  const iv = aesKey.subarray(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([
    decipher.update(encrypted, 'base64'),
    decipher.final(),
  ]);
  // Remove PKCS#7 padding (block size 32)
  const padLen = decrypted[decrypted.length - 1];
  const content = decrypted.subarray(0, decrypted.length - padLen);
  // Format: random(16) + msgLen(4, big-endian) + msg + receiveid
  const msgLen = content.readUInt32BE(16);
  const msg = content.subarray(20, 20 + msgLen).toString('utf-8');
  const receiveid = content.subarray(20 + msgLen).toString('utf-8');
  if (receiveid !== corpId) {
    throw new Error(`CorpID mismatch: expected ${corpId}, got ${receiveid}`);
  }
  return msg;
}

function encrypt(msg: string, aesKey: Buffer, corpId: string): string {
  const random = crypto.randomBytes(16);
  const msgBuf = Buffer.from(msg, 'utf-8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length, 0);
  const corpBuf = Buffer.from(corpId, 'utf-8');
  const plain = Buffer.concat([random, lenBuf, msgBuf, corpBuf]);
  // PKCS#7 padding (block size 32)
  const blockSize = 32;
  const padLen = blockSize - (plain.length % blockSize);
  const padBuf = Buffer.alloc(padLen, padLen);
  const padded = Buffer.concat([plain, padBuf]);
  const iv = aesKey.subarray(0, 16);
  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}

// ── Access Token management ─────────────────────────────────

interface TokenCache {
  token: string;
  expiresAt: number;
}

async function fetchAccessToken(corpId: string, corpSecret: string): Promise<TokenCache> {
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(corpSecret)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const data: any = await res.json();
  if (data.errcode !== 0) {
    throw new Error(`WeWork gettoken failed: ${data.errcode} ${data.errmsg}`);
  }
  return {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 300) * 1000,
  };
}

// ── Adapter ─────────────────────────────────────────────────

export class WeWorkAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'wework';

  private running = false;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private server: http.Server | null = null;
  private seenMsgIds = new Map<string, boolean>();
  private tokenCache: TokenCache | null = null;
  private aesKey: Buffer | null = null;

  // ── Lifecycle ─────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[wework-adapter] Cannot start:', configError);
      return;
    }

    const { store } = getBridgeContext();
    const encodingAESKey = store.getSetting('bridge_wework_encoding_aes_key') || '';
    this.aesKey = decodeAESKey(encodingAESKey);

    // Pre-fetch access token
    const corpId = store.getSetting('bridge_wework_corpid') || '';
    const corpSecret = store.getSetting('bridge_wework_corpsecret') || '';
    this.tokenCache = await fetchAccessToken(corpId, corpSecret);

    // Start HTTP callback server
    const port = parseInt(store.getSetting('bridge_wework_callback_port') || '', 10) || 8788;
    const host = store.getSetting('bridge_wework_callback_host') || '127.0.0.1';

    this.server = http.createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, host, () => resolve());
      this.server!.on('error', reject);
    });

    this.running = true;
    console.log(`[wework-adapter] Started (listening on ${host}:${port})`);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];
    this.seenMsgIds.clear();
    this.tokenCache = null;
    this.aesKey = null;

    console.log('[wework-adapter] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Queue ─────────────────────────────────────────────────

  consumeOne(): Promise<InboundMessage | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (!this.running) return Promise.resolve(null);
    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private enqueue(msg: InboundMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      this.queue.push(msg);
    }
  }

  // ── Send ──────────────────────────────────────────────────

  async send(message: OutboundMessage): Promise<SendResult> {
    const { store } = getBridgeContext();
    const agentId = store.getSetting('bridge_wework_agentid') || '';

    const token = await this.getAccessToken();
    if (!token) return { ok: false, error: 'Failed to get access token' };

    // WeChat Work text message limit is ~2048 chars; chunk if needed
    const text = message.text.length > MAX_TEXT_LENGTH
      ? message.text.slice(0, MAX_TEXT_LENGTH) + '...'
      : message.text;

    // If we have inline buttons (permission prompts), append as text commands
    let finalText = text;
    if (message.inlineButtons && message.inlineButtons.length > 0) {
      const permCommands = message.inlineButtons.flat().map((btn) => {
        if (btn.callbackData.startsWith('perm:')) {
          const parts = btn.callbackData.split(':');
          return `/perm ${parts[1]} ${parts.slice(2).join(':')}`;
        }
        return btn.text;
      });
      finalText = text + '\n\nReply with:\n' + permCommands.join('\n');
    }

    // Determine target: touser (userId) or toparty/totag
    const userId = message.address.userId || '@all';

    const body = {
      touser: userId,
      msgtype: 'text',
      agentid: parseInt(agentId, 10),
      text: { content: finalText },
    };

    try {
      const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      const data: any = await res.json();
      if (data.errcode === 0) {
        return { ok: true, messageId: data.msgid || '' };
      }
      console.warn('[wework-adapter] Send failed:', data.errcode, data.errmsg);
      return { ok: false, error: `${data.errcode}: ${data.errmsg}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  // ── Config & Auth ─────────────────────────────────────────

  validateConfig(): string | null {
    const { store } = getBridgeContext();
    if (store.getSetting('bridge_wework_enabled') !== 'true')
      return 'bridge_wework_enabled is not true';
    if (!store.getSetting('bridge_wework_corpid'))
      return 'bridge_wework_corpid not configured';
    if (!store.getSetting('bridge_wework_corpsecret'))
      return 'bridge_wework_corpsecret not configured';
    if (!store.getSetting('bridge_wework_agentid'))
      return 'bridge_wework_agentid not configured';
    if (!store.getSetting('bridge_wework_token'))
      return 'bridge_wework_token not configured';
    if (!store.getSetting('bridge_wework_encoding_aes_key'))
      return 'bridge_wework_encoding_aes_key not configured';
    return null;
  }

  isAuthorized(userId: string, _chatId: string): boolean {
    const allowedUsers = getBridgeContext().store.getSetting('bridge_wework_allowed_users') || '';
    if (!allowedUsers) return true;
    const allowed = allowedUsers.split(',').map((s: string) => s.trim()).filter(Boolean);
    if (allowed.length === 0) return true;
    return allowed.includes(userId);
  }

  // ── Access Token ──────────────────────────────────────────

  private async getAccessToken(): Promise<string | null> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now()) {
      return this.tokenCache.token;
    }
    const { store } = getBridgeContext();
    const corpId = store.getSetting('bridge_wework_corpid') || '';
    const corpSecret = store.getSetting('bridge_wework_corpsecret') || '';
    try {
      this.tokenCache = await fetchAccessToken(corpId, corpSecret);
      return this.tokenCache.token;
    } catch (err) {
      console.error('[wework-adapter] Token refresh failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  // ── HTTP Callback ─────────────────────────────────────────

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const { store } = getBridgeContext();
    const token = store.getSetting('bridge_wework_token') || '';
    const corpId = store.getSetting('bridge_wework_corpid') || '';

    if (req.method === 'GET') {
      // URL verification
      const msgSignature = url.searchParams.get('msg_signature') || '';
      const timestamp = url.searchParams.get('timestamp') || '';
      const nonce = url.searchParams.get('nonce') || '';
      const echostr = url.searchParams.get('echostr') || '';

      const expectedSig = sha1(token, timestamp, nonce, echostr);
      if (expectedSig !== msgSignature) {
        console.warn('[wework-adapter] URL verification signature mismatch');
        res.writeHead(403);
        res.end('Signature mismatch');
        return;
      }

      try {
        const decrypted = decrypt(echostr, this.aesKey!, corpId);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(decrypted);
        console.log('[wework-adapter] URL verification succeeded');
      } catch (err) {
        console.error('[wework-adapter] URL verification decrypt failed:', err);
        res.writeHead(500);
        res.end('Decrypt failed');
      }
      return;
    }

    if (req.method === 'POST') {
      const msgSignature = url.searchParams.get('msg_signature') || '';
      const timestamp = url.searchParams.get('timestamp') || '';
      const nonce = url.searchParams.get('nonce') || '';

      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString('utf-8'); });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end('success');

        try {
          this.processCallback(body, msgSignature, timestamp, nonce, token, corpId);
        } catch (err) {
          console.error('[wework-adapter] Callback processing error:', err);
        }
      });
      return;
    }

    res.writeHead(405);
    res.end('Method not allowed');
  }

  private processCallback(
    xmlBody: string,
    msgSignature: string,
    timestamp: string,
    nonce: string,
    token: string,
    corpId: string,
  ): void {
    const encryptedMsg = extractXmlValue(xmlBody, 'Encrypt');
    if (!encryptedMsg) {
      console.warn('[wework-adapter] No Encrypt field in callback XML');
      return;
    }

    // Verify signature
    const expectedSig = sha1(token, timestamp, nonce, encryptedMsg);
    if (expectedSig !== msgSignature) {
      console.warn('[wework-adapter] Callback signature mismatch');
      return;
    }

    // Decrypt
    const decryptedXml = decrypt(encryptedMsg, this.aesKey!, corpId);

    const msgType = extractXmlValue(decryptedXml, 'MsgType');
    const msgId = extractXmlValue(decryptedXml, 'MsgId');
    const fromUser = extractXmlValue(decryptedXml, 'FromUserName');
    const createTime = extractXmlValue(decryptedXml, 'CreateTime');

    // Dedup
    if (msgId && this.seenMsgIds.has(msgId)) return;
    if (msgId) this.addToDedup(msgId);

    // Authorization
    if (!this.isAuthorized(fromUser, '')) {
      console.warn('[wework-adapter] Unauthorized message from:', fromUser);
      return;
    }

    let text = '';
    if (msgType === 'text') {
      text = extractXmlValue(decryptedXml, 'Content');
    } else {
      console.log(`[wework-adapter] Unsupported message type: ${msgType}`);
      return;
    }

    if (!text.trim()) return;

    const address = {
      channelType: 'wework' as const,
      chatId: fromUser,
      userId: fromUser,
      displayName: fromUser,
    };

    // Check for /perm text command
    const trimmedText = text.trim();
    if (trimmedText.startsWith('/perm ')) {
      const permParts = trimmedText.split(/\s+/);
      if (permParts.length >= 3) {
        const action = permParts[1];
        const permId = permParts.slice(2).join(' ');
        this.enqueue({
          messageId: msgId || String(Date.now()),
          address,
          text: trimmedText,
          timestamp: parseInt(createTime, 10) * 1000 || Date.now(),
          callbackData: `perm:${action}:${permId}`,
        });
        return;
      }
    }

    this.enqueue({
      messageId: msgId || String(Date.now()),
      address,
      text: trimmedText,
      timestamp: parseInt(createTime, 10) * 1000 || Date.now(),
    });

    // Audit log
    try {
      getBridgeContext().store.insertAuditLog({
        channelType: 'wework',
        chatId: fromUser,
        direction: 'inbound',
        messageId: msgId || '',
        summary: text.slice(0, 200),
      });
    } catch { /* best effort */ }
  }

  // ── Utilities ─────────────────────────────────────────────

  private addToDedup(msgId: string): void {
    this.seenMsgIds.set(msgId, true);
    if (this.seenMsgIds.size > DEDUP_MAX) {
      const excess = this.seenMsgIds.size - DEDUP_MAX;
      let removed = 0;
      for (const key of this.seenMsgIds.keys()) {
        if (removed >= excess) break;
        this.seenMsgIds.delete(key);
        removed++;
      }
    }
  }
}

// Self-register
registerAdapterFactory('wework', () => new WeWorkAdapter());
