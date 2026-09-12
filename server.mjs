import { createHash, createHmac, randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  channelKeyboard,
  privateChatKeyboard,
  promoPhotoPayload,
} from "./lib/promo.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.RAFFLE_DATA || join(ROOT, "data");
const STORE_FILE = join(DATA_DIR, "store.json");
const AUTH_FILE = join(DATA_DIR, "auth.json");
const SECRET_FILE = join(DATA_DIR, "secret.txt");
const AUDIT_FILE = join(DATA_DIR, "audit.jsonl");
const LOGIN_RATE_FILE = join(DATA_DIR, "login-rate.json");
const BANNED_IPS_FILE = join(DATA_DIR, "banned-ips.json");
const PORT = Number(process.env.PORT || 8769);
const HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_ADMIN_USER = "admin";
const COOKIE = "raffle_admin";
const CLIENT_HEADER = "x-lottery-client";
/** 轮换后旧约定头失效；可用环境变量 RAFFLE_CLIENT_TOKEN 覆盖 */
const DEFAULT_CLIENT_TOKEN = "4gcU_BS6VNjVt_2hHqWJBbSH";
/** 调高后所有旧后台 Cookie 立即失效 */
const SESSION_EPOCH = 3;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SETTINGS_STATUS = new Set(["进行中", "暂停发放", "已结束"]);
/** 启动时合并进 data/banned-ips.json；可在该文件继续追加 */
const SEED_BANNED_IPS = ["120.235.168.216"];

let bannedIps = new Set(SEED_BANNED_IPS);

async function loadBannedIps() {
  const raw = await readJson(BANNED_IPS_FILE, null);
  const list = Array.isArray(raw?.ips) ? raw.ips : Array.isArray(raw) ? raw : [];
  const merged = new Set(SEED_BANNED_IPS);
  for (const item of list) {
    const ip = String(item || "").trim();
    if (isIP(ip)) merged.add(ip);
  }
  bannedIps = merged;
  await writeJson(BANNED_IPS_FILE, {
    ips: [...merged].sort(),
    updatedAt: new Date().toISOString(),
  });
}

function isBannedIp(req) {
  return bannedIps.has(clientIp(req));
}

function clientToken() {
  return String(process.env.RAFFLE_CLIENT_TOKEN || DEFAULT_CLIENT_TOKEN).trim() || DEFAULT_CLIENT_TOKEN;
}

function hasClientToken(req) {
  const got = String(req.headers[CLIENT_HEADER] || "").trim();
  const expect = clientToken();
  if (!got || got.length !== expect.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got), Buffer.from(expect));
  } catch {
    return false;
  }
}

function requireClient(req, res) {
  if (hasClientToken(req)) return true;
  send(res, 404, { error: "not found" });
  return false;
}

function channelId() {
  return String(process.env.TELEGRAM_CHANNEL_ID || "").trim();
}

function adminIds() {
  return String(process.env.TELEGRAM_ADMIN_IDS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function botToken() {
  return String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
}

function webhookSecret() {
  return String(process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
}

async function loadDotEnv() {
  try {
    const raw = await readFile(join(ROOT, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const index = trimmed.indexOf("=");
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim();
      if (key && process.env[key] == null) process.env[key] = value;
    }
  } catch {
    /* optional local .env */
  }
}

async function telegramApi(method, body) {
  const token = botToken();
  if (!token) throw new Error("missing TELEGRAM_BOT_TOKEN");
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description || `telegram ${method} failed`);
  return data;
}

async function sendStartMessage(chatId) {
  await telegramApi("sendPhoto", {
    ...promoPhotoPayload(chatId),
    reply_markup: privateChatKeyboard(),
  });
}

async function sendChannelPost() {
  const target = channelId();
  if (!target) throw new Error("未配置 TELEGRAM_CHANNEL_ID");
  return telegramApi("sendPhoto", {
    ...promoPhotoPayload(target),
    reply_markup: channelKeyboard(),
  });
}

function isAdminUser(userId) {
  const ids = adminIds();
  if (!ids.length) return false;
  return ids.includes(String(userId));
}

async function handleTelegramUpdate(update) {
  const message = update?.message || update?.edited_message;
  const text = String(message?.text || "").trim();
  const chatId = message?.chat?.id;
  const userId = message?.from?.id;
  if (!chatId || !text) return;

  if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
    await sendStartMessage(chatId);
    return;
  }

  if (/^\/channel(?:@\w+)?(?:\s|$)/i.test(text)) {
    if (!isAdminUser(userId)) {
      await telegramApi("sendMessage", { chat_id: chatId, text: "你没有发布频道帖的权限。" });
      return;
    }
    const posted = await sendChannelPost();
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: `频道帖已发布（message_id: ${posted.result.message_id}）`,
    });
  }
}

function uid() {
  return randomBytes(6).toString("hex");
}

/** 卡密随机段：去掉易混字符 0O1I，用加密安全随机数。 */
const CARD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function cardChunk(length = 4) {
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += CARD_ALPHABET[randomInt(CARD_ALPHABET.length)];
  }
  return out;
}

function makeCardCode(prefix) {
  const head = String(prefix || "KYJIE")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12) || "KYJIE";
  // 前缀 + 3 段共 12 位随机字符（约 60 bit），避免 Math.random 被标为弱熵
  return `${head}-${cardChunk()}-${cardChunk()}-${cardChunk()}`;
}

function nowText() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type)?.value || "00";
  return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function shiftTextHours(text, hours) {
  const match = /^(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(String(text || "").trim());
  if (!match) return text;
  const year = new Date().getFullYear();
  const date = new Date(Date.UTC(year, Number(match[1]) - 1, Number(match[2]), Number(match[3]), Number(match[4])));
  date.setUTCHours(date.getUTCHours() + hours);
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

async function migrateUtcTimesToChina() {
  const marker = join(DATA_DIR, "migrated-timezone-china.flag");
  try {
    await readFile(marker, "utf8");
    return;
  } catch {
    /* need migrate */
  }
  const store = await loadStore();
  let changed = false;
  for (const record of store.records || []) {
    if (record.time) {
      record.time = shiftTextHours(record.time, 8);
      changed = true;
    }
  }
  for (const card of store.cards || []) {
    if (card.usedAt) {
      card.usedAt = shiftTextHours(card.usedAt, 8);
      changed = true;
    }
  }
  if (changed) await saveStore(store);
  await writeFile(marker, "ok\n", "utf8");
  console.log("migrated record times UTC -> Asia/Shanghai (+8h)");
}

function defaults() {
  return {
    settings: {
      name: "教师节福利",
      status: "进行中",
      start: "2026-09-01 00:00",
      end: "2026-09-30 23:59",
      copy: "支付定金或完成预约后，领取可悠老师发放的卡密参与抽奖",
      teacher: "可悠老师",
      cardOnly: true,
      oneUse: true,
      remind: false,
    },
    prizes: [
      { id: uid(), level: "一等奖", name: "立减 ¥88", amount: 88, stock: 8, returned: false, note: "高价值专属福利", color: "#c9a227" },
      { id: uid(), level: "二等奖", name: "立减 ¥58", amount: 58, stock: 20, returned: false, note: "限时教师节优惠", color: "#2f8f78" },
      { id: uid(), level: "三等奖", name: "立减 ¥28", amount: 28, stock: 40, returned: false, note: "当前订单可用", color: "#d46b5c" },
      { id: uid(), level: "四等奖", name: "立减 ¥8", amount: 8, stock: 80, returned: true, note: "当前订单可用", color: "#6ea0d4" },
    ],
    thanks: 100,
    cards: [],
    records: [],
  };
}

const scrypt = promisify(scryptCallback);

async function hashPassword(text) {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(String(text), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt}$${Buffer.from(derived).toString("hex")}`;
}

async function verifyPassword(text, encoded) {
  const parts = String(encoded || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, expectedHex] = parts;
  if (!/^\d+$/.test(n) || !/^\d+$/.test(r) || !/^\d+$/.test(p) || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(expectedHex)) return false;
  const derived = await scrypt(String(text), salt, 64, { N: Number(n), r: Number(r), p: Number(p) });
  return jsonEqual(Buffer.from(derived).toString("hex"), expectedHex);
}

function legacyDigest(text) {
  return createHash("sha256").update(`keyou-lottery:${text}`).digest("hex");
}

function jsonEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

let secret = "";
let queue = Promise.resolve();

function withLock(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function appendAudit(entry) {
  try {
    await appendFile(
      AUDIT_FILE,
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      "utf8",
    );
  } catch (error) {
    console.warn("audit_write_failed", error?.message || error);
  }
}

function normalize(raw) {
  const base = defaults();
  if (!raw || typeof raw !== "object") return base;
  return {
    ...base,
    ...raw,
    settings: { ...base.settings, ...(raw.settings || {}) },
    prizes: Array.isArray(raw.prizes) && raw.prizes.length ? raw.prizes : base.prizes,
    thanks: Number.isFinite(Number(raw.thanks)) ? Number(raw.thanks) : base.thanks,
    cards: Array.isArray(raw.cards) ? raw.cards : [],
    records: Array.isArray(raw.records) ? raw.records : [],
  };
}

async function loadStore() {
  return normalize(await readJson(STORE_FILE, null));
}

async function saveStore(store) {
  const next = normalize(store);
  await writeJson(STORE_FILE, next);
  return next;
}

async function loadAuth() {
  const raw = await readJson(AUTH_FILE, null);
  if (raw?.username && raw?.passwordHash) {
    return {
      username: String(raw.username).trim() || DEFAULT_ADMIN_USER,
      passwordHash: String(raw.passwordHash),
      sessionVersion: Math.max(0, Number(raw.sessionVersion) || 0),
    };
  }

  // 仅允许用环境变量初始化首个管理员，源码不再内置默认密码
  const bootUser = String(process.env.RAFFLE_ADMIN_USERNAME || DEFAULT_ADMIN_USER).trim() || DEFAULT_ADMIN_USER;
  const bootPass = String(process.env.RAFFLE_ADMIN_PASSWORD || "");
  if (bootPass.length < 8) {
    throw new Error("缺少 data/auth.json，请设置环境变量 RAFFLE_ADMIN_PASSWORD（至少 8 位）后启动");
  }
  const auth = {
    username: bootUser,
    passwordHash: await hashPassword(bootPass),
    sessionVersion: 1,
  };
  await saveAuth(auth);
  await appendAudit({ action: "auth_bootstrap", username: bootUser });
  return auth;
}

async function saveAuth(auth) {
  const username = String(auth.username || DEFAULT_ADMIN_USER).trim() || DEFAULT_ADMIN_USER;
  const passwordHash = String(auth.passwordHash || "").trim();
  if (!passwordHash) throw new Error("passwordHash required");
  const next = {
    username,
    passwordHash,
    sessionVersion: Math.max(0, Number(auth.sessionVersion) || 0),
  };
  await writeJson(AUTH_FILE, next);
  return next;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function signSession(username, sessionVersion = 0) {
  const payload = Buffer.from(
    JSON.stringify({
      u: username,
      v: Math.max(0, Number(sessionVersion) || 0),
      e: SESSION_EPOCH,
      exp: Date.now() + SESSION_TTL_MS,
    }),
  ).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function readSession(req, auth) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const index = token.lastIndexOf(".");
  if (index < 0) return null;
  const payload = token.slice(0, index);
  const sig = token.slice(index + 1);
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (!jsonEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data?.u || Number(data.exp) < Date.now()) return null;
    if (Number(data.e) !== SESSION_EPOCH) return null;
    if (Number(data.v) !== Math.max(0, Number(auth?.sessionVersion) || 0)) return null;
    return String(data.u);
  } catch {
    return null;
  }
}

function cookieHeader(token, req, clear = false) {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  // Strict：降低跨站带 Cookie 改配置的风险；后台同站导航不受影响
  if (clear) {
    return `${COOKIE}=; HttpOnly; Path=/lottery; SameSite=Strict; Max-Age=0${secure}`;
  }
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/lottery; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function send(res, status, body, extra = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(json),
    ...extra,
  });
  res.end(json);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function sanitizeSettings(input) {
  if (!input || typeof input !== "object") return null;
  const out = {};
  if (input.name != null) {
    const name = String(input.name).trim().slice(0, 40);
    if (name) out.name = name;
  }
  if (input.status != null) {
    const status = String(input.status).trim();
    if (SETTINGS_STATUS.has(status)) out.status = status;
  }
  if (input.start != null) out.start = String(input.start).trim().slice(0, 32);
  if (input.end != null) out.end = String(input.end).trim().slice(0, 32);
  if (input.copy != null) out.copy = String(input.copy).trim().slice(0, 200);
  if (input.teacher != null) out.teacher = String(input.teacher).trim().slice(0, 40);
  if (input.cardOnly != null) out.cardOnly = Boolean(input.cardOnly);
  if (input.oneUse != null) out.oneUse = Boolean(input.oneUse);
  if (input.remind != null) out.remind = Boolean(input.remind);
  return Object.keys(out).length ? out : null;
}

function sanitizePrizes(prizes) {
  if (!Array.isArray(prizes) || !prizes.length) return null;
  return prizes.slice(0, 20).map((prize, index) => ({
    id: String(prize?.id || `p${index}`).slice(0, 32),
    level: String(prize?.level || "").trim().slice(0, 12),
    name: String(prize?.name || "奖品").trim().slice(0, 40) || "奖品",
    amount: Math.max(0, Number(prize?.amount) || 0),
    stock: Math.max(0, Math.min(100000, Number(prize?.stock) || 0)),
    returned: Boolean(prize?.returned),
    note: String(prize?.note || "").trim().slice(0, 80),
    color: String(prize?.color || "#c9a227").trim().slice(0, 20),
  }));
}

function settingsAuditView(settings) {
  const s = settings || {};
  return {
    name: String(s.name || ""),
    status: String(s.status || ""),
    start: String(s.start || ""),
    end: String(s.end || ""),
    copy: String(s.copy || "").slice(0, 200),
    teacher: String(s.teacher || ""),
    cardOnly: Boolean(s.cardOnly),
    oneUse: Boolean(s.oneUse),
    remind: Boolean(s.remind),
  };
}

function prizeAuditView(prize) {
  return {
    id: String(prize?.id || ""),
    level: String(prize?.level || ""),
    name: String(prize?.name || ""),
    amount: Number(prize?.amount || 0),
    stock: Number(prize?.stock || 0),
    returned: Boolean(prize?.returned),
    note: String(prize?.note || "").slice(0, 80),
    color: String(prize?.color || ""),
  };
}

function flatDiff(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const changed = {};
  for (const key of keys) {
    const left = before?.[key];
    const right = after?.[key];
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      changed[key] = { from: left, to: right };
    }
  }
  return changed;
}

function prizesDiff(beforeList, afterList) {
  const before = (beforeList || []).map(prizeAuditView);
  const after = (afterList || []).map(prizeAuditView);
  const beforeMap = new Map(before.map((item, index) => [item.id || `idx:${index}`, item]));
  const afterMap = new Map(after.map((item, index) => [item.id || `idx:${index}`, item]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, item] of afterMap) {
    if (!beforeMap.has(id)) {
      added.push(item);
      continue;
    }
    const prev = beforeMap.get(id);
    const fields = flatDiff(prev, item);
    if (Object.keys(fields).length) changed.push({ id, fields });
  }
  for (const [id, item] of beforeMap) {
    if (!afterMap.has(id)) removed.push(item);
  }
  return {
    before,
    after,
    added,
    removed,
    changed,
    countFrom: before.length,
    countTo: after.length,
  };
}

function configAuditSnapshot(store) {
  return {
    settings: settingsAuditView(store?.settings),
    thanks: Number(store?.thanks || 0),
    thanksColor: String(store?.thanksColor || ""),
    prizes: (store?.prizes || []).map(prizeAuditView),
  };
}

function applyConfig(store, body) {
  const settings = sanitizeSettings(body.settings);
  if (settings) store.settings = { ...store.settings, ...settings };
  const prizes = sanitizePrizes(body.prizes);
  if (prizes) store.prizes = prizes;
  if (body.thanks != null) store.thanks = Math.max(0, Math.min(100000, Number(body.thanks) || 0));
  if (body.thanksColor) store.thanksColor = String(body.thanksColor).trim().slice(0, 20);
  return store;
}

function applyCards(store, cards) {
  const existing = new Set(store.cards.map((card) => card.code));
  for (const card of cards || []) {
    const code = String(card?.code || "").trim().toUpperCase();
    if (!code || existing.has(code)) continue;
    existing.add(code);
    store.cards.push({
      code,
      status: "未使用",
      createdAt: card.createdAt || nowText(),
      validity: card.validity || "",
      condition: card.condition || "",
    });
  }
  return store;
}

function createCardBatch(store, body) {
  const quantity = Math.min(5000, Math.max(0, Number(body?.quantity) || 0));
  if (!quantity) return { store, created: [] };
  const prefix = body?.prefix;
  const validity = String(body?.validity || "");
  const condition = String(body?.condition || "");
  const existing = new Set(store.cards.map((card) => String(card.code || "").toUpperCase()));
  const created = [];
  let guard = 0;
  while (created.length < quantity && guard < quantity * 20) {
    guard += 1;
    const code = makeCardCode(prefix);
    if (existing.has(code)) continue;
    existing.add(code);
    const card = {
      code,
      status: "未使用",
      createdAt: nowText(),
      validity,
      condition,
    };
    store.cards.push(card);
    created.push(card);
  }
  return { store, created };
}

function applyDraw(store, body) {
  const code = String(body.code || "").trim().toUpperCase();
  const card = store.cards.find((item) => String(item.code || "").toUpperCase() === code);
  if (!card) {
    const error = new Error("卡密无效");
    error.status = 404;
    throw error;
  }
  if (card.status !== "未使用") {
    const error = new Error("这张卡密已使用");
    error.status = 409;
    throw error;
  }
  const user = body.user && typeof body.user === "object" ? body.user : {};
  const prizeName = String(body.prizeName || "").trim();
  const prize = prizeName ? store.prizes.find((item) => item.name === prizeName) : null;
  card.status = "已使用";
  card.usedAt = nowText();
  card.usedBy = user.name || user.tgUsername || "访客同学";
  if (prize && !prize.returned) {
    prize.stock = Math.max(0, Number(prize.stock || 0) - 1);
  }
  store.records.unshift({
    id: uid(),
    user: user.name || "访客同学",
    tgId: user.id || user.tgId || "",
    tgUsername: user.username || user.tgUsername || "",
    tgPhoto: user.photo || user.tgPhoto || "",
    code: card.code,
    amount: prize ? Number(prize.amount || body.amount || 0) : 0,
    prizeName: prize ? prize.name : "",
    time: nowText(),
    order: prize ? `#${Date.now().toString().slice(-8)}` : "—",
    status: prize ? "已领取" : "已完成",
  });
  return store;
}

function applyDeleteRecord(store, body) {
  const id = String(body?.id || "").trim();
  const tgId = String(body?.tgId || "").trim();
  const code = String(body?.code || "").trim().toUpperCase();
  const time = String(body?.time || "").trim();
  const index = store.records.findIndex((record) => {
    if (id && String(record.id || "") === id) return true;
    if (!id && tgId && code && time) {
      return (
        String(record.tgId || "") === tgId &&
        String(record.code || "").toUpperCase() === code &&
        String(record.time || "") === time
      );
    }
    if (!id && tgId && !code && !time) {
      return String(record.tgId || "") === tgId;
    }
    return false;
  });
  if (index < 0) {
    const error = new Error("记录不存在");
    error.status = 404;
    throw error;
  }
  const [removed] = store.records.splice(index, 1);
  const cardCode = String(removed?.code || "").trim().toUpperCase();
  if (cardCode && cardCode !== "—") {
    const card = store.cards.find((item) => String(item.code || "").toUpperCase() === cardCode);
    if (card) {
      card.status = "未使用";
      delete card.usedAt;
      delete card.usedBy;
    }
  }
  const prizeName = String(removed?.prizeName || "").trim();
  if (prizeName) {
    const prize = store.prizes.find((item) => item.name === prizeName);
    if (prize && !prize.returned) {
      prize.stock = Math.max(0, Number(prize.stock || 0) + 1);
    }
  }
  return { store, removed };
}

function displayUser(record) {
  const name = String(record?.user || "").trim();
  const username = String(record?.tgUsername || "").trim().replace(/^@/, "");
  if (name && name !== "访客同学") return name;
  if (username) return `@${username}`;
  return "幸运用户";
}

function publicWins(store, limit = 10) {
  return (store.records || [])
    .filter((record) => Boolean(record?.prizeName))
    .slice(0, limit)
    .map((record) => ({
      userName: displayUser(record),
      tgPhoto: String(record.tgPhoto || "").trim(),
      prizeName: String(record.prizeName || "").trim(),
      time: String(record.time || "").trim(),
    }));
}

/** 前台可见数据：绝不下发卡密明文和全量领取记录。 */
function publicStoreView(store, { tgId } = {}) {
  const records = tgId
    ? (store.records || []).filter((record) => String(record.tgId || "") === String(tgId))
    : [];
  return {
    settings: store.settings,
    prizes: store.prizes,
    thanks: store.thanks,
    thanksColor: store.thanksColor,
    cards: [],
    records,
  };
}

const verifyRate = new Map();
const HOUR_MS = 60 * 60 * 1000;
const FAIL_LIMIT = 5;

function clientIp(req) {
  // 优先用 Nginx 覆盖写入的 X-Real-IP（等于 $remote_addr，客户端改不了）
  const realIp = String(req.headers["x-real-ip"] || "").trim();
  if (isIP(realIp)) return realIp;

  // 若仍是追加型 X-Forwarded-For，取最后一跳（Nginx 追加的真实 IP），不要取第一个（可伪造）
  const parts = String(req.headers["x-forwarded-for"] || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const last = parts.at(-1) || "";
  if (isIP(last)) return last;

  const remote = String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  return isIP(remote) ? remote : "unknown";
}

function rateKey(req, body = {}) {
  const tgId = String(body?.tgId || body?.user?.id || "").trim();
  if (tgId) return `tg:${tgId}`;
  return `ip:${clientIp(req)}`;
}

function getVerifyRow(key) {
  let row = verifyRate.get(key);
  if (!row) {
    row = { fails: 0, banLevel: 0, banUntil: 0 };
    verifyRate.set(key, row);
  }
  return row;
}

function remainingBanText(banUntil) {
  const ms = Math.max(0, banUntil - Date.now());
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
  }
  return `${minutes} 分钟`;
}

function banError(row) {
  const hours = Math.max(1, 2 ** (Math.max(1, row.banLevel) - 1));
  const error = new Error(`尝试次数过多，已暂时封禁 ${hours} 小时，请 ${remainingBanText(row.banUntil)} 后再试`);
  error.status = 429;
  return error;
}

function assertVerifyRate(key) {
  const row = getVerifyRow(key);
  if (row.banUntil > Date.now()) throw banError(row);
}

/** @returns {{ banned: boolean, remains: number, message?: string }} */
function noteVerifyFail(key) {
  const row = getVerifyRow(key);
  const now = Date.now();
  if (row.banUntil > now) {
    return { banned: true, remains: 0, message: banError(row).message };
  }
  row.fails += 1;
  if (row.fails < FAIL_LIMIT) {
    return { banned: false, remains: FAIL_LIMIT - row.fails };
  }
  row.banLevel += 1;
  row.fails = 0;
  const hours = 2 ** (row.banLevel - 1);
  row.banUntil = now + hours * HOUR_MS;
  return {
    banned: true,
    remains: 0,
    message: `验证失败已达 ${FAIL_LIMIT} 次，已暂时封禁 ${hours} 小时，请稍后再试`,
  };
}

function clearVerifyFails(key) {
  verifyRate.delete(key);
}

const loginRate = new Map();
const LOGIN_FAIL_LIMIT = 5;
const LOGIN_BASE_BAN_MS = 5 * 60 * 1000;

async function loadLoginRate() {
  const raw = await readJson(LOGIN_RATE_FILE, null);
  if (!raw || typeof raw !== "object") return;
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue;
    loginRate.set(key, {
      fails: Math.max(0, Number(value.fails) || 0),
      banLevel: Math.max(0, Number(value.banLevel) || 0),
      banUntil: Math.max(0, Number(value.banUntil) || 0),
    });
  }
}

async function saveLoginRate() {
  const output = Object.fromEntries(loginRate.entries());
  await writeJson(LOGIN_RATE_FILE, output);
}

function getLoginRow(key) {
  let row = loginRate.get(key);
  if (!row) {
    row = { fails: 0, banLevel: 0, banUntil: 0 };
    loginRate.set(key, row);
  }
  return row;
}

function loginBanMinutes(banLevel) {
  return 5 * 2 ** (Math.max(1, banLevel) - 1);
}

function loginBanMessage(row) {
  const minutes = loginBanMinutes(row.banLevel);
  return `尝试次数过多，已暂时锁定 ${minutes} 分钟，请 ${remainingBanText(row.banUntil)} 后再试`;
}

function assertLoginRate(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  for (const key of list) {
    const row = getLoginRow(key);
    if (row.banUntil > Date.now()) {
      const error = new Error(loginBanMessage(row));
      error.status = 429;
      throw error;
    }
  }
}

function loginFailLimit(key) {
  // 同一账号跨 IP 稍宽一点，防误伤；单 IP 仍 5 次
  return String(key).startsWith("login:account:") ? 20 : LOGIN_FAIL_LIMIT;
}

async function noteLoginFail(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  const now = Date.now();
  let locked = null;
  let softRemains = LOGIN_FAIL_LIMIT;
  for (const key of list) {
    const row = getLoginRow(key);
    if (row.banUntil > now) {
      locked = row;
      continue;
    }
    row.fails += 1;
    const limit = loginFailLimit(key);
    if (row.fails < limit) {
      softRemains = Math.min(softRemains, limit - row.fails);
      continue;
    }
    row.banLevel += 1;
    row.fails = 0;
    row.banUntil = now + LOGIN_BASE_BAN_MS * 2 ** (row.banLevel - 1);
    locked = row;
  }
  if (locked) {
    await saveLoginRate();
    return {
      status: 429,
      error: `密码错误次数过多，已暂时锁定 ${loginBanMinutes(locked.banLevel)} 分钟，请稍后再试`,
    };
  }
  await saveLoginRate();
  return {
    status: 401,
    error: `账号或密码不对（还可试 ${softRemains} 次）`,
  };
}

async function clearLoginFails(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  for (const key of list) loginRate.delete(key);
  await saveLoginRate();
}

function loginRateKeys(req, username) {
  const ip = clientIp(req);
  const account = String(username || "").trim().toLowerCase() || "unknown";
  return [`login:ip:${ip}`, `login:account:${account}`];
}

function verifyCardCode(store, rawCode) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) {
    const error = new Error("请输入卡密");
    error.status = 400;
    throw error;
  }
  const card = store.cards.find((item) => String(item.code || "").toUpperCase() === code);
  if (!card) {
    const error = new Error("卡密无效，请向可悠老师获取完整卡密");
    error.status = 404;
    throw error;
  }
  if (card.status !== "未使用") {
    const error = new Error("这张卡密已使用，请换一张未使用的卡密");
    error.status = 409;
    throw error;
  }
  return { code: card.code, status: card.status };
}

async function requireAdmin(req, res) {
  const auth = await loadAuth();
  const username = readSession(req, auth);
  if (!username) {
    send(res, 401, { error: "请先登录后台" });
    return null;
  }
  return { username, auth };
}

async function handle(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && (path === "/health" || path === "/")) {
    send(res, 200, { ok: true });
    return;
  }

  if (isBannedIp(req)) {
    send(res, 403, { error: "forbidden" });
    return;
  }

  // Telegram webhook 用自己的 secret。
  // 已登录后台：只认 Cookie，不再依赖约定头。
  // 未登录的公开接口：必须带当前约定头（旧头会 404）。
  if (path !== "/telegram") {
    const authForGate = await loadAuth();
    const adminGate = readSession(req, authForGate);
    if (!adminGate && !requireClient(req, res)) return;
  }

  if (req.method === "GET" && path === "/store") {
    const auth = await loadAuth();
    const store = await withLock(loadStore);
    if (readSession(req, auth)) {
      send(res, 200, store);
      return;
    }
    send(res, 200, publicStoreView(store));
    return;
  }

  if (req.method === "POST" && path === "/verify") {
    const body = await readBody(req);
    const key = rateKey(req, body);
    try {
      assertVerifyRate(key);
      const store = await withLock(loadStore);
      const result = verifyCardCode(store, body.code);
      clearVerifyFails(key);
      send(res, 200, { ok: true, ...result });
    } catch (error) {
      if (error.status === 429) {
        send(res, 429, { error: error.message || "尝试过于频繁" });
        return;
      }
      if (error.status === 404 || error.status === 409 || error.status === 400) {
        const noted = noteVerifyFail(key);
        if (noted.banned) {
          send(res, 429, { error: noted.message, banned: true });
          return;
        }
        send(res, error.status, {
          error: `${error.message}（还可试 ${noted.remains} 次）`,
          remains: noted.remains,
        });
        return;
      }
      send(res, error.status || 400, { error: error.message || "验证失败" });
    }
    return;
  }

  if (req.method === "GET" && path === "/wins") {
    const store = await withLock(loadStore);
    send(res, 200, { wins: publicWins(store, 10) });
    return;
  }

  if (req.method === "GET" && path === "/records/mine") {
    const tgId = String(url.searchParams.get("tgId") || "").trim();
    if (!tgId) {
      send(res, 400, { error: "缺少用户 ID" });
      return;
    }
    const store = await withLock(loadStore);
    const records = (store.records || []).filter((record) => String(record.tgId || "") === tgId);
    send(res, 200, { records });
    return;
  }

  if (req.method === "POST" && path === "/login") {
    const body = await readBody(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const keys = loginRateKeys(req, username);
    try {
      assertLoginRate(keys);
    } catch (error) {
      send(res, error.status || 429, { error: error.message || "尝试次数过多" });
      return;
    }
    const auth = await loadAuth();
    const passwordMatches = String(auth.passwordHash).startsWith("scrypt$")
      ? await verifyPassword(password, auth.passwordHash)
      : jsonEqual(legacyDigest(password), auth.passwordHash);
    if (username !== auth.username || !passwordMatches) {
      const noted = await noteLoginFail(keys);
      send(res, noted.status, { error: noted.error });
      return;
    }
    if (!String(auth.passwordHash).startsWith("scrypt$")) {
      auth.passwordHash = await hashPassword(password);
      auth.sessionVersion += 1;
      await saveAuth(auth);
      await appendAudit({ action: "auth_hash_migrated", username: auth.username });
    }
    await clearLoginFails(keys);
    await appendAudit({
      action: "admin_login",
      username: auth.username,
      ip: clientIp(req),
    });
    send(
      res,
      200,
      { username: auth.username },
      { "Set-Cookie": cookieHeader(signSession(auth.username, auth.sessionVersion), req) },
    );
    return;
  }

  if (req.method === "POST" && path === "/logout") {
    send(res, 200, { ok: true }, { "Set-Cookie": cookieHeader("", req, true) });
    return;
  }

  if (req.method === "GET" && path === "/me") {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    send(res, 200, { username: admin.username });
    return;
  }

  if (req.method === "POST" && path === "/account") {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const body = await readBody(req);
    const auth = { ...admin.auth };
    const beforeUser = auth.username;
    let passwordChanged = false;
    if (body.username) auth.username = String(body.username).trim().slice(0, 40) || auth.username;
    if (body.password) {
      if (String(body.password).length < 8) {
        send(res, 400, { error: "密码至少 8 位" });
        return;
      }
      auth.passwordHash = await hashPassword(String(body.password));
      passwordChanged = true;
    }
    if (passwordChanged || auth.username !== beforeUser) {
      auth.sessionVersion = Math.max(0, Number(auth.sessionVersion) || 0) + 1;
    }
    await saveAuth(auth);
    await appendAudit({
      action: "admin_account",
      username: admin.username,
      ip: clientIp(req),
      beforeUser,
      afterUser: auth.username,
      passwordChanged,
      sessionVersion: auth.sessionVersion,
    });
    send(
      res,
      200,
      { username: auth.username },
      { "Set-Cookie": cookieHeader(signSession(auth.username, auth.sessionVersion), req) },
    );
    return;
  }

  if (req.method === "POST" && path === "/store") {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const body = await readBody(req);
    let beforeSnap = null;
    const store = await withLock(async () => {
      const current = await loadStore();
      beforeSnap = configAuditSnapshot(current);
      return saveStore(applyConfig(current, body));
    });
    const afterSnap = configAuditSnapshot(store);
    const settingsChanged = flatDiff(beforeSnap.settings, afterSnap.settings);
    const prizeChanges = prizesDiff(beforeSnap.prizes, afterSnap.prizes);
    const thanksChanged =
      beforeSnap.thanks !== afterSnap.thanks || beforeSnap.thanksColor !== afterSnap.thanksColor
        ? {
            thanks: { from: beforeSnap.thanks, to: afterSnap.thanks },
            thanksColor: { from: beforeSnap.thanksColor, to: afterSnap.thanksColor },
          }
        : null;
    await appendAudit({
      action: "store_save",
      username: admin.username,
      ip: clientIp(req),
      beforeName: beforeSnap.settings.name,
      afterName: afterSnap.settings.name,
      prizeCount: afterSnap.prizes.length,
      settingsChanged,
      thanksChanged,
      prizes: {
        countFrom: prizeChanges.countFrom,
        countTo: prizeChanges.countTo,
        added: prizeChanges.added,
        removed: prizeChanges.removed,
        changed: prizeChanges.changed,
        after: prizeChanges.after,
      },
    });
    send(res, 200, store);
    return;
  }

  if (req.method === "POST" && path === "/cards") {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const body = await readBody(req);
    const result = await withLock(async () => {
      const current = await loadStore();
      if (Number(body?.quantity) > 0) {
        const { store, created } = createCardBatch(current, body);
        await saveStore(store);
        return { store, created };
      }
      const store = await saveStore(applyCards(current, body.cards));
      return { store, created: body.cards || [] };
    });
    await appendAudit({
      action: "cards_save",
      username: admin.username,
      ip: clientIp(req),
      created: Array.isArray(result.created) ? result.created.length : 0,
    });
    send(res, 200, { ...result.store, created: result.created });
    return;
  }

  if (req.method === "POST" && path === "/records/delete") {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const body = await readBody(req);
    try {
      const result = await withLock(async () => {
        const current = await loadStore();
        const { store, removed } = applyDeleteRecord(current, body);
        await saveStore(store);
        return { store, removed };
      });
      await appendAudit({
        action: "record_delete",
        username: admin.username,
        ip: clientIp(req),
        code: result.removed?.code || "",
        tgId: result.removed?.tgId || "",
      });
      send(res, 200, { ...result.store, removed: result.removed });
    } catch (error) {
      send(res, error.status || 400, { error: error.message || "删除失败" });
    }
    return;
  }

  if (req.method === "POST" && path === "/draw") {
    const body = await readBody(req);
    const key = rateKey(req, body);
    try {
      assertVerifyRate(key);
      const store = await withLock(async () => {
        const current = await loadStore();
        return saveStore(applyDraw(current, body));
      });
      clearVerifyFails(key);
      const tgId = body?.user?.id || body?.user?.tgId || body?.tgId || "";
      send(res, 200, publicStoreView(store, { tgId }));
    } catch (error) {
      if (error.status === 429) {
        send(res, 429, { error: error.message || "尝试过于频繁" });
        return;
      }
      if (error.status === 404 || error.status === 409) {
        const noted = noteVerifyFail(key);
        if (noted.banned) {
          send(res, 429, { error: noted.message, banned: true });
          return;
        }
        send(res, error.status, {
          error: `${error.message}（还可试 ${noted.remains} 次）`,
          remains: noted.remains,
        });
        return;
      }
      send(res, error.status || 400, { error: error.message || "抽奖失败" });
    }
    return;
  }

  if (req.method === "POST" && path === "/telegram") {
    if (!botToken()) {
      send(res, 503, { error: "bot not configured" });
      return;
    }
    const secretToken = webhookSecret();
    if (secretToken) {
      const header = String(req.headers["x-telegram-bot-api-secret-token"] || "");
      if (!jsonEqual(header, secretToken)) {
        send(res, 401, { error: "invalid webhook secret" });
        return;
      }
    }
    const body = await readBody(req);
    try {
      await handleTelegramUpdate(body);
    } catch (error) {
      console.error("telegram update failed:", error.message || error);
    }
    send(res, 200, { ok: true });
    return;
  }

  send(res, 404, { error: "not found" });
}

async function main() {
  await loadDotEnv();
  await mkdir(DATA_DIR, { recursive: true });
  try {
    secret = (await readFile(SECRET_FILE, "utf8")).trim();
  } catch {
    secret = randomBytes(32).toString("hex");
    await writeFile(SECRET_FILE, `${secret}\n`, "utf8");
  }
  const auth = await loadAuth();
  await loadBannedIps();
  await loadLoginRate();
  if (!(await readJson(STORE_FILE, null))) await saveStore(defaults());
  await migrateUtcTimesToChina();
  await appendAudit({
    action: "server_start",
    sessionVersion: auth.sessionVersion,
    epoch: SESSION_EPOCH,
    bannedIps: [...bannedIps],
  });

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) send(res, 500, { error: error.message || "server error" });
      else res.end();
    });
  });
  server.listen(PORT, HOST, () => {
    console.log(`raffle api listening on ${HOST}:${PORT}`);
  });
}

main();
