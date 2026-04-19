# Telegram 双向客服中继 Bot（Cloudflare Worker）

一个可直接部署到 Cloudflare Workers 的 Telegram 客服中继机器人：

- 用户私聊机器人 ↔ 管理员群话题（Topic）双向转发
- 每个用户自动创建独立话题，便于客服分流
- 支持文本/图片/语音/视频/文件（`copyMessage` 透传）
- 内置简单人机验证（算术题）
- 自动创建并绑定 KV（部署时一键完成）
- 提供网页按钮，一键设置 Webhook

---

## 1. 快速开始

### 1.1 准备 Telegram / Cloudflare

1. 在 BotFather 创建机器人，拿到 `BOT_TOKEN`
2. 准备一个管理员超级群，并开启 **Topics**
3. 将机器人拉入管理员群，赋予发消息权限
4. 记录管理员群 `chat_id`（通常形如 `-100xxxxxxxxxx`）

> KV 不需要你手动先建，项目会在部署时自动创建（可复用已有同名 KV）。

### 1.2 安装依赖

```bash
npm install
```

### 1.3 本地变量（开发用）

复制 `.dev.vars.example` 为 `.dev.vars`：

```env
BOT_TOKEN=xxx
ADMIN_GROUP_ID=-100xxxxxxxxxx
WEBHOOK_SECRET=your_random_secret
```

### 1.4 一键部署（推荐）

```bash
npm run deploy:auto
```

该命令会自动执行：

1. 检查 KV Namespace 是否存在
2. 不存在则自动创建
3. 自动回填 `wrangler.toml` 中 `BOT_KV` 的 id
4. 执行 `wrangler deploy`

---

## 2. 一键设置 Webhook

部署完成后，访问你的 Worker：

`https://<你的worker域名>/`

打开页面后点击 **「一键设置 Webhook」** 按钮即可。

系统会自动把 webhook 设置为：

`https://<你的worker域名>/hook/<WEBHOOK_SECRET>`

你也可以直接调用接口：

- `GET /setup/<WEBHOOK_SECRET>`
- 或 `POST /setup/<WEBHOOK_SECRET>`

示例：

`https://<你的worker域名>/setup/<WEBHOOK_SECRET>`

---

## 3. GitHub Actions 自动部署

工作流文件：`.github/workflows/deploy.yml`

支持：

- `workflow_dispatch`（手动触发）
- push 到 `main` 自动触发

### 需要的 Secrets

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `BOT_TOKEN`
- `ADMIN_GROUP_ID`
- `WEBHOOK_SECRET`

执行流程：

1. 安装依赖
2. 自动创建/复用 KV 并绑定
3. 部署 Worker
4. 访问 Worker 根路径点击按钮完成 webhook

---

## 4. KV 自动创建绑定说明

脚本文件：`scripts/prepare-kv.mjs`

默认行为：

- Worker 名：`tg-worker-support-bot`
- KV 名：`${WORKER_NAME}-kv`
- 绑定名：`BOT_KV`

可选自定义环境变量：

- `WORKER_NAME`
- `KV_NAMESPACE_TITLE`

Windows 示例：

```bash
set WORKER_NAME=my-bot&& set KV_NAMESPACE_TITLE=my-bot-kv&& npm run prepare:kv
```

---

## 5. 消息流

1. 用户私聊机器人，首次需通过算术验证
2. 验证通过后，系统在管理员群创建该用户专属话题
3. 首次创建话题时发送用户名片（含头像，若存在）
4. 用户后续消息自动转发到该话题
5. 管理员在该话题回复，消息自动回传给对应用户

---

## 6. 常见问题

### Q1：未自动创建话题？

- 管理员群必须是超级群并开启 Topics
- 机器人在群内需要足够权限

### Q2：看不到用户头像名片？

- 用户可能没有头像
- Telegram 返回空时会自动降级为纯文本名片

### Q3：如何重置某个用户验证状态？

- 删除 KV 键 `verified:<userId>` 即可
