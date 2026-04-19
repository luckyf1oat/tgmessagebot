import { execSync } from "node:child_process";
import fs from "node:fs";

const WRANGLER_FILE = "wrangler.toml";
const BINDING = "BOT_KV";
const workerName = process.env.WORKER_NAME || "tg-worker-support-bot";
const kvTitle = process.env.KV_NAMESPACE_TITLE || `${workerName}-kv`;

function run(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function getKvIdFromCreateOutput(output) {
  const fromJson = output.match(/"id"\s*:\s*"([^"]+)"/i)?.[1];
  if (fromJson) return fromJson;

  const fromText = output.match(/id\s*=\s*"([^"]+)"/i)?.[1];
  if (fromText) return fromText;

  return null;
}

function ensureKvAndGetId() {
  const listRaw = run("npx wrangler kv namespace list --json");
  const list = JSON.parse(listRaw);
  const found = list.find((item) => item?.title === kvTitle);
  if (found?.id) {
    console.log(`KV namespace exists: ${kvTitle} (${found.id})`);
    return found.id;
  }

  console.log(`KV namespace not found, creating: ${kvTitle}`);
  const createRaw = run(`npx wrangler kv namespace create ${BINDING} --title \"${kvTitle}\"`);
  const id = getKvIdFromCreateOutput(createRaw);
  if (!id) {
    throw new Error(`Failed to parse KV namespace id from output:\n${createRaw}`);
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
