import { BotStore, createCaptcha, parseAnswer } from "./captcha";
import { TelegramCallbackQuery, TelegramClient, TelegramMessage, TelegramUpdate, TelegramUser } from "./telegram";

interface Env {
  BOT_KV: KVNamespace;
  BOT_TOKEN: string;
  ADMIN_GROUP_ID: string;
  WEBHOOK_SECRET?: string;
}

const CAPTCHA_TTL_SECONDS = 5 * 60;
const WEBHOOK_SECRET_KV_KEY = "config:webhook_secret";

function generateRandomSecret(bytes = 24): string {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  return Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function resolveWebhookSecret(env: Env): Promise<string> {
  const configured = env.WEBHOOK_SECRET?.trim();
  if (configured) return configured;

  const existing = (await env.BOT_KV.get(WEBHOOK_SECRET_KV_KEY))?.trim();
  if (existing) return existing;

  const generated = generateRandomSecret();
  await env.BOT_KV.put(WEBHOOK_SECRET_KV_KEY, generated);
  return generated;
}

function topicNameFor(user: TelegramUser) {
  const nick = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  const uname = user.username ? `@${user.username}` : "no_username";
  return `${nick || "Unknown"} (${uname}) #${user.id}`.slice(0, 120);
}

function userCardText(user: TelegramUser) {
  const nick = [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || "未设置";
  const uname = user.username ? `@${user.username}` : "未设置";
  return `👤 用户名片\n- 昵称: ${nick}\n- 用户名: ${uname}\n- 用户链接: tg://user?id=${user.id}`;
}

function userCardButtons(userId: number) {
  return {
    inline_keyboard: [
      [
        { text: "🚫 拉黑用户", callback_data: `block:${userId}` },
        { text: "✅ 取消拉黑", callback_data: `unblock:${userId}` }
      ],
      [
        { text: "🗑️ 删除对话", callback_data: `delete_thread:${userId}` }
      ]
    ]
  };
}

async function relayMessageWithStickerFallback(
  tg: TelegramClient,
  toChatId: number,
  fromChatId: number,
  message: TelegramMessage,
  messageThreadId?: number
) {
  try {
    await tg.copyMessage(toChatId, fromChatId, message.message_id, messageThreadId);
    return;
  } catch (copyErr) {
    if (!message.sticker?.file_id) throw copyErr;
    // 某些贴纸在 copyMessage 路径可能失败，贴纸场景降级为 sendSticker
    await tg.sendSticker(toChatId, message.sticker.file_id, messageThreadId);
  }
}

async function ensureThreadForUser(
  tg: TelegramClient,
  store: BotStore,
  adminGroupId: number,
  user: TelegramUser
): Promise<number> {
  let threadId = await store.getThreadIdByUser(user.id);
  if (threadId) return threadId;

  const topic = await tg.createForumTopic(adminGroupId, topicNameFor(user));
  threadId = topic.message_thread_id;
  await store.bindUserThread(user.id, threadId);

  const profileSent = await store.isProfileSent(user.id);
  if (!profileSent) {
    const replyMarkup = userCardButtons(user.id);
    const photos = await tg.getUserProfilePhotos(user.id);
    const fileId = photos.photos?.[0]?.[0]?.file_id;
    if (fileId) {
      await tg.sendPhoto(adminGroupId, fileId, userCardText(user), threadId, replyMarkup);
    } else {
      await tg.sendMessage(adminGroupId, userCardText(user), threadId, replyMarkup);
    }
    await store.markProfileSent(user.id);
  }

  return threadId;
}

async function askCaptcha(tg: TelegramClient, store: BotStore, userId: number) {
  const challenge = createCaptcha();
  await store.saveCaptcha(userId, challenge.answer, CAPTCHA_TTL_SECONDS);
  await tg.sendMessage(userId, `请先完成验证：${challenge.a} + ${challenge.b} = ?\n直接回复数字即可。`);
}

async function handlePrivateMessage(
  tg: TelegramClient,
  store: BotStore,
  adminGroupId: number,
  message: TelegramMessage
) {
  const user = message.from;
  if (!user) return;

  if (await store.isBlocked(user.id)) {
    await tg.sendMessage(user.id, "⛔ 你已被管理员拉黑，暂时无法继续发送消息。")
    return;
  }

  const text = message.text?.trim();
  if (text === "/start") {
    if (await store.isVerified(user.id)) {
      await tg.sendMessage(user.id, "欢迎回来，直接发送消息即可联系管理员。支持文本/图片/文件/语音等。")
      return;
    }
    await askCaptcha(tg, store, user.id);
    return;
  }

  const verified = await store.isVerified(user.id);
  if (!verified) {
    const captcha = await store.getCaptcha(user.id);
    if (!captcha || captcha.expiresAt < Date.now()) {
      await askCaptcha(tg, store, user.id);
      return;
    }

    const answer = parseAnswer(message.text);
    if (answer === null) {
      await tg.sendMessage(user.id, "请回复数字答案，例如 8。")
      return;
    }

    if (answer !== captcha.answer) {
      await tg.sendMessage(user.id, "答案不正确，重新来一题。")
      await askCaptcha(tg, store, user.id);
      return;
    }

    await store.setVerified(user.id);
    await store.clearCaptcha(user.id);
    await tg.sendMessage(user.id, "✅ 验证通过！现在可以开始发送消息。")
    return;
  }

  const threadId = await ensureThreadForUser(tg, store, adminGroupId, user);
  await relayMessageWithStickerFallback(tg, adminGroupId, message.chat.id, message, threadId);
}

async function handleCallbackQuery(
  tg: TelegramClient,
  store: BotStore,
  adminGroupId: number,
  callbackQuery: TelegramCallbackQuery
) {
  const data = callbackQuery.data?.trim();
  if (!data) return;

  const matched = /^(block|unblock|delete_thread):(\d+)$/.exec(data);
  if (!matched) return;

  const action = matched[1];
  const targetUserId = Number(matched[2]);
  if (!Number.isFinite(targetUserId)) return;

  const message = callbackQuery.message;
  if (!message || message.chat.id !== adminGroupId) {
    await tg.answerCallbackQuery(callbackQuery.id, "此按钮仅可在管理员群中使用", true);
    return;
  }

  const threadId = message.message_thread_id;
  if (!threadId) {
    await tg.answerCallbackQuery(callbackQuery.id, "未识别到用户话题", true);
    return;
  }

  const mappedUserId = await store.getUserIdByThread(threadId);
  if (!mappedUserId || mappedUserId !== targetUserId) {
    await tg.answerCallbackQuery(callbackQuery.id, "按钮与当前话题用户不匹配", true);
    return;
  }

  if (action === "delete_thread") {
    await store.clearUserThread(targetUserId, threadId);
    await tg.answerCallbackQuery(callbackQuery.id, "已删除对话");
    try {
      await tg.deleteForumTopic(adminGroupId, threadId);
    } catch (error) {
      console.error("Delete forum topic failed:", { targetUserId, threadId, error });
      await tg.sendMessage(
        adminGroupId,
        `⚠️ 已清理会话映射，但删除话题失败\n- 用户: tg://user?id=${targetUserId}\n- 你可手动删除该话题`,
        threadId
      );
    }
    return;
  }

  const willBlock = action === "block";
  await store.setBlocked(targetUserId, willBlock);

  await tg.answerCallbackQuery(callbackQuery.id, willBlock ? "已拉黑该用户" : "已取消拉黑");
  await tg.sendMessage(
    adminGroupId,
    willBlock
      ? `🚫 已拉黑用户 tg://user?id=${targetUserId}，后续该用户消息将不再转发。`
      : `✅ 已取消拉黑 tg://user?id=${targetUserId}，该用户可继续发消息。`,
    threadId
  );
}

async function handleAdminGroupMessage(
  tg: TelegramClient,
  store: BotStore,
  adminGroupId: number,
  message: TelegramMessage
) {
  if (message.chat.id !== adminGroupId) return;
  if (message.from?.is_bot) return;

  const threadId = message.message_thread_id;
  if (!threadId) return;

  const userId = await store.getUserIdByThread(threadId);
  if (!userId) return;

  try {
    await relayMessageWithStickerFallback(tg, userId, adminGroupId, message);
  } catch (error) {
    console.error("Admin -> User relay failed:", { userId, threadId, error });
    await tg.sendMessage(
      adminGroupId,
      `⚠️ 回传失败\n- 用户: tg://user?id=${userId}\n- 可能原因: 用户拉黑机器人 / 从未与机器人开始会话 / 账号状态异常`,
      threadId
    );
  }
}

function notFound() {
  return new Response("Not found", { status: 404 });
}

function html(body: string) {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const store = new BotStore(env.BOT_KV);
      const webhookSecret = await resolveWebhookSecret(env);
      const setupPath = `/setup/${webhookSecret}`;

      if (request.method === "GET" && url.pathname === "/") {
        return html(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Webhook Setup</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 24px; line-height: 1.5; }
      button { padding: 10px 16px; border: 0; border-radius: 8px; cursor: pointer; }
      pre { white-space: pre-wrap; background: #f5f5f5; padding: 12px; border-radius: 8px; }
    </style>
  </head>
  <body>
    <h1>Telegram Bot 配置页</h1>
    <p>点击下方按钮即可一键设置 Webhook。</p>
    <button id="setup">一键设置 Webhook</button>
    <pre id="result">尚未执行</pre>
    <script>
      const btn = document.getElementById("setup");
      const result = document.getElementById("result");
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        result.textContent = "正在设置，请稍候...";
        try {
          const resp = await fetch(${JSON.stringify(setupPath)}, { method: "POST" });
          result.textContent = await resp.text();
        } catch (e) {
          result.textContent = "设置失败：" + (e?.message || String(e));
        } finally {
          btn.disabled = false;
        }
      });
    </script>
  </body>
</html>`);
      }

      if ((request.method === "GET" || request.method === "POST") && url.pathname === setupPath) {
        const tg = new TelegramClient(env.BOT_TOKEN);
        const hookUrl = `${url.origin}/hook/${webhookSecret}`;
        const result = await tg.call<unknown>("setWebhook", {
          url: hookUrl,
          drop_pending_updates: true,
          allowed_updates: ["message", "callback_query"]
        });
        return new Response(JSON.stringify({ ok: true, hookUrl, result }, null, 2), {
          headers: { "content-type": "application/json; charset=utf-8" }
        });
      }

      const hookPath = `/hook/${webhookSecret}`;
      if (request.method !== "POST" || url.pathname !== hookPath) {
        return notFound();
      }

      const update = (await request.json()) as TelegramUpdate;
      const message = update.message;
      const callbackQuery = update.callback_query;
      if (!message && !callbackQuery) {
        return new Response("ignored");
      }

      const adminGroupId = Number(env.ADMIN_GROUP_ID);
      if (!Number.isFinite(adminGroupId)) {
        throw new Error("ADMIN_GROUP_ID is invalid");
      }

      const tg = new TelegramClient(env.BOT_TOKEN);

      try {
        if (callbackQuery) {
          await handleCallbackQuery(tg, store, adminGroupId, callbackQuery);
        } else if (message?.chat.type === "private") {
          await handlePrivateMessage(tg, store, adminGroupId, message);
        } else if (message?.chat.type === "supergroup") {
          await handleAdminGroupMessage(tg, store, adminGroupId, message);
        }
      } catch (handlerError) {
        // 这里必须返回 200，避免 Telegram 持续重试同一条失败 update，导致后续消息“卡住”
        console.error("Handle update failed but acknowledged:", handlerError);
      }

      return new Response("ok");
    } catch (err) {
      console.error("Webhook error:", err);
      return new Response("internal error", { status: 500 });
    }
  }
};
