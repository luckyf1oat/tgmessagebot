export interface TelegramApiResult<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  reply_to_message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export interface CreateForumTopicResult {
  message_thread_id: number;
  name: string;
  icon_color: number;
}

export interface UserProfilePhotosResult {
  total_count: number;
  photos: Array<Array<{ file_id: string }>>;
}

export class TelegramClient {
  constructor(private token: string) {}

  private get apiBase() {
    return `https://api.telegram.org/bot${this.token}`;
  }

  async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const resp = await fetch(`${this.apiBase}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    const json = (await resp.json()) as TelegramApiResult<T>;
    if (!json.ok || json.result === undefined) {
      throw new Error(`Telegram API ${method} failed: ${json.description || "unknown error"}`);
    }
    return json.result;
  }

  async sendMessage(chatId: number, text: string, messageThreadId?: number): Promise<void> {
    await this.call("sendMessage", {
      chat_id: chatId,
      text,
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {})
    });
  }

  async sendPhoto(chatId: number, photo: string, caption?: string, messageThreadId?: number): Promise<void> {
    await this.call("sendPhoto", {
      chat_id: chatId,
      photo,
      ...(caption ? { caption } : {}),
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {})
    });
  }

  async copyMessage(
    toChatId: number,
    fromChatId: number,
    messageId: number,
    messageThreadId?: number
  ): Promise<void> {
    await this.call("copyMessage", {
      chat_id: toChatId,
      from_chat_id: fromChatId,
      message_id: messageId,
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {})
    });
  }

  async createForumTopic(chatId: number, name: string): Promise<CreateForumTopicResult> {
    return await this.call<CreateForumTopicResult>("createForumTopic", {
      chat_id: chatId,
      name
    });
  }

  async getUserProfilePhotos(userId: number): Promise<UserProfilePhotosResult> {
    return await this.call<UserProfilePhotosResult>("getUserProfilePhotos", {
      user_id: userId,
      limit: 1
    });
  }
}
