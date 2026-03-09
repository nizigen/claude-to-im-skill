/**
 * QQ Official Bot Adapter — implements BaseChannelAdapter for QQ Bot API.
 *
 * Uses WebSocket for receiving events and REST API for sending messages.
 * Supports group @message and C2C (private) message events.
 *
 * API docs: https://bot.q.qq.com/wiki/develop/api-v2/
 */

import crypto from 'node:crypto';
import type {
  ChannelType,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from 'claude-to-im/src/lib/bridge/types.js';
import { BaseChannelAdapter, registerAdapterFactory } from 'claude-to-im/src/lib/bridge/channel-adapter.js';
import { getBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';

const DEDUP_MAX = 1000;
const MAX_TEXT_LENGTH = 2000;

const AUTH_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.sgroup.qq.com';
const SANDBOX_API_BASE = 'https://sandbox.api.sgroup.qq.com';

// ── Intent bits ─────────────────────────────────────────────
// GROUP_AND_C2C_EVENT = 1 << 25
const INTENT_GROUP_AND_C2C = 1 << 25;

// ── Access Token ────────────────────────────────────────────

interface TokenCache {
  token: string;
  expiresAt: number;
}

async function fetchQQAccessToken(appId: string, appSecret: string): Promise<TokenCache> {
  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: appSecret }),
    signal: AbortSignal.timeout(10_000),
  });
  const data: any = await res.json();
  if (!data.access_token) {
    throw new Error(`QQ getAppAccessToken failed: ${JSON.stringify(data)}`);
  }
  const expiresIn = parseInt(data.expires_in, 10) || 7200;
  return {
    token: data.access_token,
    expiresAt: Date.now() + (expiresIn - 300) * 1000,
  };
}

// ── Adapter ─────────────────────────────────────────────────

export class QQBotAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'qq';

  private running = false;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private seenMsgIds = new Map<string, boolean>();
  private tokenCache: TokenCache | null = null;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastSequence: number | null = null;
  private sessionId: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** msg_seq counter for active messages per group */
  private msgSeqMap = new Map<string, number>();

  // ── Lifecycle ─────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[qq-adapter] Cannot start:', configError);
      return;
    }

    // Pre-fetch token
    const { store } = getBridgeContext();
    const appId = store.getSetting('bridge_qq_app_id') || '';
    const appSecret = store.getSetting('bridge_qq_app_secret') || '';
    this.tokenCache = await fetchQQAccessToken(appId, appSecret);

    this.running = true;
    await this.connectWebSocket();
    console.log('[qq-adapter] Started');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(1000, 'shutdown'); } catch { /* ignore */ }
      this.ws = null;
    }

    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];
    this.seenMsgIds.clear();
    this.tokenCache = null;
    this.sessionId = null;
    this.lastSequence = null;

    console.log('[qq-adapter] Stopped');
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
    const token = await this.getAccessToken();
    if (!token) return { ok: false, error: 'Failed to get access token' };

    const apiBase = this.getApiBase();
    const chatId = message.address.chatId;
    const channelMeta = this.parseChatId(chatId);

    let text = message.text.length > MAX_TEXT_LENGTH
      ? message.text.slice(0, MAX_TEXT_LENGTH) + '...'
      : message.text;

    // Append permission commands if inline buttons present
    if (message.inlineButtons && message.inlineButtons.length > 0) {
      const permCommands = message.inlineButtons.flat().map((btn) => {
        if (btn.callbackData.startsWith('perm:')) {
          const parts = btn.callbackData.split(':');
          return `/perm ${parts[1]} ${parts.slice(2).join(':')}`;
        }
        return btn.text;
      });
      text = text + '\n\nReply with:\n' + permCommands.join('\n');
    }

    try {
      let url: string;
      let body: Record<string, unknown>;

      if (channelMeta.type === 'group') {
        const seq = (this.msgSeqMap.get(channelMeta.id) || 0) + 1;
        this.msgSeqMap.set(channelMeta.id, seq);
        url = `${apiBase}/v2/groups/${channelMeta.id}/messages`;
        body = {
          content: text,
          msg_type: 0,
          msg_id: channelMeta.msgId || undefined,
          msg_seq: seq,
        };
      } else {
        url = `${apiBase}/v2/users/${channelMeta.id}/messages`;
        body = {
          content: text,
          msg_type: 0,
          msg_id: channelMeta.msgId || undefined,
        };
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `QQBot ${token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });

      if (res.ok) {
        const data: any = await res.json();
        return { ok: true, messageId: data.id || '' };
      }

      const errData: any = await res.json().catch(() => ({}));
      console.warn('[qq-adapter] Send failed:', res.status, errData);
      return { ok: false, error: `${res.status}: ${errData.message || errData.msg || 'unknown'}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  // ── Config & Auth ─────────────────────────────────────────

  validateConfig(): string | null {
    const { store } = getBridgeContext();
    if (store.getSetting('bridge_qq_enabled') !== 'true')
      return 'bridge_qq_enabled is not true';
    if (!store.getSetting('bridge_qq_app_id'))
      return 'bridge_qq_app_id not configured';
    if (!store.getSetting('bridge_qq_app_secret'))
      return 'bridge_qq_app_secret not configured';
    return null;
  }

  isAuthorized(userId: string, _chatId: string): boolean {
    const allowedUsers = getBridgeContext().store.getSetting('bridge_qq_allowed_users') || '';
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
    const appId = store.getSetting('bridge_qq_app_id') || '';
    const appSecret = store.getSetting('bridge_qq_app_secret') || '';
    try {
      this.tokenCache = await fetchQQAccessToken(appId, appSecret);
      return this.tokenCache.token;
    } catch (err) {
      console.error('[qq-adapter] Token refresh failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  private getApiBase(): string {
    const sandbox = getBridgeContext().store.getSetting('bridge_qq_sandbox') === 'true';
    return sandbox ? SANDBOX_API_BASE : API_BASE;
  }

  // ── WebSocket ─────────────────────────────────────────────

  private async connectWebSocket(): Promise<void> {
    const token = await this.getAccessToken();
    if (!token) {
      console.error('[qq-adapter] Cannot connect: no access token');
      this.scheduleReconnect();
      return;
    }

    const apiBase = this.getApiBase();
    try {
      const gatewayRes = await fetch(`${apiBase}/gateway`, {
        headers: { 'Authorization': `QQBot ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const gatewayData: any = await gatewayRes.json();
      const wsUrl = gatewayData.url;
      if (!wsUrl) {
        throw new Error(`No gateway URL: ${JSON.stringify(gatewayData)}`);
      }

      console.log('[qq-adapter] Connecting to WebSocket:', wsUrl);
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.onopen = () => {
        console.log('[qq-adapter] WebSocket connected');
      };

      ws.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
          this.handleWsMessage(data);
        } catch (err) {
          console.warn('[qq-adapter] Failed to parse WS message:', err);
        }
      };

      ws.onclose = (event: { code: number; reason: string }) => {
        console.log(`[qq-adapter] WebSocket closed: ${event.code} ${event.reason}`);
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        this.ws = null;
        if (this.running) {
          this.scheduleReconnect();
        }
      };

      ws.onerror = (event: Event) => {
        console.error('[qq-adapter] WebSocket error:', event);
      };
    } catch (err) {
      console.error('[qq-adapter] WebSocket connect failed:', err instanceof Error ? err.message : err);
      this.scheduleReconnect();
    }
  }

  private handleWsMessage(data: any): void {
    const op = data.op;
    const s = data.s;
    if (typeof s === 'number') {
      this.lastSequence = s;
    }

    switch (op) {
      case 10: {
        // Hello — start heartbeat and identify
        const heartbeatInterval = data.d?.heartbeat_interval || 41250;
        this.startHeartbeat(heartbeatInterval);
        this.sendIdentify();
        break;
      }
      case 11: {
        // Heartbeat ACK
        break;
      }
      case 0: {
        // Dispatch
        const eventType = data.t;
        const eventData = data.d;
        if (eventType === 'READY') {
          this.sessionId = eventData.session_id;
          console.log('[qq-adapter] Ready, session:', this.sessionId);
        } else if (eventType === 'GROUP_AT_MESSAGE_CREATE') {
          this.handleGroupMessage(eventData);
        } else if (eventType === 'C2C_MESSAGE_CREATE') {
          this.handleC2CMessage(eventData);
        }
        break;
      }
      case 7: {
        // Reconnect requested by server
        console.log('[qq-adapter] Server requested reconnect');
        if (this.ws) {
          try { this.ws.close(); } catch { /* ignore */ }
        }
        break;
      }
      case 9: {
        // Invalid session
        console.warn('[qq-adapter] Invalid session, will reconnect with fresh identify');
        this.sessionId = null;
        this.lastSequence = null;
        if (this.ws) {
          try { this.ws.close(); } catch { /* ignore */ }
        }
        break;
      }
    }
  }

  private sendIdentify(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const { store } = getBridgeContext();
    const appId = store.getSetting('bridge_qq_app_id') || '';
    const token = this.tokenCache?.token || '';

    if (this.sessionId && this.lastSequence !== null) {
      // Resume
      this.ws.send(JSON.stringify({
        op: 6,
        d: {
          token: `QQBot ${token}`,
          session_id: this.sessionId,
          seq: this.lastSequence,
        },
      }));
      console.log('[qq-adapter] Sent Resume');
    } else {
      // Identify
      this.ws.send(JSON.stringify({
        op: 2,
        d: {
          token: `QQBot ${token}`,
          intents: INTENT_GROUP_AND_C2C,
          shard: [0, 1],
        },
      }));
      console.log('[qq-adapter] Sent Identify');
    }
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 1, d: this.lastSequence }));
      }
    }, intervalMs);
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    const delay = 5000 + Math.random() * 5000;
    console.log(`[qq-adapter] Reconnecting in ${Math.round(delay / 1000)}s...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.running) {
        this.connectWebSocket().catch((err) => {
          console.error('[qq-adapter] Reconnect failed:', err instanceof Error ? err.message : err);
        });
      }
    }, delay);
  }

  // ── Event handlers ────────────────────────────────────────

  private handleGroupMessage(data: any): void {
    const msgId = data.id;
    if (!msgId || this.seenMsgIds.has(msgId)) return;
    this.addToDedup(msgId);

    const groupOpenId = data.group_openid || '';
    const userId = data.author?.member_openid || '';
    const content = (data.content || '').trim();
    const timestamp = data.timestamp ? new Date(data.timestamp).getTime() : Date.now();

    if (!this.isAuthorized(userId, groupOpenId)) {
      console.warn('[qq-adapter] Unauthorized group message from:', userId);
      return;
    }

    // Strip @bot mention from content
    const text = content.replace(/<@!\w+>/g, '').trim();
    if (!text) return;

    // Encode chatId as "group:{groupOpenId}:{msgId}" so send() knows the context
    const chatId = `group:${groupOpenId}:${msgId}`;
    const address = {
      channelType: 'qq' as const,
      chatId,
      userId,
    };

    // Check /perm command
    if (text.startsWith('/perm ')) {
      const parts = text.split(/\s+/);
      if (parts.length >= 3) {
        this.enqueue({
          messageId: msgId,
          address,
          text,
          timestamp,
          callbackData: `perm:${parts[1]}:${parts.slice(2).join(' ')}`,
        });
        return;
      }
    }

    this.enqueue({
      messageId: msgId,
      address,
      text,
      timestamp,
    });

    try {
      getBridgeContext().store.insertAuditLog({
        channelType: 'qq',
        chatId: groupOpenId,
        direction: 'inbound',
        messageId: msgId,
        summary: text.slice(0, 200),
      });
    } catch { /* best effort */ }
  }

  private handleC2CMessage(data: any): void {
    const msgId = data.id;
    if (!msgId || this.seenMsgIds.has(msgId)) return;
    this.addToDedup(msgId);

    const userId = data.author?.user_openid || '';
    const content = (data.content || '').trim();
    const timestamp = data.timestamp ? new Date(data.timestamp).getTime() : Date.now();

    if (!this.isAuthorized(userId, '')) {
      console.warn('[qq-adapter] Unauthorized C2C message from:', userId);
      return;
    }

    if (!content) return;

    // Encode chatId as "c2c:{userOpenId}:{msgId}"
    const chatId = `c2c:${userId}:${msgId}`;
    const address = {
      channelType: 'qq' as const,
      chatId,
      userId,
    };

    if (content.startsWith('/perm ')) {
      const parts = content.split(/\s+/);
      if (parts.length >= 3) {
        this.enqueue({
          messageId: msgId,
          address,
          text: content,
          timestamp,
          callbackData: `perm:${parts[1]}:${parts.slice(2).join(' ')}`,
        });
        return;
      }
    }

    this.enqueue({
      messageId: msgId,
      address,
      text: content,
      timestamp,
    });

    try {
      getBridgeContext().store.insertAuditLog({
        channelType: 'qq',
        chatId: userId,
        direction: 'inbound',
        messageId: msgId,
        summary: content.slice(0, 200),
      });
    } catch { /* best effort */ }
  }

  // ── Chat ID parsing ───────────────────────────────────────

  private parseChatId(chatId: string): { type: 'group' | 'c2c'; id: string; msgId?: string } {
    const parts = chatId.split(':');
    if (parts[0] === 'group' && parts.length >= 2) {
      return { type: 'group', id: parts[1], msgId: parts[2] };
    }
    if (parts[0] === 'c2c' && parts.length >= 2) {
      return { type: 'c2c', id: parts[1], msgId: parts[2] };
    }
    // Fallback: treat as C2C
    return { type: 'c2c', id: chatId };
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
registerAdapterFactory('qq', () => new QQBotAdapter());
