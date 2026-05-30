export interface BotConfig {
  id: string;
  name: string;
  token: string;
  adminGroupId: string;
  webhookSecret: string;
  active: boolean;
  createdAt: number;
}

const BOTS_LIST_KEY = "bots:list";
const BOT_PREFIX = "bots:";

function generateId(): string {
  return crypto.randomUUID().slice(0, 8);
}

function generateSecret(bytes = 24): string {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  return Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class BotManager {
  constructor(private kv: KVNamespace) {}

  private botKey(id: string): string {
    return `${BOT_PREFIX}${id}`;
  }

  async list(): Promise<BotConfig[]> {
    const raw = await this.kv.get(BOTS_LIST_KEY);
    if (!raw) return [];
    try {
      const ids: string[] = JSON.parse(raw);
      const bots: BotConfig[] = [];
      for (const id of ids) {
        const bot = await this.get(id);
        if (bot) bots.push(bot);
      }
      return bots;
    } catch {
      return [];
    }
  }

  async get(id: string): Promise<BotConfig | null> {
    const raw = await this.kv.get(this.botKey(id));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as BotConfig;
    } catch {
      return null;
    }
  }

  async add(name: string, token: string, adminGroupId: string): Promise<BotConfig> {
    const id = generateId();
    const bot: BotConfig = {
      id,
      name,
      token,
      adminGroupId,
      webhookSecret: generateSecret(),
      active: false,
      createdAt: Date.now(),
    };
    await this.kv.put(this.botKey(id), JSON.stringify(bot));

    const raw = await this.kv.get(BOTS_LIST_KEY);
    const ids: string[] = raw ? JSON.parse(raw) : [];
    ids.push(id);
    await this.kv.put(BOTS_LIST_KEY, JSON.stringify(ids));

    return bot;
  }

  async update(id: string, patch: Partial<Pick<BotConfig, "name" | "token" | "adminGroupId" | "active">>): Promise<BotConfig | null> {
    const bot = await this.get(id);
    if (!bot) return null;

    if (patch.name !== undefined) bot.name = patch.name;
    if (patch.token !== undefined) bot.token = patch.token;
    if (patch.adminGroupId !== undefined) bot.adminGroupId = patch.adminGroupId;
    if (patch.active !== undefined) bot.active = patch.active;

    // Regenerate secret if token changed
    if (patch.token !== undefined) {
      bot.webhookSecret = generateSecret();
    }

    await this.kv.put(this.botKey(id), JSON.stringify(bot));
    return bot;
  }

  async remove(id: string): Promise<boolean> {
    const raw = await this.kv.get(BOTS_LIST_KEY);
    if (!raw) return false;
    const ids: string[] = JSON.parse(raw);
    const idx = ids.indexOf(id);
    if (idx === -1) return false;

    ids.splice(idx, 1);
    await this.kv.put(BOTS_LIST_KEY, JSON.stringify(ids));
    await this.kv.delete(this.botKey(id));
    return true;
  }

  async setActive(id: string, active: boolean): Promise<BotConfig | null> {
    return this.update(id, { active });
  }

  async findByWebhookPath(botId: string, secret: string): Promise<BotConfig | null> {
    const bot = await this.get(botId);
    if (!bot || !bot.active) return null;
    if (bot.webhookSecret !== secret) return null;
    return bot;
  }
}