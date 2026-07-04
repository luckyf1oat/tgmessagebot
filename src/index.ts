import { BotStore, createCaptcha, parseAnswer, createEmojiChallenge, parseEmojiAnswer } from "./captcha";
import { BotManager } from "./bot-manager";
import {
  TelegramCallbackQuery,
  TelegramClient,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from "./telegram";

interface Env {
  BOT_KV: KVNamespace;
  BOT_TOKEN?: string;
  ADMIN_GROUP_ID?: string;
  WEBHOOK_SECRET?: string;
  ADMIN_PASSWORD?: string;
}

const CAPTCHA_TTL_SECONDS = 5 * 60;
const ADMIN_PASSWORD_KV_KEY = "config:admin_password";
const LEGACY_BOT_ID = "_legacy";

// ── Legacy single-bot compat ──────────────────────────────────────

function generateRandomSecret(bytes = 24): string {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  return Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join("");
}

const LEGACY_MAPPING_KEY = "config:legacy_bot_id";

async function ensureLegacyBot(mgr: BotManager, env: Env): Promise<string | null> {
  if (!env.BOT_TOKEN || !env.ADMIN_GROUP_ID) return null;

  let legacyId = (await env.BOT_KV.get(LEGACY_MAPPING_KEY))?.trim();
  if (legacyId) {
    const existing = await mgr.get(legacyId);
    if (existing) return legacyId;
  }

  const bot = await mgr.add("Legacy Bot", env.BOT_TOKEN, env.ADMIN_GROUP_ID);
  legacyId = bot.id;

  await env.BOT_KV.put(LEGACY_MAPPING_KEY, legacyId);

  if (env.WEBHOOK_SECRET) {
    bot.webhookSecret = env.WEBHOOK_SECRET.trim();
    await env.BOT_KV.put(`bots:${legacyId}`, JSON.stringify(bot));
  }

  return legacyId;
}

async function resolveAdminPassword(env: Env): Promise<string | null> {
  const configured = env.ADMIN_PASSWORD?.trim();
  if (configured) return configured;

  const existing = (await env.BOT_KV.get(ADMIN_PASSWORD_KV_KEY))?.trim();
  if (existing) return existing;

  return null;
}

// ── Telegram message handlers ─────────────────────────────────────

function topicNameFor(user: TelegramUser) {
  const nick = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  const uname = user.username ? `@${user.username}` : "no_username";
  return `${nick || "Unknown"} (${uname}) #${user.id}`.slice(0, 120);
}

function userCardText(user: TelegramUser) {
  const nick =
    [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || "未设置";
  const uname = user.username ? `@${user.username}` : "未设置";
  return `👤 用户名片\n- 昵称: ${nick}\n- 用户名: ${uname}\n- 用户链接: tg://user?id=${user.id}`;
}

function userCardButtons(userId: number) {
  return {
    inline_keyboard: [
      [
        { text: "🚫 拉黑用户", callback_data: `block:${userId}` },
        { text: "✅ 取消拉黑", callback_data: `unblock:${userId}` },
      ],
      [{ text: "🗑️ 删除对话", callback_data: `delete_thread:${userId}` }],
    ],
  };
}

async function relayMessageWithStickerFallback(
  tg: TelegramClient,
  toChatId: number,
  fromChatId: number,
  message: TelegramMessage,
  messageThreadId?: number
): Promise<number | null> {
  try {
    const copied = await tg.copyMessage(
      toChatId,
      fromChatId,
      message.message_id,
      messageThreadId
    );
    return copied.message_id;
  } catch (copyErr) {
    if (!message.sticker?.file_id) throw copyErr;
    await tg.sendSticker(toChatId, message.sticker.file_id, messageThreadId);
    return null;
  }
}

async function relayAndBindMessage(
  tg: TelegramClient,
  store: BotStore,
  toChatId: number,
  fromChatId: number,
  message: TelegramMessage,
  messageThreadId?: number
) {
  const copiedMessageId = await relayMessageWithStickerFallback(
    tg,
    toChatId,
    fromChatId,
    message,
    messageThreadId
  );
  if (!copiedMessageId) return;
  await store.bindMessageLink(
    { chatId: fromChatId, messageId: message.message_id },
    { chatId: toChatId, messageId: copiedMessageId }
  );
}

async function syncEditedMessage(
  tg: TelegramClient,
  store: BotStore,
  message: TelegramMessage
) {
  const linked = await store.getLinkedMessage(message.chat.id, message.message_id);
  if (!linked) return;

  if (message.text !== undefined) {
    await tg.editMessageText(linked.chatId, linked.messageId, message.text);
    return;
  }

  if (message.caption !== undefined) {
    await tg.editMessageCaption(linked.chatId, linked.messageId, message.caption);
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
  await store.setCaptchaStage(userId, "math");
  await store.saveCaptcha(userId, challenge.answer, CAPTCHA_TTL_SECONDS);
  await tg.sendMessage(
    userId,
    `🔐 第一轮验证：${challenge.a} + ${challenge.b} = ?\n直接回复数字即可。`
  );
}

async function askEmojiCaptcha(tg: TelegramClient, store: BotStore, userId: number) {
  const challenge = createEmojiChallenge();
  await store.setCaptchaStage(userId, "emoji");
  await store.saveEmojiCaptcha(userId, challenge.correctEmoji, CAPTCHA_TTL_SECONDS);

  const correctIndex = challenge.options.indexOf(challenge.correctEmoji) + 1; // 1-based
  const optionsText = challenge.options.join("  ");

  await tg.sendMessage(
    userId,
    `🔐 第二轮验证：请发送第 ${correctIndex} 个 emoji\n\n${optionsText}`
  );
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
    await tg.sendMessage(user.id, "⛔ 你已被管理员拉黑，暂时无法继续发送消息。");
    return;
  }

  const text = message.text?.trim();
  if (text === "/start") {
    if (await store.isVerified(user.id)) {
      await tg.sendMessage(
        user.id,
        "欢迎回来，直接发送消息即可联系管理员。支持文本/图片/文件/语音等。"
      );
      return;
    }
    await askCaptcha(tg, store, user.id);
    return;
  }

  const verified = await store.isVerified(user.id);
  if (!verified) {
    const stage = await store.getCaptchaStage(user.id);

    // ── No captcha in progress → start first round ──
    if (!stage) {
      await askCaptcha(tg, store, user.id);
      return;
    }

    // ── Stage 1: math captcha ──
    if (stage === "math") {
      const captcha = await store.getCaptcha(user.id);
      if (!captcha || captcha.expiresAt < Date.now()) {
        await askCaptcha(tg, store, user.id);
        return;
      }

      const answer = parseAnswer(message.text);
      if (answer === null) {
        await tg.sendMessage(user.id, "请回复数字答案，例如 8。");
        return;
      }

      if (answer !== captcha.answer) {
        await tg.sendMessage(user.id, "❌ 答案不正确，请重试。");
        await askCaptcha(tg, store, user.id);
        return;
      }

      // Math passed → clear math captcha, move to emoji round
      await store.clearCaptcha(user.id);
      await tg.sendMessage(user.id, "✅ 第一轮验证通过！");
      await askEmojiCaptcha(tg, store, user.id);
      return;
    }

    // ── Stage 2: emoji captcha ──
    if (stage === "emoji") {
      const emojiCaptcha = await store.getEmojiCaptcha(user.id);
      if (!emojiCaptcha || emojiCaptcha.expiresAt < Date.now()) {
        await askEmojiCaptcha(tg, store, user.id);
        return;
      }

      const emojiAnswer = parseEmojiAnswer(message.text);
      if (!emojiAnswer) {
        await tg.sendMessage(user.id, "请发送一个 emoji。");
        return;
      }

      if (emojiAnswer !== emojiCaptcha.correctEmoji) {
        await tg.sendMessage(user.id, "❌ 答案不正确，请重试。");
        await askEmojiCaptcha(tg, store, user.id);
        return;
      }

      // Both rounds passed → verified!
      await store.setVerified(user.id);
      await store.clearCaptcha(user.id);
      await tg.sendMessage(user.id, "✅ 验证通过！现在可以开始发送消息。");
      return;
    }
  }

  const threadId = await ensureThreadForUser(tg, store, adminGroupId, user);
  await relayAndBindMessage(tg, store, adminGroupId, message.chat.id, message, threadId);
}

async function handlePrivateEditedMessage(
  tg: TelegramClient,
  store: BotStore,
  message: TelegramMessage
) {
  const user = message.from;
  if (!user) return;
  if (await store.isBlocked(user.id)) return;
  if (!(await store.isVerified(user.id))) return;

  await syncEditedMessage(tg, store, message);
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

  await tg.answerCallbackQuery(
    callbackQuery.id,
    willBlock ? "已拉黑该用户" : "已取消拉黑"
  );
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
    await relayAndBindMessage(tg, store, userId, adminGroupId, message);
  } catch (error) {
    console.error("Admin -> User relay failed:", { userId, threadId, error });
    await tg.sendMessage(
      adminGroupId,
      `⚠️ 回传失败\n- 用户: tg://user?id=${userId}\n- 可能原因: 用户拉黑机器人 / 从未与机器人开始会话 / 账号状态异常`,
      threadId
    );
  }
}

async function handleAdminGroupEditedMessage(
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
    await syncEditedMessage(tg, store, message);
  } catch (error) {
    console.error("Admin -> User edit sync failed:", { userId, threadId, error });
    await tg.sendMessage(
      adminGroupId,
      `⚠️ 编辑同步失败\n- 用户: tg://user?id=${userId}\n- 可能原因: 原消息类型不支持编辑 / 用户侧消息已不可编辑 / Telegram API 限制`,
      threadId
    );
  }
}

// ── HTTP helpers ───────────────────────────────────────────────────

function notFound() {
  return new Response("Not found", { status: 404 });
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function html(body: string) {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// ── Auth middleware ────────────────────────────────────────────────

function checkAuth(request: Request, adminPassword: string | null): boolean {
  if (!adminPassword) return false;
  const auth = request.headers.get("Authorization");
  if (!auth) return false;
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  return token === adminPassword;
}

// ── Frontend HTML (SPA) ────────────────────────────────────────────

const PANEL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Bot 管理面板</title>
  <style>
    :root {
      --bg: #f0f2f5;
      --card-bg: #fff;
      --text: #1a1a2e;
      --text-secondary: #6b7280;
      --border: #e5e7eb;
      --primary: #4f46e5;
      --primary-hover: #4338ca;
      --danger: #ef4444;
      --danger-hover: #dc2626;
      --success: #10b981;
      --success-bg: #d1fae5;
      --warning-bg: #fef3c7;
      --radius: 12px;
      --shadow: 0 1px 3px rgba(0,0,0,.08), 0 1px 2px rgba(0,0,0,.06);
      --shadow-lg: 0 10px 15px -3px rgba(0,0,0,.08), 0 4px 6px -2px rgba(0,0,0,.04);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      line-height: 1.6;
    }

    .header {
      background: var(--card-bg);
      border-bottom: 1px solid var(--border);
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .header h1 {
      font-size: 1.25rem;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .header h1 .icon { font-size: 1.4rem; }
    .header-actions { display: flex; gap: 8px; align-items: center; }

    .container { max-width: 900px; margin: 24px auto; padding: 0 16px; }

    .card {
      background: var(--card-bg);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 24px;
      margin-bottom: 20px;
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .card-header h2 { font-size: 1.1rem; font-weight: 600; }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      border: 0;
      border-radius: 8px;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
      white-space: nowrap;
    }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary { background: var(--primary); color: #fff; }
    .btn-primary:hover:not(:disabled) { background: var(--primary-hover); }
    .btn-danger { background: var(--danger); color: #fff; }
    .btn-danger:hover:not(:disabled) { background: var(--danger-hover); }
    .btn-outline {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text);
    }
    .btn-outline:hover:not(:disabled) { background: var(--bg); }
    .btn-sm { padding: 4px 10px; font-size: 0.8rem; }
    .btn-xs { padding: 2px 8px; font-size: 0.75rem; border-radius: 6px; }

    .form-group { margin-bottom: 14px; }
    .form-group label {
      display: block;
      font-size: 0.85rem;
      font-weight: 500;
      margin-bottom: 4px;
      color: var(--text-secondary);
    }
    .form-group input {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      font-size: 0.9rem;
      font-family: inherit;
      transition: border-color 0.15s;
      background: #fafafa;
    }
    .form-group input:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(79,70,229,.1);
      background: #fff;
    }

    .bot-list { display: flex; flex-direction: column; gap: 12px; }
    .bot-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: #fafafa;
      transition: box-shadow 0.15s;
    }
    .bot-item:hover { box-shadow: var(--shadow-lg); }
    .bot-info { flex: 1; min-width: 0; }
    .bot-name { font-weight: 600; font-size: 0.95rem; }
    .bot-meta {
      font-size: 0.8rem;
      color: var(--text-secondary);
      margin-top: 2px;
      word-break: break-all;
    }
    .bot-status {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 0.75rem;
      font-weight: 500;
      padding: 2px 8px;
      border-radius: 10px;
    }
    .bot-status.active { background: var(--success-bg); color: #065f46; }
    .bot-status.inactive { background: var(--warning-bg); color: #92400e; }
    .bot-status .dot {
      width: 6px; height: 6px; border-radius: 50%;
      display: inline-block;
    }
    .bot-status.active .dot { background: var(--success); }
    .bot-status.inactive .dot { background: #f59e0b; }
    .bot-actions { display: flex; gap: 6px; margin-left: 12px; flex-shrink: 0; }

    .modal-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,.3);
      z-index: 100;
      justify-content: center;
      align-items: center;
      padding: 16px;
    }
    .modal-overlay.open { display: flex; }
    .modal {
      background: var(--card-bg);
      border-radius: var(--radius);
      box-shadow: var(--shadow-lg);
      padding: 28px;
      width: 100%;
      max-width: 480px;
      max-height: 90vh;
      overflow-y: auto;
    }
    .modal h3 { margin-bottom: 16px; font-size: 1.05rem; }

    .toast-container {
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 200;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .toast {
      padding: 12px 18px;
      border-radius: 8px;
      font-size: 0.875rem;
      font-weight: 500;
      color: #fff;
      animation: slideIn 0.25s ease;
      box-shadow: var(--shadow-lg);
      max-width: 360px;
    }
    .toast.success { background: var(--success); }
    .toast.error { background: var(--danger); }
    @keyframes slideIn {
      from { transform: translateX(120%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }

    .login-box { max-width: 400px; margin: 80px auto; }
    .empty-state {
      text-align: center;
      padding: 32px 16px;
      color: var(--text-secondary);
    }
    .empty-state .icon { font-size: 2.5rem; margin-bottom: 8px; }
  </style>
</head>
<body>
  <!-- Setup View (first time, no password) -->
  <div id="setupView" style="display:none" class="login-box">
    <div class="card" style="text-align:center">
      <h2 style="margin-bottom:16px">🔐 首次设置</h2>
      <p style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:16px">请设置管理员密码（任意长度）</p>
      <div class="form-group">
        <input type="password" id="setupPassword" placeholder="设置密码" />
      </div>
      <div class="form-group">
        <input type="password" id="setupPasswordConfirm" placeholder="确认密码" />
      </div>
      <button class="btn btn-primary" id="setupBtn" style="width:100%;justify-content:center">设置密码并登录</button>
    </div>
  </div>

  <!-- Login View (password already set) -->
  <div id="loginView" style="display:none" class="login-box">
    <div class="card" style="text-align:center">
      <h2 style="margin-bottom:16px">🔐 Bot 管理面板</h2>
      <p style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:16px">请输入管理员密码</p>
      <div class="form-group">
        <input type="password" id="loginPassword" placeholder="管理员密码" />
      </div>
      <button class="btn btn-primary" id="loginBtn" style="width:100%;justify-content:center">登录</button>
    </div>
  </div>

  <div id="mainView" style="display:none">
    <div class="header">
      <h1><span class="icon">🤖</span> Bot 管理面板</h1>
      <div class="header-actions">
        <button class="btn btn-outline btn-sm" id="logoutBtn">退出登录</button>
      </div>
    </div>
    <div class="container">
      <div class="card">
        <div class="card-header">
          <h2>➕ 添加新 Bot</h2>
        </div>
        <form id="addBotForm">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="form-group">
              <label>Bot 名称</label>
              <input type="text" id="botName" placeholder="例如：客服Bot" required />
            </div>
            <div class="form-group">
              <label>Bot Token</label>
              <input type="text" id="botToken" placeholder="123456:ABC-DEF..." required />
            </div>
          </div>
          <div class="form-group">
            <label>管理员群组 ID</label>
            <input type="text" id="botAdminGroup" placeholder="-100xxxxxxxx" required />
          </div>
          <button type="submit" class="btn btn-primary">添加 Bot</button>
        </form>
      </div>

      <div class="card">
        <div class="card-header">
          <h2>📋 Bot 列表</h2>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-primary btn-sm" id="setupAllWebhooksBtn">🔗 设置全部 Webhook</button>
            <button class="btn btn-outline btn-sm" id="checkAllWebhooksBtn">🩺 检测 Webhook</button>
            <button class="btn btn-outline btn-sm" id="refreshBtn">🔄 刷新</button>
          </div>
        </div>
        <div id="botListContainer" class="bot-list"></div>
      </div>
    </div>
  </div>

  <!-- Edit Modal -->
  <div class="modal-overlay" id="editModal">
    <div class="modal">
      <h3>✏️ 编辑 Bot</h3>
      <form id="editBotForm">
        <input type="hidden" id="editBotId" />
        <div class="form-group">
          <label>Bot 名称</label>
          <input type="text" id="editBotName" required />
        </div>
        <div class="form-group">
          <label>Bot Token</label>
          <input type="text" id="editBotToken" required />
        </div>
        <div class="form-group">
          <label>管理员群组 ID</label>
          <input type="text" id="editBotAdminGroup" required />
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button type="button" class="btn btn-outline" id="closeEditModal">取消</button>
          <button type="submit" class="btn btn-primary">保存</button>
        </div>
      </form>
    </div>
  </div>

  <div class="toast-container" id="toastContainer"></div>

  <script>
    const API_BASE = '';
    let authToken = localStorage.getItem('admin_token') || '';

    // ── Helpers ──
    function showToast(msg, type) {
      const c = document.getElementById('toastContainer');
      const el = document.createElement('div');
      el.className = 'toast ' + type;
      el.textContent = msg;
      c.appendChild(el);
      setTimeout(() => { el.remove(); }, 3000);
    }

    async function api(method, path, body) {
      const headers = {};
      if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
      if (body) headers['Content-Type'] = 'application/json';
      const resp = await fetch(API_BASE + '/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
      if (resp.status === 401) { logout(); throw new Error('未授权'); }
      if (!resp.ok) { const txt = await resp.text(); throw new Error(txt || '请求失败 (' + resp.status + ')'); }
      return resp.json();
    }

    function formatTime(ts) { return new Date(ts).toLocaleString('zh-CN'); }

    function esc(s) {
      if (!s) return '';
      return String(s).replace(/&/g,'&').replace(/</g,'<').replace(/>/g,'>').replace(/"/g,'"');
    }

    // ── Auth ──
    async function login() {
      const pw = document.getElementById('loginPassword').value.trim();
      if (!pw) return showToast('请输入密码', 'error');
      authToken = pw;
      try {
        await api('GET', '/bots');
        localStorage.setItem('admin_token', authToken);
        showMain();
        loadBots();
      } catch {
        authToken = '';
        showToast('密码错误', 'error');
      }
    }

    async function setupPassword() {
      const pw = document.getElementById('setupPassword').value.trim();
      const confirm = document.getElementById('setupPasswordConfirm').value.trim();
      if (!pw) return showToast('请输入密码', 'error');
      if (pw !== confirm) return showToast('两次密码不一致', 'error');

      try {
        const resp = await fetch(API_BASE + '/api/auth/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pw }),
        });
        if (!resp.ok) { const txt = await resp.text(); throw new Error(txt || '设置失败'); }
        authToken = pw;
        localStorage.setItem('admin_token', authToken);
        showToast('密码设置成功', 'success');
        showMain();
        loadBots();
      } catch (e) {
        showToast('设置失败：' + e.message, 'error');
      }
    }

    function logout() {
      authToken = '';
      localStorage.removeItem('admin_token');
      document.getElementById('mainView').style.display = 'none';
      document.getElementById('setupView').style.display = 'none';
      document.getElementById('loginView').style.display = 'none';
      checkAuthStatus();
    }

    function showMain() {
      document.getElementById('setupView').style.display = 'none';
      document.getElementById('loginView').style.display = 'none';
      document.getElementById('mainView').style.display = '';
    }

    function showLogin() {
      document.getElementById('setupView').style.display = 'none';
      document.getElementById('loginView').style.display = '';
      document.getElementById('mainView').style.display = 'none';
    }

    function showSetup() {
      document.getElementById('setupView').style.display = '';
      document.getElementById('loginView').style.display = 'none';
      document.getElementById('mainView').style.display = 'none';
    }

    // ── Bot CRUD ──
    async function loadBots() {
      const container = document.getElementById('botListContainer');
      try {
        const bots = await api('GET', '/bots');
        if (!bots.length) {
          container.innerHTML = '<div class="empty-state"><div class="icon">📭</div><p>暂无 Bot，请添加</p></div>';
          return;
        }
        container.innerHTML = bots.map(b => \`
          <div class="bot-item">
            <div class="bot-info">
              <div class="bot-name">\${esc(b.name) || 'Unnamed'}</div>
              <div class="bot-meta">Token: \${esc(b.token)}</div>
              <div class="bot-meta">Group: \${esc(b.adminGroupId)}</div>
              <div style="margin-top:4px">
                <span class="bot-status \${b.active ? 'active' : 'inactive'}">
                  <span class="dot"></span> \${b.active ? '运行中' : '已停用'}
                </span>
                <span style="font-size:0.7rem;color:var(--text-secondary);margin-left:6px">
                  创建于 \${formatTime(b.createdAt)}
                </span>
              </div>
              \${b.active ? \`
                <div class="bot-meta" style="margin-top:4px">
                  Webhook URL: \${esc(location.origin)}/hook/\${esc(b.id)}/\${esc(b.webhookSecret)}
                </div>
              \` : ''}
            </div>
            <div class="bot-actions">
              <button class="btn btn-xs btn-primary" onclick="setupWebhook('\${b.id}')" title="设置 Webhook">🔗</button>
              <button class="btn btn-xs \${b.active ? 'btn-outline' : 'btn-primary'}" onclick="toggleBot('\${b.id}', \${!b.active})">
                \${b.active ? '⏸' : '▶'}
              </button>
              <button class="btn btn-xs btn-outline" onclick="openEdit('\${b.id}', '\${esc(b.name)}', '\${esc(b.token)}', '\${esc(b.adminGroupId)}')">✏️</button>
              <button class="btn btn-xs btn-danger" onclick="deleteBot('\${b.id}')">🗑</button>
            </div>
          </div>
        \`).join('');
      } catch (e) {
        container.innerHTML = '<div class="empty-state"><p style="color:var(--danger)">加载失败：' + esc(e.message) + '</p></div>';
      }
    }

    async function addBot(e) {
      e.preventDefault();
      const name = document.getElementById('botName').value.trim();
      const token = document.getElementById('botToken').value.trim();
      const adminGroupId = document.getElementById('botAdminGroup').value.trim();
      if (!name || !token || !adminGroupId) return showToast('请填写所有字段', 'error');
      try {
        await api('POST', '/bots', { name, token, adminGroupId });
        document.getElementById('addBotForm').reset();
        showToast('添加成功', 'success');
        loadBots();
      } catch (e) { showToast('添加失败：' + e.message, 'error'); }
    }

    async function toggleBot(id, active) {
      try {
        await api('PATCH', '/bots/' + id, { active });
        showToast(active ? 'Bot 已启用' : 'Bot 已停用', 'success');
        loadBots();
      } catch (e) { showToast('操作失败：' + e.message, 'error'); }
    }

    async function setupWebhook(id) {
      try {
        await api('POST', '/bots/' + id + '/setup-webhook');
        showToast('Webhook 设置成功', 'success');
        loadBots();
      } catch (e) { showToast('Webhook 设置失败：' + e.message, 'error'); }
    }

    async function setupAllWebhooks() {
      try {
        const result = await api('POST', '/bots/setup-webhooks');
        const failed = result.results.filter(r => !r.ok);
        if (failed.length) {
          showToast('已设置 ' + result.success + ' 个，失败 ' + failed.length + ' 个', 'error');
        } else {
          showToast('全部 Webhook 设置成功（' + result.success + ' 个）', 'success');
        }
        loadBots();
      } catch (e) { showToast('批量设置失败：' + e.message, 'error'); }
    }

    async function checkAllWebhooks() {
      try {
        const result = await api('GET', '/bots/webhook-status');
        const failed = result.results.filter(r => !r.ok || !r.matchesExpectedUrl || r.lastErrorMessage);
        if (failed.length) {
          console.table(result.results);
          showToast('检测完成：' + failed.length + ' 个异常，请打开浏览器控制台查看详情', 'error');
        } else {
          showToast('全部 Webhook 正常（' + result.total + ' 个）', 'success');
        }
      } catch (e) { showToast('检测失败：' + e.message, 'error'); }
    }

    async function deleteBot(id) {
      if (!confirm('确定要删除这个 Bot 吗？')) return;
      try {
        await api('DELETE', '/bots/' + id);
        showToast('已删除', 'success');
        loadBots();
      } catch (e) { showToast('删除失败：' + e.message, 'error'); }
    }

    function openEdit(id, name, token, adminGroupId) {
      document.getElementById('editBotId').value = id;
      document.getElementById('editBotName').value = name;
      document.getElementById('editBotToken').value = token;
      document.getElementById('editBotAdminGroup').value = adminGroupId;
      document.getElementById('editModal').classList.add('open');
    }

    function closeEdit() { document.getElementById('editModal').classList.remove('open'); }

    async function saveEdit(e) {
      e.preventDefault();
      const id = document.getElementById('editBotId').value;
      const name = document.getElementById('editBotName').value.trim();
      const token = document.getElementById('editBotToken').value.trim();
      const adminGroupId = document.getElementById('editBotAdminGroup').value.trim();
      try {
        await api('PATCH', '/bots/' + id, { name, token, adminGroupId });
        closeEdit();
        showToast('保存成功', 'success');
        loadBots();
      } catch (e) { showToast('保存失败：' + e.message, 'error'); }
    }

    // ── Check auth status ──
    async function checkAuthStatus() {
      try {
        const resp = await fetch(API_BASE + '/api/auth/status');
        const data = await resp.json();
        if (data.hasPassword) {
          if (!authToken) { showLogin(); }
          else { api('GET', '/bots').then(() => { showMain(); loadBots(); }).catch(() => { logout(); }); }
        } else {
          showSetup();
        }
      } catch {
        if (!authToken) showLogin();
      }
    }

    // ── Event bindings ──
    document.getElementById('loginBtn').addEventListener('click', login);
    document.getElementById('loginPassword').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
    document.getElementById('setupBtn').addEventListener('click', setupPassword);
    document.getElementById('setupPasswordConfirm').addEventListener('keydown', e => { if (e.key === 'Enter') setupPassword(); });
    document.getElementById('logoutBtn').addEventListener('click', logout);
    document.getElementById('addBotForm').addEventListener('submit', addBot);
    document.getElementById('setupAllWebhooksBtn').addEventListener('click', setupAllWebhooks);
    document.getElementById('checkAllWebhooksBtn').addEventListener('click', checkAllWebhooks);
    document.getElementById('refreshBtn').addEventListener('click', loadBots);
    document.getElementById('editBotForm').addEventListener('submit', saveEdit);
    document.getElementById('closeEditModal').addEventListener('click', closeEdit);
    document.getElementById('editModal').addEventListener('click', function(e) { if (e.target === this) closeEdit(); });

    // ── Init ──
    checkAuthStatus();
  </script>
</body>
</html>`;

// ── API handlers ───────────────────────────────────────────────────

async function handleApiBotsList(mgr: BotManager) {
  const bots = await mgr.list();
  return json(bots);
}

async function handleApiBotsAdd(mgr: BotManager, request: Request) {
  const body: { name: string; token: string; adminGroupId: string } = await request.json();
  if (!body.name || !body.token || !body.adminGroupId) {
    return json({ error: "Missing fields" }, 400);
  }
  const bot = await mgr.add(body.name.trim(), body.token.trim(), body.adminGroupId.trim());
  return json(bot, 201);
}

async function handleApiBotUpdate(mgr: BotManager, botId: string, request: Request) {
  const body: { name?: string; token?: string; adminGroupId?: string; active?: boolean } =
    await request.json();
  const bot = await mgr.update(botId, body);
  if (!bot) return json({ error: "Bot not found" }, 404);
  return json(bot);
}

async function handleApiBotDelete(mgr: BotManager, botId: string) {
  const ok = await mgr.remove(botId);
  if (!ok) return json({ error: "Bot not found" }, 404);
  return json({ ok: true });
}

async function setupBotWebhook(mgr: BotManager, bot: { id: string; token: string; webhookSecret: string; active: boolean }, origin: string) {
  const tg = new TelegramClient(bot.token);
  const hookUrl = `${origin}/hook/${bot.id}/${bot.webhookSecret}`;
  const result = await tg.call<unknown>("setWebhook", {
    url: hookUrl,
    drop_pending_updates: true,
    allowed_updates: ["message", "edited_message", "callback_query"],
  });
  if (bot.active === false) {
    await mgr.setActive(bot.id, true);
  }
  return { hookUrl, result };
}

async function handleApiBotSetupWebhook(mgr: BotManager, botId: string, origin: string) {
  const bot = await mgr.get(botId);
  if (!bot) return json({ error: "Bot not found" }, 404);
  const { hookUrl, result } = await setupBotWebhook(mgr, bot, origin);
  return json({ ok: true, hookUrl, result });
}

async function handleApiBotsSetupWebhooks(mgr: BotManager, origin: string) {
  const bots = await mgr.list();
  const results: Array<{
    id: string;
    name: string;
    ok: boolean;
    hookUrl?: string;
    error?: string;
  }> = [];

  for (const bot of bots) {
    try {
      const { hookUrl } = await setupBotWebhook(mgr, bot, origin);
      results.push({ id: bot.id, name: bot.name, ok: true, hookUrl });
    } catch (error) {
      results.push({
        id: bot.id,
        name: bot.name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const success = results.filter((r) => r.ok).length;
  const failed = results.length - success;
  return json({ ok: failed === 0, total: results.length, success, failed, results });
}

async function handleApiBotsWebhookStatus(mgr: BotManager, origin: string) {
  const bots = await mgr.list();
  const results: Array<{
    id: string;
    name: string;
    ok: boolean;
    active: boolean;
    expectedUrl: string;
    actualUrl?: string;
    matchesExpectedUrl?: boolean;
    pendingUpdateCount?: number;
    lastErrorMessage?: string;
    lastErrorDate?: number;
    allowedUpdates?: string[];
    error?: string;
  }> = [];

  for (const bot of bots) {
    const expectedUrl = `${origin}/hook/${bot.id}/${bot.webhookSecret}`;
    try {
      const info = await new TelegramClient(bot.token).getWebhookInfo();
      results.push({
        id: bot.id,
        name: bot.name,
        ok: true,
        active: bot.active,
        expectedUrl,
        actualUrl: info.url,
        matchesExpectedUrl: info.url === expectedUrl,
        pendingUpdateCount: info.pending_update_count,
        lastErrorMessage: info.last_error_message,
        lastErrorDate: info.last_error_date,
        allowedUpdates: info.allowed_updates,
      });
    } catch (error) {
      results.push({
        id: bot.id,
        name: bot.name,
        ok: false,
        active: bot.active,
        expectedUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const healthy = results.filter((r) => r.ok && r.matchesExpectedUrl && !r.lastErrorMessage).length;
  return json({ ok: healthy === results.length, total: results.length, healthy, results });
}

// ── Main fetch handler ─────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const mgr = new BotManager(env.BOT_KV);
      const adminPassword = await resolveAdminPassword(env);

      // ── Admin Panel (root) ──
      if (request.method === "GET" && url.pathname === "/") {
        return html(PANEL_HTML);
      }

      // ── Public auth endpoints (no auth required) ──
      if (url.pathname === "/api/auth/status") {
        return json({ hasPassword: adminPassword !== null });
      }

      if (url.pathname === "/api/auth/setup" && request.method === "POST") {
        if (adminPassword !== null) {
          return json({ error: "Password already set" }, 409);
        }
        const body: { password: string } = await request.json();
        if (!body.password || !body.password.trim()) {
          return json({ error: "Password is required" }, 400);
        }
        await env.BOT_KV.put(ADMIN_PASSWORD_KV_KEY, body.password.trim());
        return json({ ok: true });
      }

      // ── REST API routes (auth required) ──
      if (url.pathname.startsWith("/api/")) {
        if (!checkAuth(request, adminPassword)) {
          return json({ error: "Unauthorized" }, 401);
        }

        const apiPath = url.pathname.slice(4);

        if (request.method === "GET" && apiPath === "/bots") {
          return handleApiBotsList(mgr);
        }

        if (request.method === "GET" && apiPath === "/bots/webhook-status") {
          return handleApiBotsWebhookStatus(mgr, url.origin);
        }

        if (request.method === "POST" && apiPath === "/bots") {
          return handleApiBotsAdd(mgr, request);
        }

        if (request.method === "POST" && apiPath === "/bots/setup-webhooks") {
          return handleApiBotsSetupWebhooks(mgr, url.origin);
        }

        const setupMatch = /^\/bots\/([^/]+)\/setup-webhook$/.exec(apiPath);
        if (request.method === "POST" && setupMatch) {
          return handleApiBotSetupWebhook(mgr, setupMatch[1], url.origin);
        }

        const patchMatch = /^\/bots\/([^/]+)$/.exec(apiPath);
        if (request.method === "PATCH" && patchMatch) {
          return handleApiBotUpdate(mgr, patchMatch[1], request);
        }

        const deleteMatch = /^\/bots\/([^/]+)$/.exec(apiPath);
        if (request.method === "DELETE" && deleteMatch) {
          return handleApiBotDelete(mgr, deleteMatch[1]);
        }

        return notFound();
      }

      // ── Legacy webhook compat ──
      const legacyId = await ensureLegacyBot(mgr, env);
      if (legacyId) {
        const legacyBot = await mgr.get(legacyId);
        if (
          legacyBot?.active &&
          request.method === "POST" &&
          url.pathname === `/hook/${legacyBot.webhookSecret}`
        ) {
          return handleTelegramUpdate(env.BOT_KV, legacyBot, request);
        }
      }

      // ── Multi-bot webhook ──
      const hookMatch = /^\/hook\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (request.method === "POST" && hookMatch) {
        const botId = hookMatch[1];
        const secret = hookMatch[2];
        const bot = await mgr.findByWebhookPath(botId, secret);
        if (!bot) return notFound();
        return handleTelegramUpdate(env.BOT_KV, bot, request);
      }

      return notFound();
    } catch (err) {
      console.error("Fetch error:", err);
      return new Response("internal error", { status: 500 });
    }
  },
};

// ── Telegram update handler ──

async function handleTelegramUpdate(
  kv: KVNamespace,
  bot: { id: string; token: string; adminGroupId: string },
  request: Request
): Promise<Response> {
  const store = new BotStore(kv, bot.id);

  const update = (await request.json()) as TelegramUpdate;
  const message = update.message;
  const editedMessage = update.edited_message;
  const callbackQuery = update.callback_query;
  if (!message && !editedMessage && !callbackQuery) {
    return new Response("ignored");
  }

  const adminGroupId = Number(bot.adminGroupId);
  if (!Number.isFinite(adminGroupId)) {
    throw new Error("ADMIN_GROUP_ID is invalid");
  }

  const tg = new TelegramClient(bot.token);

  try {
    if (callbackQuery) {
      await handleCallbackQuery(tg, store, adminGroupId, callbackQuery);
    } else if (editedMessage?.chat.type === "private") {
      await handlePrivateEditedMessage(tg, store, editedMessage);
    } else if (editedMessage?.chat.type === "supergroup") {
      await handleAdminGroupEditedMessage(tg, store, adminGroupId, editedMessage);
    } else if (message?.chat.type === "private") {
      await handlePrivateMessage(tg, store, adminGroupId, message);
    } else if (message?.chat.type === "supergroup") {
      await handleAdminGroupMessage(tg, store, adminGroupId, message);
    }
  } catch (handlerError) {
    console.error("Handle update failed but acknowledged:", handlerError);
  }

  return new Response("ok");
}