const LotteryStore = (() => {
  const KEY = "keyou-lottery-v1";
  const LEVELS = ["一等奖", "二等奖", "三等奖", "四等奖", "五等奖", "六等奖", "七等奖", "八等奖"];

  function uid() {
    return Math.random().toString(36).slice(2, 10);
  }

  function nowText() {
    const date = new Date();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const hh = String(date.getHours()).padStart(2, "0");
    const mi = String(date.getMinutes()).padStart(2, "0");
    return `${mm}-${dd} ${hh}:${mi}`;
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

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return defaults();
      const data = JSON.parse(raw);
      const base = defaults();
      return {
        ...base,
        ...data,
        settings: { ...base.settings, ...(data.settings || {}) },
        prizes: Array.isArray(data.prizes) && data.prizes.length ? data.prizes : base.prizes,
        cards: Array.isArray(data.cards) ? data.cards : [],
        records: Array.isArray(data.records) ? data.records : [],
      };
    } catch {
      return defaults();
    }
  }

  function save(data) {
    localStorage.setItem(KEY, JSON.stringify(data));
    return data;
  }

  function nextLevel(prizes) {
    return LEVELS[Math.min(prizes.length, LEVELS.length - 1)];
  }

  function makeCode(prefix) {
    const chunk = () => Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4).padEnd(4, "X");
    const head = (prefix || "KYJIE").trim().toUpperCase() || "KYJIE";
    return `${head}-${chunk()}-${chunk()}`;
  }

  const PIE_COLORS = ["#c9a227", "#2f8f78", "#d46b5c", "#6ea0d4", "#d4a574", "#8a6bb0", "#5aa88a", "#e08a4a", "#6b8f71"];

  function hexToRgb(hex) {
    const raw = String(hex || "#888888").replace("#", "");
    const full = raw.length === 3 ? raw.split("").map((char) => char + char).join("") : raw.padEnd(6, "0").slice(0, 6);
    const n = Number.parseInt(full, 16);
    if (Number.isNaN(n)) return { r: 136, g: 136, b: 136 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function rgbToHex({ r, g, b }) {
    const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));
    return `#${[clamp(r), clamp(g), clamp(b)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  }

  function rgbToHsl({ r, g, b }) {
    const rr = r / 255;
    const gg = g / 255;
    const bb = b / 255;
    const max = Math.max(rr, gg, bb);
    const min = Math.min(rr, gg, bb);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;
    if (max === rr) h = (gg - bb) / d + (gg < bb ? 6 : 0);
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    return { h: h / 6, s, l };
  }

  function hslToRgb({ h, s, l }) {
    const hue2rgb = (p, q, t) => {
      let tt = t;
      if (tt < 0) tt += 1;
      if (tt > 1) tt -= 1;
      if (tt < 1 / 6) return p + (q - p) * 6 * tt;
      if (tt < 1 / 2) return q;
      if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
      return p;
    };
    if (s === 0) {
      const v = Math.round(l * 255);
      return { r: v, g: v, b: v };
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return {
      r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
      g: Math.round(hue2rgb(p, q, h) * 255),
      b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
    };
  }

  function hslToHex(hsl) {
    return rgbToHex(hslToRgb(hsl));
  }

  function prettyHue(hex) {
    const hsl = rgbToHsl(hexToRgb(hex));
    let deg = hsl.h * 360;
    if (deg >= 70 && deg <= 140 && hsl.s > 0.45) deg = 158;
    if ((deg <= 18 || deg >= 345) && hsl.s > 0.5) deg = 14;
    if (deg >= 210 && deg <= 255 && hsl.s > 0.45) deg = 204;
    return { h: deg / 360, s: hsl.s, l: hsl.l };
  }

  function sliceTones(hex) {
    const { h, s } = prettyHue(hex || "#c9a227");
    const sat = Math.min(0.52, Math.max(0.22, s * 0.72));
    return {
      light: hslToHex({ h: h - 0.02, s: sat * 0.55, l: 0.86 }),
      mid: hslToHex({ h, s: sat, l: 0.58 }),
      deep: hslToHex({ h: h + 0.03, s: Math.min(0.6, sat + 0.08), l: 0.34 }),
    };
  }

  function pieColor(index) {
    return PIE_COLORS[index % PIE_COLORS.length];
  }

  function wheelItems(data) {
    const items = (data.prizes || []).map((prize, index) => ({
      kind: "prize",
      prize,
      text: prize.name || "奖品",
      value: 1,
      color: prize.color || pieColor(index),
    }));
    if (Number(data.thanks) > 0) {
      items.push({
        kind: "thanks",
        prize: null,
        text: "谢谢惠顾",
        value: 1,
        color: data.thanksColor || "#cbbfae",
      });
    }
    return items;
  }

  function polar(cx, cy, r, deg) {
    const rad = ((deg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function donutPath(cx, cy, rIn, rOut, start, end) {
    const sweep = end - start;
    if (sweep <= 0) return "";
    if (sweep >= 359.99) {
      return `${donutPath(cx, cy, rIn, rOut, start, start + 179.99)} ${donutPath(cx, cy, rIn, rOut, start + 179.99, start + 359.98)}`;
    }
    const outerStart = polar(cx, cy, rOut, start);
    const outerEnd = polar(cx, cy, rOut, end);
    const innerEnd = polar(cx, cy, rIn, end);
    const innerStart = polar(cx, cy, rIn, start);
    const large = sweep > 180 ? 1 : 0;
    return `M ${outerStart.x} ${outerStart.y} A ${rOut} ${rOut} 0 ${large} 1 ${outerEnd.x} ${outerEnd.y} L ${innerEnd.x} ${innerEnd.y} A ${rIn} ${rIn} 0 ${large} 0 ${innerStart.x} ${innerStart.y} Z`;
  }

  function labelColor(bg) {
    const hex = String(bg || "#cccccc").replace("#", "");
    const n = parseInt(hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex, 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? "#1f2b27" : "#fff";
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function wheelSlices(data) {
    const items = wheelItems(data);
    const sum = items.reduce((total, item) => total + item.value, 0) || 1;
    const firstSweep = items.length ? (items[0].value / sum) * 360 : 0;
    let cursor = -firstSweep / 2;
    return items.map((item) => {
      const sweep = (item.value / sum) * 360;
      const start = cursor;
      const end = cursor + sweep;
      const mid = start + sweep / 2;
      cursor = end;
      return { item, start, end, mid, sweep };
    });
  }

  function renderPieWheel(el, data, opts = {}) {
    const slices = wheelSlices(data);
    const cx = 100;
    const cy = 100;
    const rOut = opts.rOut ?? 96;
    const rIn = opts.rIn ?? 44;
    const fontSize = opts.fontSize ?? 11;
    const deg = opts.deg || 0;
    const uid = `w${Math.random().toString(36).slice(2, 8)}`;
    const defs = slices.map(({ item, mid }, index) => {
      const tones = sliceTones(item.color);
      const inner = polar(cx, cy, rIn + 2, mid);
      const outer = polar(cx, cy, rOut, mid);
      return `<linearGradient id="${uid}-s${index}" gradientUnits="userSpaceOnUse" x1="${inner.x.toFixed(2)}" y1="${inner.y.toFixed(2)}" x2="${outer.x.toFixed(2)}" y2="${outer.y.toFixed(2)}"><stop offset="0%" stop-color="${tones.light}"/><stop offset="46%" stop-color="${tones.mid}"/><stop offset="100%" stop-color="${tones.deep}"/></linearGradient>`;
    });
    const paths = slices.map(({ item, start, end }, index) => {
      const win = opts.winIndex === index;
      const d = donutPath(cx, cy, rIn, rOut, start, end);
      return `<path d="${d}" fill="url(#${uid}-s${index})" stroke="${win ? "#f0d48a" : "rgba(255,248,232,.72)"}" stroke-width="${win ? 2.8 : 1.1}"></path>`;
    });
    const labels = slices.map(({ item, mid, sweep }) => {
      if (sweep < 8) return "";
      const point = polar(cx, cy, (rIn + rOut) / 2, mid);
      const size = Math.max(8, Math.min(fontSize, fontSize * (sweep / 42)));
      const lines = String(item.text).match(/.{1,6}/g) || [item.text];
      const startY = point.y - ((lines.length - 1) * size * 1.15) / 2;
      const tspans = lines.map((line, lineIndex) =>
        `<tspan x="${point.x}" y="${startY + lineIndex * size * 1.15}">${escapeHtml(line)}</tspan>`,
      ).join("");
      return `<text text-anchor="middle" dominant-baseline="middle" fill="${labelColor(sliceTones(item.color).deep)}" font-size="${size}" font-family="inherit" style="paint-order:stroke;stroke:rgba(255,248,232,.28);stroke-width:.6">${tspans}</text>`;
    });
    el.style.background = "transparent";
    el.style.transform = "";
    el.innerHTML = `<svg viewBox="0 0 200 200" width="100%" height="100%" aria-hidden="true"><g data-spin transform="rotate(${deg} 100 100)"><defs>${defs.join("")}</defs>${paths.join("")}${labels.join("")}</g></svg>`;
  }

  const AUTH_KEY = "keyou-lottery-auth-v1";
  const SESSION_KEY = "keyou-lottery-admin-session";
  const DEFAULT_ADMIN_USER = "admin";
  const DEFAULT_ADMIN_PASS = "keyou2026";

  async function digest(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`keyou-lottery:${text}`));
    return Array.from(new Uint8Array(buf), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function loadAuth() {
    try {
      const raw = localStorage.getItem(AUTH_KEY);
      if (!raw) return { username: DEFAULT_ADMIN_USER, passwordHash: "" };
      const parsed = JSON.parse(raw);
      return {
        username: String(parsed.username || DEFAULT_ADMIN_USER).trim() || DEFAULT_ADMIN_USER,
        passwordHash: String(parsed.passwordHash || ""),
      };
    } catch {
      return { username: DEFAULT_ADMIN_USER, passwordHash: "" };
    }
  }

  function saveAuth(auth) {
    localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
    return auth;
  }

  async function checkAdminLogin(username, password) {
    const auth = loadAuth();
    const expected = auth.passwordHash || (await digest(DEFAULT_ADMIN_PASS));
    const actual = await digest(String(password || ""));
    return String(username || "").trim() === auth.username && actual === expected;
  }

  async function updateAdminAccount({ username, password } = {}) {
    const auth = loadAuth();
    if (username) auth.username = String(username).trim() || auth.username;
    if (password) auth.passwordHash = await digest(password);
    return saveAuth(auth);
  }

  function hasAdminSession() {
    return sessionStorage.getItem(SESSION_KEY) === "1";
  }

  function setAdminSession(ok) {
    if (ok) sessionStorage.setItem(SESSION_KEY, "1");
    else sessionStorage.removeItem(SESSION_KEY);
  }

  function telegramUser() {
    const webApp = globalThis.Telegram?.WebApp;
    let user = webApp?.initDataUnsafe?.user || null;
    if (!user?.id && typeof webApp?.initData === "string" && webApp.initData) {
      try {
        const raw = new URLSearchParams(webApp.initData).get("user");
        if (raw) user = JSON.parse(raw);
      } catch {
        user = null;
      }
    }
    if (!user?.id) return null;
    const firstName = String(user.first_name || "").trim();
    const lastName = String(user.last_name || "").trim();
    const username = String(user.username || "").trim();
    const name = [firstName, lastName].filter(Boolean).join(" ") || (username ? `@${username}` : `TG ${user.id}`);
    return {
      id: String(user.id),
      username,
      name,
      photo: String(user.photo_url || "").trim(),
    };
  }

  return {
    KEY,
    LEVELS,
    PIE_COLORS,
    AUTH_KEY,
    SESSION_KEY,
    uid,
    nowText,
    defaults,
    load,
    save,
    nextLevel,
    makeCode,
    pieColor,
    wheelItems,
    wheelSlices,
    renderPieWheel,
    loadAuth,
    checkAdminLogin,
    updateAdminAccount,
    hasAdminSession,
    setAdminSession,
    telegramUser,
  };
})();
