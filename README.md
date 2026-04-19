# Telegram 双向客服中继 Bot（Cloudflare Worker）

一个可直接部署到 Cloudflare Workers 的 Telegram 客服中继机器人：

- 用户私聊机器人 ↔ 管理员群话题（Topic）双向转发
- 每个用户自动创建独立话题，便于客服分流
- 支持文本/图片/语音/视频/文件（`copyMessage` 透传）
- 内置简单人机验证（算术题）
- 自动创建并绑定 KV（部署时一键完成）
- 提供网页按钮，一键设置 Webhook




> 先 **Fork 本仓库** 到你自己的 GitHub 账号，再进行后续配置与部署（方便配置 Secrets、触发 Actions、后续维护升级）。

---

## 1. 完整流程（建议先看）

下面是一套从 0 到可用的完整流程，按顺序做基本不会踩坑。

### 1.1 创建 Telegram 机器人

1. 打开 BotFather，执行 `/newbot`
2. 按提示设置机器人名称和用户名
3. 记录 Bot Token（即 `BOT_TOKEN`）

> `BOT_TOKEN` 是调用 Telegram Bot API 的凭证，泄露后请立即去 BotFather 重新生成。

### 1.2 创建管理员群并开启话题

1. 创建一个 **超级群（supergroup）**
2. 在群设置中开启 **Topics（话题）**
3. 将机器人拉入该群
4. 给机器人至少以下权限：
   - 发送消息
   - 发送媒体（图片/文件等）
   - 管理话题（用于创建用户专属话题）

> 本项目采用“一个用户一个话题”的方式做客服分流。

### 1.3 获取管理员群 ID（`ADMIN_GROUP_ID`）

- 群 ID 通常形如：`-100xxxxxxxxxx`
- 你可以通过机器人收到的更新、现有脚本或常用 getUpdates 方式获取

> `ADMIN_GROUP_ID` 用于标识客服群，机器人会把用户私聊消息转发到这个群的话题中。

### 1.4 准备环境变量（含义说明）

本项目核心变量：

- `BOT_TOKEN`：Telegram 机器人令牌
- `ADMIN_GROUP_ID`：管理员超级群 ID（`-100...`）
- `WEBHOOK_SECRET`：Webhook 路径密钥（用于防止被随意扫描）

开发环境在 `.dev.vars` 配置，生产建议用 CI Secrets 注入。

### 1.5 准备 Cloudflare 凭证（API Token / Account ID）

如果你要在本地无登录部署、或使用 GitHub Actions 自动部署，需要这两个值：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

获取方式：

1. 登录 Cloudflare Dashboard
2. 进入 **My Profile -> API Tokens -> Create Token**
3. 可基于 `Edit Cloudflare Workers` 模板创建，或自定义权限（至少包含）：
   - Account / **Workers Scripts:Edit**
   - Account / **Workers KV Storage:Edit**
4. Account Resources 选择你的目标账号
5. 创建后复制 Token（只显示一次）作为 `CLOUDFLARE_API_TOKEN`
6. `CLOUDFLARE_ACCOUNT_ID` 可在 Dashboard 右侧账号信息区域找到（或 Workers 页面查看）

> 建议：Token 仅给部署所需最小权限，不要使用 Global API Key。

### 1.6 部署 Worker（自动处理 KV）

执行：

```bash
npm run deploy:auto
```

该命令会自动：

1. 检查 KV Namespace 是否存在
2. 不存在则创建
3. 回填 `wrangler.toml` 中 `BOT_KV` 的 id
4. 部署 Worker

### 1.7 设置 Webhook

部署后访问：

`https://<你的worker域名>/`

点击页面上的 **「一键设置 Webhook」** 按钮即可。

Webhook 最终会设置为：

`https://<你的worker域名>/hook/<WEBHOOK_SECRET>`

### 1.8 验证是否成功

1. 用户私聊机器人，按提示完成算术验证
2. 管理员群应自动创建该用户话题
3. 双向收发消息正常即部署完成

---

## 2. 快速开始

### 2.1 准备 Telegram / Cloudflare

1. 在 BotFather 创建机器人，拿到 `BOT_TOKEN`
2. 准备一个管理员超级群，并开启 **Topics**
3. 将机器人拉入管理员群，赋予发消息权限
4. 记录管理员群 `chat_id`（通常形如 `-100xxxxxxxxxx`）

> KV 不需要你手动先建，项目会在部署时自动创建（可复用已有同名 KV）。

### 2.2 安装依赖

```bash
npm install
```

### 2.3 本地变量（开发用）

复制 `.dev.vars.example` 为 `.dev.vars`：

```env
BOT_TOKEN=xxx
ADMIN_GROUP_ID=-100xxxxxxxxxx
WEBHOOK_SECRET=your_random_secret
```

### 2.4 一键部署（推荐）

```bash
npm run deploy:auto
```

该命令会自动执行：

1. 检查 KV Namespace 是否存在
2. 不存在则自动创建
3. 自动回填 `wrangler.toml` 中 `BOT_KV` 的 id
4. 执行 `wrangler deploy`

---

## 3. 一键设置 Webhook

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

## 4. GitHub Actions 自动部署

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

## 5. KV 自动创建绑定说明

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

## 6. 消息流

1. 用户私聊机器人，首次需通过算术验证
2. 验证通过后，系统在管理员群创建该用户专属话题
3. 首次创建话题时发送用户名片（含头像，若存在）
4. 用户后续消息自动转发到该话题
5. 管理员在该话题回复，消息自动回传给对应用户

---

## 7. 常见问题

### Q1：未自动创建话题？

- 管理员群必须是超级群并开启 Topics
- 机器人在群内需要足够权限

### Q2：看不到用户头像名片？

- 用户可能没有头像
- Telegram 返回空时会自动降级为纯文本名片

### Q3：如何重置某个用户验证状态？

- 删除 KV 键 `verified:<userId>` 即可
