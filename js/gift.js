(() => {
  const root = document.getElementById("gift-root");
  const data = LotteryStore.load();
  const settings = data.settings;
  const wheel = root.querySelector("[data-wheel]");
  const result = root.querySelector("[data-result]");
  const mainAction = root.querySelector("[data-main-action]");
  const center = root.querySelector(".gift-wheel-center");
  const availability = root.querySelector("[data-availability]");
  const rules = root.querySelector(".gift-rules");
  let trigger = mainAction;
  let currentCode = "";
  let prizeAmount = 0;
  let prizeName = "";
  let wheelDeg = 0;

  const state = {
    showResult: false,
    claimed: false,
    used: false,
    spinning: false,
    verified: false,
    accessError: "",
    thanks: false,
  };

  function applyCopy() {
    const name = settings.name || "教师节福利";
    root.querySelector(".gift-hero-copy p").textContent = `${settings.teacher} · 亲自发放`;
    root.querySelector(".gift-hero-copy h1").textContent = name;
    root.querySelector(".gift-nav strong").textContent = "专属福利";
    root.querySelector(".gift-amount").setAttribute("aria-label", "抽取老师专属奖品");
    root.querySelector(".gift-access-copy").textContent = settings.copy;
    root.querySelector(".gift-rules p").textContent =
      `${settings.copy}。每张未使用卡密可抽取 1 次。抽完后可再输入新的卡密继续抽。抽中的奖品以转盘名称为准。`;
  }

  function buildWheel(winIndex) {
    LotteryStore.renderPieWheel(wheel, data, { fontSize: 12, rIn: 40, rOut: 96, deg: wheelDeg, winIndex });
  }

  function findCard(code) {
    return data.cards.find((card) => card.code.toUpperCase() === code.toUpperCase());
  }

  function pickPrize() {
    const pool = [];
    data.prizes.forEach((prize) => {
      const weight = prize.returned ? Math.max(1, Number(prize.stock) || 1) : Number(prize.stock) || 0;
      if (weight > 0) pool.push({ kind: "prize", prize, weight });
    });
    const thanksWeight = Number(data.thanks) || 0;
    if (thanksWeight > 0) pool.push({ kind: "thanks", prize: null, weight: thanksWeight });
    if (!pool.length) return { kind: "thanks", prize: null };
    const total = pool.reduce((sum, item) => sum + item.weight, 0);
    let cursor = Math.random() * total;
    for (const item of pool) {
      cursor -= item.weight;
      if (cursor <= 0) return item;
    }
    return pool[pool.length - 1];
  }

  function recordDraw(amount, name) {
    const card = findCard(currentCode);
    if (card) {
      card.status = "已使用";
      card.usedAt = LotteryStore.nowText();
    }
    const tg = LotteryStore.telegramUser();
    data.records.unshift({
      user: tg?.name || "访客同学",
      tgId: tg?.id || "",
      tgUsername: tg?.username || "",
      tgPhoto: tg?.photo || "",
      code: currentCode || "—",
      amount,
      prizeName: name || "",
      time: LotteryStore.nowText(),
      order: name ? `#${Date.now().toString().slice(-8)}` : "—",
      status: name ? "已领取" : "已完成",
    });
    LotteryStore.save(data);
  }

  function latestWin() {
    return data.records.find((record) => record.prizeName);
  }

  function fillResult(thanks, name) {
    root.querySelector("[data-confirm]").textContent = thanks ? "我知道了" : state.used ? "已确认领取" : "确认领取";
    root.querySelector(".gift-dialog h2").textContent = thanks ? "谢谢惠顾" : "恭喜抽中";
    root.querySelector(".gift-dialog > p").textContent = thanks ? "这次没有抽中奖品" : "专属奖品已领取";
    const amountEl = root.querySelector(".gift-result-amount");
    if (thanks) {
      amountEl.classList.remove("is-name");
      amountEl.innerHTML = "<small></small>0";
    } else {
      amountEl.classList.add("is-name");
      amountEl.textContent = name || "";
    }
    const rows = root.querySelectorAll(".gift-order div");
    rows[0].innerHTML = thanks
      ? "<span>抽奖结果</span><span>谢谢惠顾</span>"
      : `<span>抽中奖品</span><span>${String(name || "").replace(/</g, "&lt;")}</span>`;
    rows[1].innerHTML = "<span>使用范围</span><strong>当前订单</strong>";
  }

  function render() {
    result.hidden = !state.showResult;
    root.querySelector(".gift-body").inert = state.showResult;
    root.querySelector(".gift-nav").inert = state.showResult;
    const closed = settings.status !== "进行中";
    const win = latestWin();
    const viewReward = root.querySelector("[data-view-reward]");
    viewReward.hidden = !win;
    root.querySelectorAll("[data-draw]").forEach((button) => {
      if (button === mainAction) return;
      button.disabled = state.spinning || !state.verified || state.claimed || closed;
    });
    root.querySelector("[data-access-status]").textContent = state.verified ? (state.claimed ? "本卡已抽完" : "已验证") : "未验证";
    root.querySelector("[data-access-status]").style.color = state.verified && !state.claimed ? "var(--gift-accent)" : "var(--gift-muted)";
    root.querySelector("[data-access-error]").textContent = state.accessError;
    root.querySelector("[data-verify-card]").textContent = state.verified && !state.claimed ? "已验证" : "验证卡密";
    root.querySelector("[data-verify-card]").disabled = state.spinning;
    root.querySelector("[data-card-input]").disabled = state.spinning;
    mainAction.textContent = state.spinning
      ? "正在抽取专属奖品"
      : state.verified && !state.claimed
        ? "领取老师专属优惠"
        : win
          ? "查看我的奖励"
          : state.claimed
            ? "已抽取 · 可换新卡密"
            : "领取老师专属优惠";
    mainAction.disabled = state.spinning || closed || (!(state.verified && !state.claimed) && !win);
    center.querySelector("b").textContent = state.spinning ? "抽取中" : "抽取";
    center.querySelector("span").textContent = "专属奖品";
    availability.textContent = closed
      ? `活动${settings.status}`
      : state.claimed
        ? "这张卡密已抽完 · 换一张未使用卡密可再抽"
        : state.verified
          ? "卡密已验证 · 可以抽取 1 次"
          : "每张卡密可抽 1 次 · 可更换新卡密";
  }

  function showResult() {
    fillResult(state.thanks, prizeName || (latestWin() && latestWin().prizeName) || "");
    state.showResult = true;
    render();
    root.querySelector("[data-close-result]").focus({ preventScroll: true });
  }

  function showReward() {
    const win = latestWin();
    if (!win) return;
    fillResult(false, win.prizeName);
    state.showResult = true;
    render();
    root.querySelector("[data-close-result]").focus({ preventScroll: true });
  }

  function sliceIndex(picked) {
    const slices = LotteryStore.wheelSlices(data);
    if (picked.kind === "thanks") {
      const index = slices.findIndex((slice) => slice.item.kind === "thanks");
      return index < 0 ? 0 : index;
    }
    const index = slices.findIndex((slice) => slice.item.prize === picked.prize);
    return index < 0 ? 0 : index;
  }

  function setSpinDeg(deg) {
    const group = wheel.querySelector("[data-spin]");
    if (group) group.setAttribute("transform", `rotate(${deg} 100 100)`);
  }

  async function spinTo(picked) {
    const slices = LotteryStore.wheelSlices(data);
    const index = sliceIndex(picked);
    const mid = slices[index] ? slices[index].mid : 0;
    const landing = ((-mid % 360) + 360) % 360;
    const currentMod = ((wheelDeg % 360) + 360) % 360;
    let delta = landing - currentMod;
    if (delta <= 0) delta += 360;
    const nextDeg = wheelDeg + 360 * 5 + delta;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      wheelDeg = nextDeg;
      setSpinDeg(wheelDeg);
      return index;
    }
    const from = wheelDeg;
    await new Promise((resolve) => {
      const start = performance.now();
      const tick = (now) => {
        const t = Math.min(1, (now - start) / 3200);
        const eased = 1 - (1 - t) ** 3;
        setSpinDeg(from + (nextDeg - from) * eased);
        if (t < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    wheelDeg = nextDeg;
    setSpinDeg(wheelDeg);
    return index;
  }

  function closeResult() {
    state.showResult = false;
    render();
    const next = state.claimed ? root.querySelector("[data-card-input]") : trigger;
    next.focus({ preventScroll: true });
  }

  root.querySelectorAll("[data-draw]").forEach((button) => {
    button.addEventListener("click", async () => {
      trigger = button;
      if (button === mainAction && !(state.verified && !state.claimed)) {
        if (latestWin()) {
          showReward();
          return;
        }
        state.accessError = "请先输入老师发放的卡密";
        render();
        root.querySelector("[data-card-input]").focus();
        return;
      }
      if (!state.verified) {
        state.accessError = "请先输入老师发放的卡密";
        render();
        root.querySelector("[data-card-input]").focus();
        return;
      }
      if (state.claimed) {
        state.accessError = "这张卡密已抽完，请换一张未使用的卡密再验证";
        render();
        root.querySelector("[data-card-input]").focus();
        return;
      }
      if (state.spinning) return;
      state.spinning = true;
      render();
      const picked = pickPrize();
      const winIndex = await spinTo(picked);
      if (picked.kind === "prize") {
        prizeAmount = Number(picked.prize.amount) || 0;
        prizeName = picked.prize.name || `立减 ¥${prizeAmount}`;
        state.thanks = false;
        if (!picked.prize.returned) picked.prize.stock = Math.max(0, Number(picked.prize.stock) - 1);
      } else {
        prizeAmount = 0;
        prizeName = "";
        state.thanks = true;
      }
      recordDraw(prizeAmount, prizeName);
      state.spinning = false;
      state.claimed = true;
      buildWheel(winIndex);
      await new Promise((resolve) => setTimeout(resolve, 500));
      showResult();
    });
  });

  function resetDrawState() {
    state.verified = false;
    state.claimed = false;
    state.used = false;
    state.thanks = false;
    prizeAmount = 0;
    prizeName = "";
    currentCode = "";
  }

  root.querySelector("[data-card-input]").addEventListener("input", () => {
    if (!state.verified && !state.claimed) return;
    state.verified = false;
    state.claimed = false;
    state.used = false;
    state.accessError = "";
    currentCode = "";
    render();
  });

  root.querySelector("[data-verify-card]").addEventListener("click", () => {
    const value = root.querySelector("[data-card-input]").value.trim();
    if (settings.status !== "进行中") {
      resetDrawState();
      state.accessError = `活动${settings.status}，暂时不能验证卡密`;
      render();
      return;
    }
    const card = findCard(value);
    if (!card) {
      resetDrawState();
      state.accessError = "卡密无效，请向可悠老师获取完整卡密";
      render();
      return;
    }
    if (card.status !== "未使用") {
      resetDrawState();
      state.accessError = "这张卡密已使用，请换一张未使用的卡密";
      render();
      return;
    }
    currentCode = card.code;
    state.verified = true;
    state.claimed = false;
    state.used = false;
    state.thanks = false;
    state.accessError = "";
    prizeAmount = 0;
    prizeName = "";
    render();
  });

  root.querySelector("[data-view-reward]").addEventListener("click", showReward);
  root.querySelector("[data-confirm]").addEventListener("click", () => {
    state.claimed = true;
    state.used = !state.thanks;
    closeResult();
  });
  root.querySelector("[data-open-rules]").addEventListener("click", () => {
    rules.open = true;
    rules.scrollIntoView({ behavior: "auto", block: "center" });
  });
  result.addEventListener("click", (event) => {
    if (event.target === result) closeResult();
  });
  root.addEventListener("keydown", (event) => {
    if (!state.showResult) return;
    if (event.key === "Escape") closeResult();
    if (event.key === "Tab") {
      const first = root.querySelector("[data-close-result]");
      const last = root.querySelector("[data-confirm]");
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  applyCopy();
  buildWheel();
  try {
    const webApp = globalThis.Telegram?.WebApp;
    if (webApp) {
      webApp.ready();
      webApp.expand();
    }
  } catch {
    /* 浏览器预览时没有 Telegram 壳 */
  }
  render();
})();
