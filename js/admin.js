(() => {
  const root = document.getElementById("admin-root");
  const loginForm = root.querySelector("[data-login-form]");
  const loginError = root.querySelector("[data-login-error]");
  let adminStarted = false;

  function refreshIcons() {
    if (globalThis.lucide) lucide.createIcons({ attrs: { "stroke-width": 1.7 } });
  }

  function showAdmin() {
    document.documentElement.dataset.authed = "1";
    LotteryStore.setAdminSession(true);
    if (!adminStarted) {
      adminStarted = true;
      startAdmin();
    }
    refreshIcons();
  }

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const username = root.querySelector("#login-username").value;
    const password = root.querySelector("#login-password").value;
    loginError.textContent = "";
    const ok = await LotteryStore.checkAdminLogin(username, password);
    if (!ok) {
      loginError.textContent = "账号或密码不对";
      return;
    }
    showAdmin();
  });

  root.querySelector("[data-logout]").addEventListener("click", () => {
    LotteryStore.setAdminSession(false);
    delete document.documentElement.dataset.authed;
    location.reload();
  });

  refreshIcons();
  if (LotteryStore.hasAdminSession()) {
    showAdmin();
    return;
  }

  function startAdmin() {
  const data = LotteryStore.load();
  const crumbs = {
    overview: "活动概览",
    "prize-panel": "奖品配置",
    "card-panel": "卡密发放",
    "record-panel": "领取记录",
    "settings-panel": "基础设置",
  };
  const copies = {
    overview: "查看活动状态、卡密发放和抽奖数据",
    "prize-panel": "配置老师专属发放的抽奖奖池与中奖规则",
    "card-panel": "生成卡密后发给已支付定金或完成预约的用户",
    "record-panel": "查看 Telegram 用户、卡密使用和中奖结果",
    "settings-panel": "管理活动名称、时间和用户参与条件",
  };

  const prizeList = root.querySelector("[data-prize-list]");
  const thanksInput = root.querySelector("[data-thanks]");
  const saved = root.querySelector("[data-saved]");
  const codeList = root.querySelector("[data-code-list]");
  const recordBody = root.querySelector("[data-record-body]");
  let lastBatch = [];

  function refreshIcons() {
    if (globalThis.lucide) lucide.createIcons({ attrs: { "stroke-width": 1.7 } });
  }

  function readSettings() {
    data.settings.name = root.querySelector("#activity-name").value.trim() || "教师节福利";
    data.settings.status = root.querySelector("#activity-status").value;
    data.settings.start = root.querySelector("#activity-start").value.trim();
    data.settings.end = root.querySelector("#activity-end").value.trim();
    data.settings.copy = root.querySelector("#activity-copy").value.trim();
    data.settings.cardOnly = root.querySelector("#setting-card-only").checked;
    data.settings.oneUse = root.querySelector("#setting-one-use").checked;
    data.settings.remind = root.querySelector("#setting-remind").checked;
  }

  function escapeAttr(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  }

  function readPrizes() {
    prizeList.querySelectorAll("[data-prize-row]").forEach((row, index) => {
      const prize = data.prizes[index];
      if (!prize) return;
      prize.name = row.querySelector("[data-name]").value.trim() || prize.name || "新奖品";
      prize.color = row.querySelector("[data-color]").value || prize.color;
      prize.stock = Math.max(0, Number(row.querySelector("[data-stock]").value) || 0);
      prize.returned = row.querySelector("[data-return]").checked;
    });
    data.thanks = Math.max(0, Number(thanksInput.value) || 0);
  }

  function persist() {
    readSettings();
    readPrizes();
    LotteryStore.save(data);
  }

  function prizeRow(prize, index) {
    const row = document.createElement("div");
    row.className = "prize-row";
    row.dataset.prizeRow = "";
    row.innerHTML = `
      <div class="prize-name"><div class="prize-name-main"><input class="prize-color" type="color" value="${escapeAttr(prize.color || LotteryStore.pieColor(index))}" data-color aria-label="扇区颜色"><input class="field" type="text" value="${escapeAttr(prize.name)}" maxlength="20" data-name placeholder="例如：奶茶20" aria-label="奖品名称"></div><span>${escapeAttr(prize.note || "当前订单可用")}</span></div>
      <div class="unit-field"><input class="field" type="number" value="${prize.stock}" min="0" data-stock><span>份</span></div>
      <label class="return-control"><span class="switch"><input type="checkbox" data-return${prize.returned ? " checked" : ""}><span></span></span><span>返回</span></label>
      <div class="row-actions">
        <button class="icon-btn" type="button" data-remove-prize aria-label="删除${escapeAttr(prize.name)}"><i data-lucide="trash-2" aria-hidden="true"></i></button>
      </div>
    `;
    return row;
  }

  function fillSettings() {
    root.querySelector("#activity-name").value = data.settings.name;
    root.querySelector("#activity-status").value = data.settings.status;
    root.querySelector("#activity-start").value = data.settings.start;
    root.querySelector("#activity-end").value = data.settings.end;
    root.querySelector("#activity-copy").value = data.settings.copy;
    root.querySelector("#setting-card-only").checked = data.settings.cardOnly;
    root.querySelector("#setting-one-use").checked = data.settings.oneUse;
    root.querySelector("#setting-remind").checked = data.settings.remind;
    root.querySelector("#admin-username").value = LotteryStore.loadAuth().username;
    thanksInput.value = data.thanks;
  }

  async function saveAuthFromForm() {
    const username = root.querySelector("#admin-username").value.trim();
    const password = root.querySelector("#admin-password").value;
    const confirm = root.querySelector("#admin-password-confirm").value;
    const authSaved = root.querySelector("[data-auth-saved]");
    if (password || confirm) {
      if (password !== confirm) {
        const message = "两次密码不一致，未保存";
        if (authSaved) authSaved.textContent = message;
        return { error: message };
      }
      if (password.length < 6) {
        const message = "密码至少 6 位，未保存";
        if (authSaved) authSaved.textContent = message;
        return { error: message };
      }
    }
    await LotteryStore.updateAdminAccount({
      username: username || undefined,
      password: password || undefined,
    });
    root.querySelector("#admin-password").value = "";
    root.querySelector("#admin-password-confirm").value = "";
    root.querySelector("#admin-username").value = LotteryStore.loadAuth().username;
    if (authSaved) authSaved.textContent = password ? "后台账号密码已更新" : "";
    if (password) return { ok: "账号密码已更新，配置已保存" };
    return null;
  }

  function renderPrizes() {
    prizeList.replaceChildren(...data.prizes.map(prizeRow));
    prizeList.querySelectorAll("[data-name], [data-color], [data-stock], [data-return]").forEach((input) => {
      input.addEventListener("input", render);
      input.addEventListener("change", render);
    });
    prizeList.querySelectorAll("[data-remove-prize]").forEach((button, index) => {
      button.addEventListener("click", () => {
        if (data.prizes.length <= 1) {
          saved.textContent = "至少保留 1 个奖项";
          return;
        }
        data.prizes.splice(index, 1);
        renderPrizes();
        render();
      });
    });
  }

  function renderPreview() {
    root.querySelector("[data-preview-name]").textContent = data.settings.name;
    root.querySelector("[data-preview-teacher]").textContent = `${data.settings.teacher} · 亲自发放`;
    const wheel = root.querySelector("[data-preview-wheel]");
    LotteryStore.renderPieWheel(wheel, data, { fontSize: 9, rIn: 46, rOut: 96 });
  }

  function renderCodes() {
    const recent = [...data.cards].reverse().slice(0, 8);
    if (!recent.length) {
      codeList.innerHTML = '<p class="card-footnote">还没有卡密。生成后会出现在这里。</p>';
      return;
    }
    codeList.replaceChildren(
      ...recent.map((card) => {
        const row = document.createElement("div");
        row.className = "code-row";
        row.innerHTML = `<code>${card.code}</code><span>${card.status}</span>`;
        if (card.status !== "未使用") row.querySelector("span").style.color = "var(--admin-muted)";
        return row;
      }),
    );
  }

  function recordUserCell(record) {
    const name = record.user || "访客同学";
    const username = record.tgUsername || "";
    const id = record.tgId || "";
    const photo = record.tgPhoto || "";
    const initial = Array.from(String(name))[0] || "T";
    const photoTag = photo
      ? `<img src="${escapeAttr(photo)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">`
      : "";
    const userLine = username ? `@${username}` : "未设置用户名";
    const idLine = id ? `ID ${id}` : "未接入 Telegram";
    return `<div class="record-user"><span class="record-avatar">${photoTag}<b>${escapeAttr(initial)}</b></span><span class="record-user-meta"><strong>${escapeAttr(name)}</strong><em>${escapeAttr(userLine)}</em><i>${escapeAttr(idLine)}</i></span></div>`;
  }

  function renderRecords() {
    const filter = root.querySelector("[data-record-filter]").value;
    const keyword = root.querySelector("[data-record-search]").value.trim().toLowerCase();
    const rows = data.records.filter((record) => {
      const win = Boolean(record.prizeName) || record.amount > 0;
      if (filter === "win" && !win) return false;
      if (filter === "thanks" && win) return false;
      if (!keyword) return true;
      return `${record.user} ${record.tgUsername || ""} ${record.tgId || ""} ${record.code}`.toLowerCase().includes(keyword);
    });
    root.querySelector("[data-record-count]").textContent = `共 ${rows.length} 条记录`;
    if (!rows.length) {
      recordBody.innerHTML = '<tr><td colspan="6" class="muted">暂无领取记录</td></tr>';
      return;
    }
    recordBody.replaceChildren(
      ...rows.map((record) => {
        const tr = document.createElement("tr");
        const win = Boolean(record.prizeName) || record.amount > 0;
        const tagClass = win ? "record-tag" : "record-tag gray";
        const result = record.prizeName || (win ? `立减 ¥${record.amount}` : "谢谢惠顾");
        tr.innerHTML = `<td>${recordUserCell(record)}</td><td class="muted">${escapeAttr(record.code)}</td><td><span class="${tagClass}">${escapeAttr(result)}</span></td><td class="muted">${escapeAttr(record.time)}</td><td class="muted">${escapeAttr(record.order || "—")}</td><td>${escapeAttr(record.status)}</td>`;
        return tr;
      }),
    );
  }

  function renderMetrics() {
    const today = LotteryStore.nowText().slice(0, 5);
    const todayCards = data.cards.filter((card) => (card.createdAt || "").startsWith(today)).length;
    const wins = data.records.filter((record) => record.prizeName || record.amount > 0).length;
    const rate = data.records.length ? `${((wins / data.records.length) * 100).toFixed(1)}%` : "—";
    const stock = data.prizes.reduce((sum, prize) => sum + (Number(prize.stock) || 0), 0);
    const end = data.settings.end.split(" ")[0].replace(/^\d{4}-/, "").replace("-", "月") + "日";
    root.querySelector("[data-heading-name]").textContent = data.settings.name;
    root.querySelector("[data-metric-status]").textContent = data.settings.status;
    root.querySelector("[data-metric-end]").textContent = `有效期至 ${end}`;
    root.querySelector("[data-metric-cards]").textContent = String(data.cards.length);
    root.querySelector("[data-metric-cards-today]").textContent = `+${todayCards}`;
    root.querySelector("[data-metric-draws]").textContent = String(data.records.length);
    root.querySelector("[data-metric-rate]").textContent = data.records.length ? `中奖率 ${rate}` : "暂无抽奖";
    root.querySelector("[data-total-stock]").textContent = String(stock);
    root.querySelector("[data-prize-count]").textContent = `共 ${data.prizes.length} 个奖项`;
  }

  function render() {
    readPrizes();
    readSettings();
    renderMetrics();
    renderPreview();
    renderCodes();
    renderRecords();
    refreshIcons();
  }

  function showView(name) {
    const view = name || "prize-panel";
    root.querySelectorAll("[data-view]").forEach((panel) => {
      panel.classList.toggle("is-active", panel.dataset.view === view);
    });
    root.querySelectorAll(".side-nav button").forEach((item) => {
      item.classList.toggle("active", item.dataset.scrollTo === view);
    });
    root.querySelector("[data-crumb]").textContent = crumbs[view] || "奖品配置";
    root.querySelector("[data-heading-copy]").textContent = copies[view] || copies["prize-panel"];
    root.querySelector(".content")?.scrollTo?.({ top: 0 });
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function bindNav() {
    root.querySelectorAll("[data-scroll-to]").forEach((button) => {
      button.addEventListener("click", () => showView(button.dataset.scrollTo));
    });
  }

  root.querySelector("[data-add-prize]").addEventListener("click", () => {
    readPrizes();
    data.prizes.push({
      id: LotteryStore.uid(),
      level: LotteryStore.nextLevel(data.prizes),
      name: "新奖品",
      stock: 10,
      returned: true,
      note: "当前订单可用",
      color: LotteryStore.pieColor(data.prizes.length),
    });
    renderPrizes();
    render();
  });

  root.querySelector("[data-save]").addEventListener("click", async (event) => {
    const authNote = await saveAuthFromForm();
    if (authNote?.error) {
      saved.textContent = authNote.error;
      return;
    }
    persist();
    saved.textContent = authNote?.ok || "配置已保存，用户页会立刻使用新奖池";
    event.currentTarget.textContent = "已保存";
    setTimeout(() => {
      event.currentTarget.textContent = "保存配置";
    }, 1400);
  });

  root.querySelector("[data-create-cards]").addEventListener("click", (event) => {
    persist();
    const quantity = Math.min(5000, Math.max(1, Number(root.querySelector("#card-quantity").value) || 0));
    const prefix = root.querySelector("#card-prefix").value;
    const validity = root.querySelector("#card-validity").value;
    const condition = root.querySelector("#card-condition").value;
    const created = [];
    const existing = new Set(data.cards.map((card) => card.code));
    while (created.length < quantity) {
      const code = LotteryStore.makeCode(prefix);
      if (existing.has(code)) continue;
      existing.add(code);
      const card = {
        code,
        status: "未使用",
        createdAt: LotteryStore.nowText(),
        validity,
        condition,
      };
      created.push(card);
      data.cards.push(card);
    }
    lastBatch = created.map((card) => card.code);
    LotteryStore.save(data);
    root.querySelector("[data-card-created]").textContent = `已生成 ${created.length} 张卡密`;
    event.currentTarget.textContent = "生成成功";
    setTimeout(() => {
      event.currentTarget.textContent = "生成卡密";
    }, 1400);
    render();
  });

  root.querySelector("[data-copy-cards]").addEventListener("click", async (event) => {
    const codes = lastBatch.length ? lastBatch : [...data.cards].reverse().slice(0, 20).map((card) => card.code);
    if (!codes.length) {
      root.querySelector("[data-card-created]").textContent = "还没有可复制的卡密";
      return;
    }
    await navigator.clipboard.writeText(codes.join("\n"));
    event.currentTarget.textContent = "已复制";
    setTimeout(() => {
      event.currentTarget.textContent = "复制最近生成";
    }, 1400);
  });

  root.querySelector("[data-export-records]").addEventListener("click", (event) => {
    const header = "用户,Telegram用户名,Telegram ID,头像,卡密,结果,使用时间,订单,状态";
    const lines = data.records.map((record) =>
      [
        record.user,
        record.tgUsername ? `@${record.tgUsername}` : "",
        record.tgId || "",
        record.tgPhoto || "",
        record.code,
        record.prizeName || (record.amount > 0 ? `立减${record.amount}` : "谢谢惠顾"),
        record.time,
        record.order || "",
        record.status,
      ].join(","),
    );
    const blob = new Blob(["\ufeff" + [header, ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "领取记录.csv";
    link.click();
    URL.revokeObjectURL(url);
    event.currentTarget.textContent = "已导出";
    setTimeout(() => {
      event.currentTarget.innerHTML = '<i data-lucide="download" aria-hidden="true"></i>&nbsp;导出记录';
      refreshIcons();
    }, 1400);
  });

  root.querySelector("[data-record-filter]").addEventListener("change", renderRecords);
  root.querySelector("[data-record-search]").addEventListener("input", renderRecords);
  thanksInput.addEventListener("input", render);
  root.querySelectorAll("#activity-name, #activity-status, #activity-start, #activity-end, #activity-copy").forEach((input) => {
    input.addEventListener("input", render);
  });

  fillSettings();
  renderPrizes();
  bindNav();
  showView("prize-panel");
  render();
  }
})();
