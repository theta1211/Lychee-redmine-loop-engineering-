"use strict";

const STATUS = {
  waiting: { label: "待機中" },
  running: { label: "実行中" },
  aborting: { label: "中断要求中" },
  needs_human: { label: "要確認（人対応）" },
  pushed: { label: "完了（プッシュ済み）" },
  canceled: { label: "中断済み" },
};

const PHASE_LABEL = {
  implement: "実装",
  review: "レビュー",
  retry: "差し戻し",
  push: "プッシュ",
  timeout: "タイムアウト",
  error: "エラー",
  abort: "中断",
  recover: "復旧",
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  (s ?? "").toString().replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let settings = null;
let queuePaused = false;
let currentDetailId = null;

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const message = body?.error?.message || `リクエストに失敗しました（${res.status}）`;
    const err = new Error(message);
    err.code = body?.error?.code;
    err.status = res.status;
    throw err;
  }
  return body;
}

function formatDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mi}`;
}

function formatTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(
    d.getSeconds()
  ).padStart(2, "0")}`;
}

function pill(t) {
  const status = t.status === "running" && t.abortRequested ? "aborting" : t.status;
  const limit = settings?.retryLimit ?? 3;
  const extra = t.status === "running" && t.retryCount > 0 ? `<span class="retry">${t.retryCount} / ${limit}</span>` : "";
  return `<span class="pill ${status}">${STATUS[status].label}</span>${extra}`;
}

function modelCell(value, fallback) {
  return value
    ? `<span class="model">${esc(value)}</span>`
    : `<span class="model is-default">${esc(fallback || "既定")}</span>`;
}

function redmineIssueUrl(no) {
  const base = settings?.reference?.redmineUrl;
  return base ? `${base.replace(/\/$/, "")}/issues/${encodeURIComponent(no)}` : "#";
}

function formatLogContent(content) {
  const escaped = esc(content);
  return escaped.replace(/RESULT:\s*(PASS|FAIL)/i, (m, v) => `<span class="verdict ${v.toUpperCase() === "PASS" ? "pass" : "fail"}">${m}</span>`);
}

// ---------------------------------------------------------------------------
// レンダリング
// ---------------------------------------------------------------------------

function renderStats(queueList, historyList) {
  const running = queueList.filter((t) => t.status === "running").length;
  const waiting = queueList.filter((t) => t.status === "waiting").length;
  const todayStr = new Date().toISOString().slice(0, 10);
  const doneToday = historyList.filter((t) => t.status === "pushed" && (t.finishedAt || "").startsWith(todayStr)).length;
  const attn = historyList.filter((t) => t.status === "needs_human").length;

  $("#stats").innerHTML = `
    <div class="stat-tile is-running">
      <span class="stat-num mono">${running}</span>
      <span class="stat-label">実行中</span>
    </div>
    <div class="stat-tile is-waiting">
      <span class="stat-num mono">${waiting}</span>
      <span class="stat-label">待機中</span>
    </div>
    <div class="stat-tile is-done">
      <span class="stat-num mono">+${doneToday}</span>
      <span class="stat-label">本日の完了</span>
    </div>
    <div class="stat-tile is-attn">
      <span class="stat-num mono">${attn}</span>
      <span class="stat-label">要確認（人対応）</span>
    </div>`;
}

function renderQueueTable(items) {
  const waiting = items.filter((t) => t.status === "waiting").sort((a, b) => a.orderIndex - b.orderIndex);
  const sorted = items.slice().sort((a, b) => {
    if (a.status === "running") return -1;
    if (b.status === "running") return 1;
    return a.orderIndex - b.orderIndex;
  });

  $("#queue-body").innerHTML = sorted
    .map((t) => {
      const isWaiting = t.status === "waiting";
      const waitIdx = waiting.findIndex((w) => w.id === t.id);
      const orderCell = isWaiting
        ? `<span class="grip">
             <button class="btn quiet icon" data-move-up="${t.id}" ${waitIdx <= 0 ? "disabled" : ""} aria-label="上へ移動">▲</button>
             <button class="btn quiet icon" data-move-down="${t.id}" ${waitIdx >= waiting.length - 1 ? "disabled" : ""} aria-label="下へ移動">▼</button>
           </span>`
        : `<span class="cell-sub">実行中</span>`;

      return `
      <tr data-id="${t.id}">
        <td class="col-grip">${orderCell}</td>
        <td><a class="tno" href="${redmineIssueUrl(t.redmineTicketNo)}" target="_blank" rel="noopener">#${esc(t.redmineTicketNo)}</a></td>
        <td>
          <button class="ttitle" data-open="${t.id}">${esc(t.title || "（タイトル取得中）")}</button>
          <div class="cell-sub">${formatDateTime(t.registeredAt)} 登録</div>
        </td>
        <td>${pill(t)}</td>
        <td>${modelCell(t.implModel, settings?.defaultImplModel)}</td>
        <td>${modelCell(t.reviewModel, settings?.defaultReviewModel)}</td>
        <td><span class="user">${esc(t.registeredBy)}</span></td>
        <td class="col-actions">
          ${
            isWaiting
              ? `<button class="btn sm danger" data-del="${t.id}">削除</button>`
              : `<button class="btn sm danger" data-abort="${t.id}" ${t.abortRequested ? "disabled" : ""}>${
                  t.abortRequested ? "中断要求中" : "中断"
                }</button>
                 <button class="btn sm" data-open="${t.id}">詳細</button>`
          }
        </td>
      </tr>`;
    })
    .join("");

  $("#count-queue").textContent = items.length;
}

function renderHistoryTable(items) {
  const sorted = items.slice().sort((a, b) => new Date(b.finishedAt || 0) - new Date(a.finishedAt || 0));
  $("#history-body").innerHTML = sorted
    .map(
      (t) => `
      <tr data-id="${t.id}">
        <td><a class="tno" href="${redmineIssueUrl(t.redmineTicketNo)}" target="_blank" rel="noopener">#${esc(t.redmineTicketNo)}</a></td>
        <td><button class="ttitle" data-open="${t.id}">${esc(t.title || "（タイトル未取得）")}</button></td>
        <td>${pill(t)}</td>
        <td><span class="model">${esc(t.branchName || "—")}</span></td>
        <td><span class="model">${formatDateTime(t.finishedAt)}</span></td>
        <td class="col-actions">
          <button class="btn sm" data-open="${t.id}">詳細</button>
          <button class="btn sm danger" data-del="${t.id}">削除</button>
        </td>
      </tr>`
    )
    .join("");
  $("#count-history").textContent = items.length;
}

function renderRunnerPanel(q) {
  const running = !!q.runner.ticketId;
  $("#engine-state").textContent = running ? "実行中" : "待機中";
  $("#engine-pid").textContent = q.runner.pid ?? "—";
  $("#engine-heartbeat").textContent = q.runner.heartbeatAt ? formatTime(q.runner.heartbeatAt) : "—";
}

function renderPauseUI() {
  $("#pause-toggle").textContent = queuePaused ? "キューを再開する" : "キューを一時停止する";
  $("#runstate").classList.toggle("paused", queuePaused);
  $("#runstate-text").textContent = queuePaused ? "キュー一時停止中" : "キュー稼働中";
  $("#pause-banner").hidden = !queuePaused;
}

function renderSettingsForm(s) {
  $("#set-impl").value = s.defaultImplModel;
  $("#set-review").value = s.defaultReviewModel;
  $("#set-retry").value = s.retryLimit;
  $("#set-impl-timeout").value = s.implTimeoutMinutes;
  $("#set-review-timeout").value = s.reviewTimeoutMinutes;
  $("#ref-redmine").textContent = s.reference.redmineUrl || "（未設定）";
  $("#ref-repo").textContent = s.reference.targetRepoPath || "（未設定）";
  $("#ref-branch").textContent = s.reference.baseBranch || "（未設定）";
}

function renderDetail(t) {
  $("#d-title").textContent = t.title || "（タイトル未取得）";
  $("#d-pill").innerHTML = pill(t);
  $("#d-no").textContent = "#" + t.redmineTicketNo;
  $("#d-branch").textContent = t.branchName || `ticket/${t.redmineTicketNo}`;
  $("#d-impl").textContent = t.implModel || `${settings?.defaultImplModel}（既定）`;
  $("#d-review").textContent = t.reviewModel || `${settings?.defaultReviewModel}（既定）`;
  $("#d-retry").textContent = `${t.retryCount} / ${settings?.retryLimit ?? 3}`;
  $("#d-by").textContent = t.registeredBy;
  $("#d-started").textContent = formatDateTime(t.startedAt || t.registeredAt);

  const abortBtn = $("#d-abort");
  abortBtn.hidden = t.status !== "running";
  abortBtn.disabled = !!t.abortRequested;
  abortBtn.textContent = t.abortRequested ? "中断要求中…" : "強制中断";

  const err = $("#d-error");
  err.hidden = !t.lastError;
  if (t.lastError) err.textContent = t.lastError;
}

function renderLogs(logs) {
  $("#d-log").innerHTML = logs.length
    ? logs
        .map(
          (l) => `
          <div class="log-row">
            <div class="log-time">${formatTime(l.createdAt)}</div>
            <div class="phase ${l.phase}">${PHASE_LABEL[l.phase] || l.phase}</div>
            <div class="log-body">${formatLogContent(l.content)}</div>
          </div>`
        )
        .join("")
    : `<p class="log-empty">まだ実行されていないため、ログはありません。</p>`;
}

// ---------------------------------------------------------------------------
// 画面遷移・データ取得
// ---------------------------------------------------------------------------

function showScreen(name) {
  const labels = { queue: "キュー / 履歴", detail: "チケット詳細", settings: "設定" };
  ["queue", "detail", "settings"].forEach((s) => {
    $("#screen-" + s).hidden = s !== name;
  });
  document.querySelectorAll(".nav-item").forEach((b) => {
    if (b.dataset.screen === name) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  $("#screen-label").textContent = labels[name];
  window.scrollTo({ top: 0 });
}

async function refreshAll() {
  const [queueRes, historyRes] = await Promise.all([
    api("/api/queue?scope=queue"),
    api("/api/queue?scope=history"),
  ]);
  queuePaused = queueRes.queuePaused;
  renderRunnerPanel(queueRes);
  renderPauseUI();
  renderQueueTable(queueRes.items);
  renderHistoryTable(historyRes.items);
  renderStats(queueRes.items, historyRes.items);
}

async function openDetail(id) {
  const all = await api("/api/queue?scope=all");
  const t = all.items.find((x) => x.id === id);
  if (!t) {
    toast("チケットが見つかりませんでした（削除された可能性があります）", true);
    return;
  }
  currentDetailId = id;
  renderDetail(t);
  const logsRes = await api(`/api/queue/${id}/logs`);
  renderLogs(logsRes.logs);
  showScreen("detail");
}

let toastTimer;
function toast(message, bad) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("bad", !!bad);
  el.classList.toggle("good", !bad);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3200);
}

async function moveTicket(id, delta) {
  const q = await api("/api/queue?scope=queue");
  const waiting = q.items.filter((t) => t.status === "waiting").sort((a, b) => a.orderIndex - b.orderIndex);
  const idx = waiting.findIndex((t) => t.id === id);
  const newIndex = idx + delta;
  if (idx === -1 || newIndex < 0 || newIndex >= waiting.length) return;
  try {
    await api(`/api/queue/${id}/order`, { method: "PUT", body: JSON.stringify({ newIndex }) });
    await refreshAll();
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteTicketUI(id) {
  if (!confirm("このチケットを一覧から削除しますか？")) return;
  try {
    await api(`/api/queue/${id}`, { method: "DELETE" });
    toast("チケットを一覧から削除しました");
    await refreshAll();
  } catch (err) {
    toast(err.message, true);
  }
}

async function abortTicketUI(id) {
  if (!confirm("実行中のチケットを強制中断しますか？")) return;
  try {
    await api(`/api/queue/${id}/abort`, { method: "POST" });
    toast("中断を要求しました。実行エンジンが最大5秒以内に検知します");
    await refreshAll();
    if (currentDetailId === id) await openDetail(id);
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------------------------------------------------------------------------
// イベント
// ---------------------------------------------------------------------------

document.addEventListener("click", (e) => {
  const nav = e.target.closest(".nav-item");
  if (nav) {
    if (nav.dataset.screen === "detail" && currentDetailId == null) {
      toast("先にキュー / 履歴からチケットを選択してください", true);
      return;
    }
    showScreen(nav.dataset.screen);
    return;
  }

  const open = e.target.closest("[data-open]");
  if (open) {
    openDetail(Number(open.dataset.open));
    return;
  }

  const del = e.target.closest("[data-del]");
  if (del) {
    deleteTicketUI(Number(del.dataset.del));
    return;
  }

  const ab = e.target.closest("[data-abort]");
  if (ab && !ab.disabled) {
    abortTicketUI(Number(ab.dataset.abort));
    return;
  }

  const up = e.target.closest("[data-move-up]");
  if (up && !up.disabled) {
    moveTicket(Number(up.dataset.moveUp), -1);
    return;
  }

  const down = e.target.closest("[data-move-down]");
  if (down && !down.disabled) {
    moveTicket(Number(down.dataset.moveDown), 1);
    return;
  }
});

$("#d-abort").addEventListener("click", () => {
  if (currentDetailId != null) abortTicketUI(currentDetailId);
});
$("#back-to-list").addEventListener("click", () => showScreen("queue"));

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const isQueue = tab.id === "tab-queue";
    $("#tab-queue").setAttribute("aria-selected", String(isQueue));
    $("#tab-history").setAttribute("aria-selected", String(!isQueue));
    $("#pane-queue").hidden = !isQueue;
    $("#pane-history").hidden = isQueue;
  });
});

$("#pause-toggle").addEventListener("click", async () => {
  try {
    const res = await api(queuePaused ? "/api/queue/resume" : "/api/queue/pause", { method: "POST" });
    queuePaused = res.queuePaused;
    renderPauseUI();
  } catch (err) {
    toast(err.message, true);
  }
});

$("#add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const no = $("#add-no").value.trim();
  const err = $("#add-error");
  err.hidden = true;
  if (!/^\d+$/.test(no)) {
    err.hidden = false;
    err.textContent = no ? "チケット番号は数字で入力してください" : "チケット番号を入力してください";
    $("#add-no").focus();
    return;
  }
  try {
    await api("/api/queue", {
      method: "POST",
      body: JSON.stringify({
        redmineTicketNo: no,
        implModel: $("#add-impl").value || null,
        reviewModel: $("#add-review").value || null,
      }),
    });
    $("#add-form").reset();
    toast(`#${no} をキューの末尾に追加しました`);
    await refreshAll();
  } catch (e2) {
    err.hidden = false;
    err.textContent = e2.message;
  }
});

$("#save-settings").addEventListener("click", async () => {
  const errEl = $("#settings-error");
  errEl.hidden = true;
  try {
    const updated = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        defaultImplModel: $("#set-impl").value,
        defaultReviewModel: $("#set-review").value,
        retryLimit: Number($("#set-retry").value),
        implTimeoutMinutes: Number($("#set-impl-timeout").value),
        reviewTimeoutMinutes: Number($("#set-review-timeout").value),
      }),
    });
    settings = { ...settings, ...updated };
    $("#saved-msg").hidden = false;
    setTimeout(() => {
      $("#saved-msg").hidden = true;
    }, 2400);
  } catch (err) {
    errEl.hidden = false;
    errEl.textContent = err.message;
  }
});

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------

async function boot() {
  try {
    await api("/api/whoami");
    settings = await api("/api/settings");
    renderSettingsForm(settings);
    await refreshAll();
    showScreen("queue");
    setInterval(async () => {
      await refreshAll();
      if (!$("#screen-detail").hidden && currentDetailId != null) {
        await openDetail(currentDetailId);
      }
    }, 15000);
  } catch (err) {
    document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif;color:#DC2626;max-width:520px">
      <h1 style="font-size:16px">初期化に失敗しました</h1>
      <p>${esc(err.message)}</p>
      <p style="color:#8A91AC;font-size:13px">Windows認証が正しく構成されているか、または開発時は環境変数 DEVLOOP_DEV_USER が設定されているか確認してください。</p>
    </div>`;
  }
}

boot();
