import { execSync } from "node:child_process";
import fs from "node:fs";

const WRANGLER_FILE = "wrangler.toml";
const BINDING = "BOT_KV";
const workerName = process.env.WORKER_NAME || "tg-worker-support-bot";
const kvTitle = process.env.KV_NAMESPACE_TITLE || `${workerName}-kv`;

function run(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function runSafe(cmd) {
  try {
    return { ok: true, output: run(cmd) };
  } catch (error) {
    const out = `${error?.stdout || ""}${error?.stderr || ""}`;
    return { ok: false, output: out, error };
  }
}

function getKvIdFromCreateOutput(output) {
  const fromJson = output.match(/"id"\s*:\s*"([^"]+)"/i)?.[1];
  if (fromJson) return fromJson;

  const fromText = output.match(/id\s*=\s*"([^"]+)"/i)?.[1];
  if (fromText) return fromText;

  return null;
}

function ensureKvAndGetId() {
  const findIdByTitle = () => {
    const listRaw = run("npx wrangler kv namespace list");
    // 新版 Wrangler 直接返回 JSON；老版可能是文本
    try {
      const arr = JSON.parse(listRaw);
      if (Array.isArray(arr)) {
        const hit = arr.find((x) => x?.title === kvTitle && x?.id);
        if (hit?.id) return hit.id;
      }
    } catch {
      // ignore, fallback to text parsing below
    }

    const lines = listRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const line of lines) {
      if (!line.includes(kvTitle)) continue;
      const id = line.match(/[a-f0-9]{32}/i)?.[0] || line.match(/[a-f0-9\-]{36}/i)?.[0];
      if (id) return id;
    }

    return null;
  };

  const existedId = findIdByTitle();
  if (existedId) {
    console.log(`KV namespace exists: ${kvTitle} (${existedId})`);
    return existedId;
  }

  console.log(`KV namespace not found, creating: ${kvTitle}`);
  const helpRaw = run("npx wrangler kv namespace create --help");
  const useLegacyTitle = /--title\b/.test(helpRaw);

  const createCmd = useLegacyTitle
    ? `npx wrangler kv namespace create ${BINDING} --title "${kvTitle}"`
    : `npx wrangler kv namespace create "${kvTitle}" --binding ${BINDING}`;

  const created = runSafe(createCmd);
  if (!created.ok) {
    const alreadyExists = /already exists/i.test(created.output);
    if (alreadyExists) {
      const existedAfterConflict = findIdByTitle();
      if (existedAfterConflict) {
        console.log(`KV namespace already exists, reuse: ${kvTitle} (${existedAfterConflict})`);
        return existedAfterConflict;
      }
    }
    throw new Error(`Failed to create KV namespace.\nCommand: ${createCmd}\n${created.output}`);
  }

  const fromList = findIdByTitle();
  if (fromList) {
    console.log(`KV namespace created: ${kvTitle} (${fromList})`);
    return fromList;
  }

  const id = getKvIdFromCreateOutput(created.output);
  if (!id) {
    throw new Error(`Failed to parse KV namespace id from output:\n${created.output}`);
  }
  console.log(`KV namespace created: ${kvTitle} (${id})`);
  return id;
}

function patchWranglerKvId(id) {
  const content = fs.readFileSync(WRANGLER_FILE, "utf8");
  const regex = /(\[\[kv_namespaces\]\][\s\S]*?binding\s*=\s*"BOT_KV"\s*\n\s*id\s*=\s*")([^"]+)(")/m;
  if (!regex.test(content)) {
    throw new Error("Cannot find BOT_KV binding in wrangler.toml");
  }

  const patched = content.replace(regex, `$1${id}$3`);
  fs.writeFileSync(WRANGLER_FILE, patched, "utf8");
  console.log(`Patched wrangler.toml BOT_KV id => ${id}`);
}

const id = ensureKvAndGetId();
patchWranglerKvId(id);
