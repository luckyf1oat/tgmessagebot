export interface CaptchaChallenge {
  a: number;
  b: number;
  answer: number;
}

interface CaptchaState {
  answer: number;
  expiresAt: number;
}

const VERIFIED_PREFIX = "verified:";
const CAPTCHA_PREFIX = "captcha:";
const USER_THREAD_PREFIX = "user_thread:";
const THREAD_USER_PREFIX = "thread_user:";
const PROFILE_SENT_PREFIX = "profile_sent:";
const BLOCKED_PREFIX = "blocked:";
const MESSAGE_LINK_PREFIX = "message_link:";

export interface MessageLink {
  chatId: number;
  messageId: number;
}

export class BotStore {
  constructor(private kv: KVNamespace, private botId = "default") {}

  private scoped(key: string) {
    return `bot:${this.botId}:${key}`;
  }

  verifiedKey(userId: number) {
    return this.scoped(`${VERIFIED_PREFIX}${userId}`);
  }

  captchaKey(userId: number) {
    return this.scoped(`${CAPTCHA_PREFIX}${userId}`);
  }

  userThreadKey(userId: number) {
    return this.scoped(`${USER_THREAD_PREFIX}${userId}`);
  }

  threadUserKey(threadId: number) {
    return this.scoped(`${THREAD_USER_PREFIX}${threadId}`);
  }

  profileSentKey(userId: number) {
    return this.scoped(`${PROFILE_SENT_PREFIX}${userId}`);
  }

  blockedKey(userId: number) {
    return this.scoped(`${BLOCKED_PREFIX}${userId}`);
  }

  messageLinkKey(chatId: number, messageId: number) {
    return this.scoped(`${MESSAGE_LINK_PREFIX}${chatId}:${messageId}`);
  }

  async isVerified(userId: number): Promise<boolean> {
    const value = await this.kv.get(this.verifiedKey(userId));
    return value === "1";
  }

  async setVerified(userId: number): Promise<void> {
    await this.kv.put(this.verifiedKey(userId), "1");
  }

  async clearCaptcha(userId: number): Promise<void> {
    await this.kv.delete(this.captchaKey(userId));
  }

  async saveCaptcha(userId: number, answer: number, ttlSec: number): Promise<void> {
    const payload: CaptchaState = {
      answer,
      expiresAt: Date.now() + ttlSec * 1000
    };
    await this.kv.put(this.captchaKey(userId), JSON.stringify(payload), {
      expirationTtl: ttlSec
    });
  }

  async getCaptcha(userId: number): Promise<CaptchaState | null> {
    const raw = await this.kv.get(this.captchaKey(userId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CaptchaState;
    } catch {
      return null;
    }
  }

  async getThreadIdByUser(userId: number): Promise<number | null> {
    const raw = await this.kv.get(this.userThreadKey(userId));
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  async getUserIdByThread(threadId: number): Promise<number | null> {
    const raw = await this.kv.get(this.threadUserKey(threadId));
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  async bindUserThread(userId: number, threadId: number): Promise<void> {
    await Promise.all([
      this.kv.put(this.userThreadKey(userId), String(threadId)),
      this.kv.put(this.threadUserKey(threadId), String(userId))
    ]);
  }

  async clearUserThread(userId: number, threadId: number): Promise<void> {
    await Promise.all([
      this.kv.delete(this.userThreadKey(userId)),
      this.kv.delete(this.threadUserKey(threadId)),
      this.kv.delete(this.profileSentKey(userId))
    ]);
  }

  async isProfileSent(userId: number): Promise<boolean> {
    const v = await this.kv.get(this.profileSentKey(userId));
    return v === "1";
  }

  async markProfileSent(userId: number): Promise<void> {
    await this.kv.put(this.profileSentKey(userId), "1");
  }

  async isBlocked(userId: number): Promise<boolean> {
    const v = await this.kv.get(this.blockedKey(userId));
    return v === "1";
  }

  async setBlocked(userId: number, blocked: boolean): Promise<void> {
    if (blocked) {
      await this.kv.put(this.blockedKey(userId), "1");
      return;
    }
    await this.kv.delete(this.blockedKey(userId));
  }

  async bindMessageLink(from: MessageLink, to: MessageLink): Promise<void> {
    await Promise.all([
      this.kv.put(this.messageLinkKey(from.chatId, from.messageId), JSON.stringify(to)),
      this.kv.put(this.messageLinkKey(to.chatId, to.messageId), JSON.stringify(from))
    ]);
  }

  async getLinkedMessage(chatId: number, messageId: number): Promise<MessageLink | null> {
    const raw = await this.kv.get(this.messageLinkKey(chatId, messageId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as MessageLink;
      if (Number.isFinite(parsed.chatId) && Number.isFinite(parsed.messageId)) return parsed;
      return null;
    } catch {
      return null;
    }
  }
}

export function createCaptcha(): CaptchaChallenge {
  const a = Math.floor(Math.random() * 9) + 1;
  const b = Math.floor(Math.random() * 9) + 1;
  return { a, b, answer: a + b };
}

export function parseAnswer(text?: string): number | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!/^[-+]?\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}
