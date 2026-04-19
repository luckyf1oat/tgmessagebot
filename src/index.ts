import { BotStore, createCaptcha, parseAnswer } from "./captcha";
import { TelegramClient, TelegramMessage, TelegramUpdate, TelegramUser } from "./telegram";

interface Env {
  BOT_KV: KVNamespace;
  BOT_TOKEN: string;
  ADMIN_GROUP_ID: string;
  WEBHOOK_SECRET: string;
}

const CAPTCHA_TTL_SECONDS = 5 * 60;

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
    const photos = await tg.getUserProfilePhotos(user.id);
    const fileId = photos.photos?.[0]?.[0]?.file_id;
    if (fileId) {
      await tg.sendPhoto(adminGroupId, fileId, userCardText(user), threadId);
    } else {
      await tg.sendMessage(adminGroupId, userCardText(user), threadId);
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
  await tg.copyMessage(adminGroupId, message.chat.id, message.message_id, threadId);
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

  await tg.copyMessage(userId, adminGroupId, message.message_id);
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
      const setupPath = `/setup/${env.WEBHOOK_SECRET}`;

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
        const hookUrl = `${url.origin}/hook/${env.WEBHOOK_SECRET}`;
        const result = await tg.call<unknown>("setWebhook", {
          url: hookUrl,
          drop_pending_updates: true,
          allowed_updates: ["message"]
        });
        return new Response(JSON.stringify({ ok: true, hookUrl, result }, null, 2), {
          headers: { "content-type": "application/json; charset=utf-8" }
        });
      }

      const hookPath = `/hook/${env.WEBHOOK_SECRET}`;
      if (request.method !== "POST" || url.pathname !== hookPath) {
        return notFound();
      }

      const update = (await request.json()) as TelegramUpdate;
      const message = update.message;
      if (!message) {
        return new Response("ignored");
      }

      const adminGroupId = Number(env.ADMIN_GROUP_ID);
      if (!Number.isFinite(adminGroupId)) {
        throw new Error("ADMIN_GROUP_ID is invalid");
      }

      const tg = new TelegramClient(env.BOT_TOKEN);
      const store = new BotStore(env.BOT_KV);

      if (message.chat.type === "private") {
        await handlePrivateMessage(tg, store, adminGroupId, message);
      } else if (message.chat.type === "supergroup") {
        await handleAdminGroupMessage(tg, store, adminGroupId, message);
      }

      return new Response("ok");
    } catch (err) {
      console.error("Webhook error:", err);
      return new Response("internal error", { status: 500 });
    }
  }
};
