// BVS UI v3.8 — Policy-gated event logging + Mobile Camera Flip
// - Motion is a signal always visible in UI
// - Events logged on-chain: TAMPER, MOVED, and HIGH-MOTION only (configurable)
// - Quiet Re-arm prevents repeated phantom events from camera noise/exposure
// - Mobile camera support: dropdown device select + Flip (front/back)

const $ = (id) => document.getElementById(id);

const video = $("video");
const mjpegImg = $("mjpegImg");
const canvas = $("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

const btnStart = $("btnStart");
const btnStop = $("btnStop");
const btnRefresh = $("btnRefresh");
const btnArm = $("btnArm");
const btnDisarm = $("btnDisarm");
const btnCalibrate = $("btnCalibrate");
const btnSimulate = $("btnSimulate");
const btnSetBaseline = $("btnSetBaseline");

// NEW: camera UI
const cameraSelectEl = $("cameraSelect");
const btnFlip = $("btnFlip");

const sensitivityEl = $("sensitivity"); // motion signal threshold in %
const cooldownEl = $("cooldown");
const minBurstEl = $("minBurst");
const pixelDeltaEl = $("pixelDelta");
const graceMsEl = $("graceMs");

const tamperEnabledEl = $("tamperEnabled");
const tamperHoldMsEl = $("tamperHoldMs");
const freezeHoldMsEl = $("freezeHoldMs");

const movedEnabledEl = $("movedEnabled");
const movedHoldMsEl = $("movedHoldMs");
const movedThresholdEl = $("movedThreshold");

const logMotionEnabledEl = $("logMotionEnabled");
const logMotionThresholdEl = $("logMotionThreshold");
const quietRearmMsEl = $("quietRearmMs");

const motionScoreEl = $("motionScore");
const motionBar = $("motionBar");
const burstText = $("burstText");

const statusDot = $("statusDot");
const statusText = $("statusText");
const apiText = $("apiText");
const netText = $("netText");
const armedPill = $("armedPill");
const tamperPill = $("tamperPill");
const movedPill = $("movedPill");
const countEl = $("count");
const incidentsEl = $("incidents");
const feedPanel = $("feedPanel");
const feedLiveDot = $("feedLiveDot");
const feedEventCount = $("feedEventCount");
const feedCount = $("feedCount");
const feedStatus = $("feedStatus");
const feedStatusDot = $("feedStatusDot");
const feedStatusTitle = $("feedStatusTitle");
const feedStatusSub = $("feedStatusSub");
const tamperCell = $("tamperCell");
const movedCell = $("movedCell");
const incidentScroll = $("incidentScroll");
const feedShowing = $("feedShowing");
const feedTotal = $("feedTotal");

// Active filter — "ALL" | "TAMPER" | "MOVED" | "MOTION"
let activeFilter = "ALL";

document.querySelectorAll(".feed-filter-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    activeFilter = btn.dataset.filter;
    document.querySelectorAll(".feed-filter-btn").forEach(b => b.classList.remove("active-filter"));
    btn.classList.add("active-filter");
    refreshIncidents();
  });
});

// Debug
const loopPill = $("loopPill");
const rawText = $("rawText");
const emaText = $("emaText");
const thText = $("thText");
const stopText = $("stopText");
const stateText = $("stateText");
const burstDbg = $("burstDbg");
const fpsText = $("fpsText");
const errText = $("errText");
const tamperText = $("tamperText");
const movedText = $("movedText");
const movedReasonText = $("movedReasonText");

let stream = null;
let rafId = null;
let remoteMode = false;

let armed = false;
let armedAt = null;
let lastTriggeredAt = 0;

// Track which blocks we've already shown so we can flash-animate new arrivals
const seenBlockHashes = new Set();

// Previous detection states — used to detect transitions and trigger immediate feed refresh
let prevTamperSuspected = false;
let prevRepositionSuspected = false;

// WebSocket — real-time feed updates from backend (port 5501)
(function connectWS() {
  try {
    const wsUrl = location.protocol === "https:"
      ? `wss://${location.host}/ws`
      : `ws://${location.hostname || "localhost"}:5501`;
    const ws = new WebSocket(wsUrl);
    ws.onmessage = () => refreshIncidents();
    ws.onclose = () => setTimeout(connectWS, 3000); // auto-reconnect
  } catch {
    // WS unavailable — feed still works via POST callback
  }
})();

// Motion state (signal)
let prevGray = null;
let ema = 0;
const EMA_ALPHA = 0.25;

let motionActive = false;
let activeStartAt = null;
let burstMs = 0;
let belowSince = null;

// NEW: quiet gating (prevents repeated false events)
let quietSince = null;

// Tamper state
let tamperStartAt = null;
let freezeStartAt = null;
let tamperSuspected = false;
let tamperReason = "—";

// Reposition baseline + timers
let baselineHash = null;          // Uint32Array(2)
let baselineSetAt = null;         // epoch ms
let baselineAutoAt = null;        // epoch ms
const BASELINE_WARMUP_MS = 1400;

let movedStartAt = null;
let repositionSuspected = false;
let repositionReason = "—";
let lastHashDist = 0;

// FPS
let frameCount = 0;
let lastFpsAt = performance.now();

// Downscale
const SMALL_W = 160;
const SMALL_H = 90;
const smallCanvas = document.createElement("canvas");
smallCanvas.width = SMALL_W;
smallCanvas.height = SMALL_H;
const smallCtx = smallCanvas.getContext("2d", { willReadFrequently: true });

// -------------------------------
// Camera selection / flip state
// -------------------------------
let selectedDeviceId = "";
let facingMode = "environment"; // back camera preferred on phones
let hasEverRequestedPermission = false;

function isCameraRunning() {
  if (remoteMode) return !!stream;
  try {
    return !!(video && video.srcObject && video.srcObject.getTracks().some(t => t.readyState === "live"));
  } catch {
    return false;
  }
}

async function ensureLabelsAvailableOnce() {
  // device labels on iOS/Safari often require permission first
  if (hasEverRequestedPermission) return;
  try {
    await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    hasEverRequestedPermission = true;
  } catch {
    // Ignore. If permission denied, enumeration will still work but labels may be blank.
  }
}

async function populateCameras() {
  if (!cameraSelectEl || !navigator.mediaDevices?.enumerateDevices) return;

  await ensureLabelsAvailableOnce();

  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === "videoinput");

  const keep = cameraSelectEl.value || selectedDeviceId || "";
  cameraSelectEl.innerHTML =
    `<option value="__remote__">Axis Camera</option>` +
    `<option value="">Local camera</option>` +
    cams.map((c, i) => {
      const name = (c.label || "").trim() || `Camera ${i + 1}`;
      return `<option value="${c.deviceId}">${name}</option>`;
    }).join("");

  if (keep) cameraSelectEl.value = keep;

  cameraSelectEl.onchange = async () => {
    selectedDeviceId = cameraSelectEl.value || "";
    if (isCameraRunning()) {
      await restartCamera();
    }
  };
}

function getVideoConstraints() {
  // If user explicitly chose a device, use it.
  if (selectedDeviceId) {
    return {
      deviceId: { exact: selectedDeviceId },
      width: { ideal: 960 },
      height: { ideal: 540 }
    };
  }
  // Otherwise use facingMode best-effort (mobile flip)
  return {
    facingMode: { ideal: facingMode },
    width: { ideal: 960 },
    height: { ideal: 540 }
  };
}

async function flipCamera() {
  facingMode = (facingMode === "user") ? "environment" : "user";
  selectedDeviceId = "";
  if (cameraSelectEl) cameraSelectEl.value = "";
  if (isCameraRunning()) {
    await restartCamera();
  }
}

async function restartCamera() {
  try {
    stopCamera();
    await startCamera();
  } catch (e) {
    console.error(e);
    setError(e?.message || String(e));
  }
}

btnFlip?.addEventListener("click", flipCamera);
navigator.mediaDevices?.addEventListener?.("devicechange", populateCameras);

// -------------------------------

let lastError = "none";
function setError(msg) {
  lastError = msg || "none";
  errText.textContent = lastError;
  errText.title = lastError;
}
window.addEventListener("error", (e) => setError(e?.message || "window error"));
window.addEventListener("unhandledrejection", (e) => setError(e?.reason?.message || String(e?.reason || "promise rejection")));

function setStatus(state, detail) {
  const dotClass =
    state === "running" ? "bg-emerald-400" :
    state === "error" ? "bg-red-400" :
    "bg-slate-500";
  statusDot.className = `inline-block h-2.5 w-2.5 rounded-full ${dotClass}`;
  statusText.textContent = detail || (state === "running" ? "Live" : state === "error" ? "Error" : "Idle");
}

function getActiveCameraId() {
  if (remoteMode) return "axis-camera";
  const label = (cameraSelectEl?.options[cameraSelectEl?.selectedIndex]?.text || "").trim();
  return label || "local-camera";
}

function setArmed(on) {
  armed = on;
  armedAt = on ? Date.now() : null;
  if (on) {
    armedPill.classList.remove("hidden");
    btnArm.disabled = true;
    btnDisarm.disabled = false;

    btnArm.className =
      "px-4 py-2 rounded-xl bg-emerald-600/90 border border-emerald-500/40 font-medium opacity-60 cursor-not-allowed";
    btnDisarm.className =
      "px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 font-medium";

    setStatus(stream ? "running" : "idle", stream ? "Live • Armed" : "Idle • Armed");
    if (stream) baselineAutoAt = Date.now();
  } else {
    armedPill.classList.add("hidden");
    btnArm.disabled = false;
    btnDisarm.disabled = true;

    btnArm.className =
      "px-4 py-2 rounded-xl bg-emerald-600/90 hover:bg-emerald-500 border border-emerald-500/40 font-medium";
    btnDisarm.className =
      "px-4 py-2 rounded-xl bg-slate-800 border border-slate-700 font-medium opacity-60 cursor-not-allowed";

    setStatus(stream ? "running" : "idle", stream ? "Live • Disarmed" : "Idle");
    movedPill.classList.add("hidden");
    tamperPill.classList.add("hidden");
  }
}

async function checkHealth() {
  try {
    const r = await fetch(`${location.origin}/blocks`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    apiText.textContent = "OK";
    apiText.className = "text-emerald-300";
    netText.textContent = "local";
  } catch {
    apiText.textContent = "DOWN";
    apiText.className = "text-red-300";
    netText.textContent = "unknown";
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Update the live status banner + feed panel border based on current detection state
function updateFeedStatus() {
  if (!feedStatus || !feedPanel) return;

  if (!armed || !stream) {
    feedStatus.classList.add("hidden");
    feedPanel.style.borderColor = "";
    feedPanel.style.boxShadow = "";
    return;
  }
  feedStatus.classList.remove("hidden");

  // Clear blink classes first
  feedPanel.classList.remove("feed-blink-tamper", "feed-blink-moved");
  feedPanel.style.borderColor = "";
  feedPanel.style.boxShadow = "";

  if (tamperSuspected) {
    feedStatus.className = "mx-5 mt-4 rounded-2xl px-4 py-3 flex items-center gap-3 bg-red-500/10 border border-red-500/40";
    feedStatusDot.className = "h-3 w-3 rounded-full bg-red-400 shrink-0 live-dot";
    feedStatusTitle.textContent = "TAMPER DETECTED";
    feedStatusTitle.className = "text-sm font-bold text-red-300 tracking-wide";
    feedStatusSub.textContent = tamperReason === "FEED_FROZEN"
      ? "Feed is frozen — camera may be covered or disabled"
      : "Lens is blocked or obstructed — recording on-chain";
    feedStatusSub.className = "text-xs mt-0.5 text-red-400/90";
    feedPanel.classList.add("feed-blink-tamper");
  } else if (repositionSuspected) {
    feedStatus.className = "mx-5 mt-4 rounded-2xl px-4 py-3 flex items-center gap-3 bg-amber-500/10 border border-amber-500/40";
    feedStatusDot.className = "h-3 w-3 rounded-full bg-amber-400 shrink-0 live-dot";
    feedStatusTitle.textContent = "MOVED";
    feedStatusTitle.className = "text-sm font-bold text-amber-300 tracking-wide";
    feedStatusSub.textContent = `Position shift detected — hash delta ${lastHashDist}/64 — recording on-chain`;
    feedStatusSub.className = "text-xs mt-0.5 text-amber-400/90";
    feedPanel.classList.add("feed-blink-moved");
  } else {
    feedStatus.className = "mx-5 mt-4 rounded-2xl px-4 py-3 flex items-center gap-3 bg-emerald-500/10 border border-emerald-500/35";
    feedStatusDot.className = "h-3 w-3 rounded-full bg-emerald-400 shrink-0";
    feedStatusTitle.textContent = "ALL CLEAR";
    feedStatusTitle.className = "text-sm font-bold text-emerald-300 tracking-wide";
    feedStatusSub.textContent = "Camera unobstructed — no threats detected — system monitoring";
    feedStatusSub.className = "text-xs mt-0.5 text-emerald-400/90";
    feedPanel.style.borderColor = "rgba(52,211,153,0.35)";
    feedPanel.style.boxShadow = "0 0 0 1px rgba(52,211,153,0.12), 0 0 20px rgba(52,211,153,0.06)";
  }
}

// Flash the feed panel border on new events
function alertFeedPanel(isThreat) {
  if (!feedPanel) return;
  feedPanel.classList.remove("feed-panel-alert");
  void feedPanel.offsetWidth; // force reflow to restart animation
  if (isThreat) feedPanel.classList.add("feed-panel-alert");
}

function badgeFor(i) {
  const sig = i.signals || {};
  if (sig.tamperSuspected || sig.repositionSuspected) return "border-red-500/40 bg-red-500/10 text-red-200";
  const t = (i.type || "").toUpperCase();
  if (t === "TAMPER" || t === "MOVED") return "border-red-500/40 bg-red-500/10 text-red-200";
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
}

function dotFor(i) {
  const t = (i.type || "").toUpperCase();
  if (t === "TAMPER" || t === "MOVED") return "bg-red-400";
  return "bg-emerald-400";
}

function faceStatusFor(i) {
  const fa = i.faceAnalysis;
  if (!fa) return null;
  const d = fa.frDecision || "PENDING";
  if (d === "PENDING")  return { label: "FR: PENDING",  cls: "border-slate-600/50 text-slate-400 bg-slate-800/60" };
  if (d === "ALLOW")    return { label: "FR: ALLOW",    cls: "border-emerald-500/40 text-emerald-300 bg-emerald-500/10" };
  if (d === "UNKNOWN")  return { label: "FR: UNKNOWN",  cls: "border-amber-500/40 text-amber-300 bg-amber-500/10" };
  if (d === "NO_FACE")  return { label: "FR: NO FACE",  cls: "border-slate-600/50 text-slate-500 bg-slate-800/60" };
  if (d === "NO_IMAGE") return null;
  return { label: "FR: " + d, cls: "border-slate-600/50 text-slate-400 bg-slate-800/60" };
}

async function refreshIncidents() {
  try {
    const r = await fetch(`${location.origin}/blocks`, { cache: "no-store" });
    const list = await r.json();

    list.sort((a, b) => String(b.ts || b._blockTs || "").localeCompare(String(a.ts || a._blockTs || "")));
    countEl.textContent = String(list.length);

    // Update feed header count
    if (feedCount) feedCount.textContent = String(list.length);
    if (feedEventCount) feedEventCount.classList.remove("hidden");

    // Identify which events are brand-new (not yet seen)
    const newHashes = new Set();
    list.forEach((i) => {
      const key = i._blockHash || i.ts || "";
      if (key && !seenBlockHashes.has(key)) {
        newHashes.add(key);
        seenBlockHashes.add(key);
      }
    });

    // Show live dot when camera is running, fire panel glow on new events
    if (feedLiveDot) feedLiveDot.classList.toggle("hidden", !stream);
    if (newHashes.size > 0) {
      const newItems = list.filter(i => newHashes.has(i._blockHash || i.ts || ""));
      const hasThreat = newItems.some(i => {
        const t = (i.type || "").toUpperCase();
        return t === "TAMPER" || t === "MOVED" || t === "THREAT";
      });
      alertFeedPanel(hasThreat);
    }

    // Apply active filter
    const filtered = activeFilter === "ALL"
      ? list
      : list.filter(i => (i.type || "").toUpperCase() === activeFilter);

    // Update count labels
    if (feedTotal)   feedTotal.textContent   = String(list.length);
    if (feedShowing) feedShowing.textContent = String(filtered.length);

    // Preserve which cards are currently expanded so rebuild doesn't close them
    const openKeys = new Set(
      [...incidentsEl.querySelectorAll("details[open][data-key]")].map(d => d.dataset.key)
    );

    incidentsEl.innerHTML = filtered.length
      ? filtered.map((i) => {
          const ts = i.ts ? new Date(i.ts).toLocaleString() : (i._blockTs ? new Date(i._blockTs).toLocaleString() : "");
          const badge = badgeFor(i);
          const dot = dotFor(i);

          const reasons = Array.isArray(i.reasons) ? i.reasons : [];
          // Fallback for old-format events that stored reasons differently
          const topReason = reasons[0]
            ? escapeHtml(reasons[0])
            : i.meta?.why
            ? escapeHtml(i.meta.why)
            : "Event logged";

          const blockIndex = i._blockIndex != null ? `${i._blockIndex}` : "";
          const blockHash = i._blockHash || "";
          const prevHash = i._prevHash || "";

          const key = i._blockHash || i.ts || "";
          const isNew = newHashes.has(key);
          const t = (i.type || "").toUpperCase();
          const flashClass = isNew
            ? (t === "TAMPER" || t === "MOVED" || t === "THREAT" ? "event-flash-threat" : "event-flash-motion")
            : "";

          // Type-specific accent colors
          const isThreat = t === "TAMPER" || t === "THREAT";
          const isMoved  = t === "MOVED";
          const accentBorder = isThreat ? "border-l-red-500/70"
                             : isMoved  ? "border-l-amber-500/70"
                             :            "border-l-indigo-500/50";
          const accentBg    = isThreat ? "bg-red-500/5"
                            : isMoved  ? "bg-amber-500/5"
                            :            "bg-indigo-500/5";
          const severityBar = isThreat ? "bg-red-500"
                            : isMoved  ? "bg-amber-500"
                            :            "bg-indigo-500";

          // Type-specific inline detail section (shown in summary)
          let typeDetail = "";
          if (isThreat) {
            const reason = i.meta?.tamperReason || topReason;
            const label  = reason === "FEED_FROZEN" ? "Feed Frozen" : "Lens Obstructed";
            const stats  = i.meta?.tamperStats || {};
            typeDetail = `
              <div class="mt-2 flex items-center gap-2 flex-wrap">
                <span class="text-[11px] px-2 py-0.5 rounded border border-red-500/40 text-red-300 bg-red-500/10 font-semibold">${escapeHtml(label)}</span>
                ${stats.mean != null ? `<span class="text-[11px] text-slate-500">Brightness: <span class="text-slate-400">${Number(stats.mean).toFixed(1)}</span></span>` : ""}
                ${stats.std  != null ? `<span class="text-[11px] text-slate-500">Std dev: <span class="text-slate-400">${Number(stats.std).toFixed(2)}</span></span>` : ""}
              </div>`;
          } else if (isMoved) {
            const dist      = i.meta?.hashDistance ?? 0;
            const threshold = i.meta?.movedThreshold ?? 18;
            const shiftPct  = Math.min(100, Math.round((dist / 64) * 100));
            const baseAge   = i.meta?.baselineAgeMs != null
              ? (i.meta.baselineAgeMs < 60000
                  ? `${(i.meta.baselineAgeMs / 1000).toFixed(1)}s`
                  : `${(i.meta.baselineAgeMs / 60000).toFixed(1)}m`)
              : "—";
            typeDetail = `
              <div class="mt-2 space-y-1">
                <div class="flex items-center gap-2">
                  <span class="text-[11px] text-slate-500 w-20 shrink-0">Position shift</span>
                  <div class="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                    <div class="h-1.5 rounded-full bg-amber-500" style="width:${shiftPct}%"></div>
                  </div>
                  <span class="text-[11px] font-mono text-amber-300">${dist}/${threshold} (${shiftPct}%)</span>
                </div>
                <div class="flex items-center gap-3">
                  <span class="text-[11px] text-slate-500">Baseline age: <span class="text-slate-400">${baseAge}</span></span>
                </div>
              </div>`;
          } else {
            const ema  = i.meta?.motionEma  ?? i.meta?.motionScore ?? 0;
            const raw  = i.meta?.motionScore ?? 0;
            const bust = i.meta?.burstMs ?? 0;
            const emaPct = Math.min(100, Math.round(ema));
            typeDetail = `
              <div class="mt-2 space-y-1">
                <div class="flex items-center gap-2">
                  <span class="text-[11px] text-slate-500 w-20 shrink-0">Motion EMA</span>
                  <div class="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                    <div class="h-1.5 rounded-full bg-indigo-500" style="width:${emaPct}%"></div>
                  </div>
                  <span class="text-[11px] font-mono text-indigo-300">${Number(ema).toFixed(1)}%</span>
                </div>
                <div class="flex items-center gap-3">
                  <span class="text-[11px] text-slate-500">Raw: <span class="text-slate-400">${Number(raw).toFixed(1)}%</span></span>
                  <span class="text-[11px] text-slate-500">Burst: <span class="text-slate-400">${Math.round(bust)}ms</span></span>
                </div>
              </div>`;
          }

          return `
            <details data-key="${escapeHtml(key)}" class="group rounded-2xl border border-slate-800 border-l-4 ${accentBorder} ${accentBg} overflow-hidden ${flashClass}">
              <summary class="cursor-pointer list-none px-4 py-3 hover:bg-white/[0.02] transition-colors flex items-start gap-3">
                <div class="mt-1 h-2.5 w-2.5 rounded-full ${dot} shrink-0 ${isNew ? "live-dot" : ""}"></div>
                <div class="flex-1 min-w-0">

                  <!-- Header row -->
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="inline-flex items-center gap-1.5 text-[12px] px-2 py-1 rounded-lg border ${badge} font-semibold tracking-wide">
                      ${escapeHtml(i.type || "EVENT")}
                    </span>
                    <span class="text-[11px] text-slate-400">${escapeHtml(i.cameraId || "")}</span>
                    ${i.evidenceHash ? `<span class="text-[10px] px-1.5 py-0.5 rounded border border-slate-600/50 text-slate-400 bg-slate-800/60 font-mono">SHA-256</span>` : ""}
                    ${(() => { const fr = faceStatusFor(i); return fr ? `<span class="text-[10px] px-1.5 py-0.5 rounded border ${fr.cls} font-mono">${fr.label}</span>` : ""; })()}
                    ${blockIndex ? `<span class="ml-auto text-[10px] px-1.5 py-0.5 rounded border border-indigo-500/30 text-indigo-400 bg-indigo-500/10 font-mono">Block #${escapeHtml(blockIndex)}</span>` : ""}
                    ${isNew ? `<span class="text-[10px] px-1.5 py-0.5 rounded border border-red-500/50 text-red-300 bg-red-500/10 font-bold uppercase tracking-widest">NEW</span>` : ""}
                  </div>

                  <!-- Severity bar -->
                  <div class="mt-2 flex items-center gap-2">
                    <div class="flex-1 h-1 rounded-full bg-slate-800 overflow-hidden">
                      <div class="h-1 rounded-full ${severityBar}" style="width:${Math.min(100, i.severity || 50)}%"></div>
                    </div>
                    <span class="text-[10px] text-slate-500 font-mono">sev ${i.severity ?? "—"}</span>
                  </div>

                  <!-- Type-specific detail -->
                  ${typeDetail}

                  <div class="mt-2 text-[11px] text-slate-500">${escapeHtml(ts)}</div>
                </div>
              </summary>

              <!-- Expanded detail -->
              <div class="border-t border-slate-800/60 px-4 pb-4 pt-3 space-y-3">

                ${i._hasImage && i._blockIndex != null ? `
                <div>
                  <div class="text-[11px] text-slate-500 mb-1.5">Snapshot at time of event</div>
                  <img loading="lazy" src="${location.origin}/block/${i._blockIndex}/img" class="w-full rounded-xl border border-slate-800 bg-black" />
                </div>` : ""}

                <!-- Chain integrity -->
                <div class="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-3 space-y-2">
                  <div class="text-[11px] font-bold text-indigo-300 tracking-wide uppercase">Chain Integrity</div>
                  <div class="grid grid-cols-1 gap-2">
                    <div>
                      <div class="text-[10px] text-slate-500 uppercase tracking-wide">Block Hash (SHA-256)</div>
                      <div class="mt-0.5 text-[10px] font-mono break-all text-indigo-200">${escapeHtml(blockHash)}</div>
                    </div>
                    <div>
                      <div class="text-[10px] text-slate-500 uppercase tracking-wide">Previous Block Hash</div>
                      <div class="mt-0.5 text-[10px] font-mono break-all text-slate-400">${escapeHtml(prevHash)}</div>
                    </div>
                  </div>
                </div>

                <!-- Hashes -->
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div class="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <div class="text-[10px] text-slate-500 uppercase tracking-wide">Evidence Hash</div>
                    <div class="mt-1 text-[10px] font-mono break-all text-slate-300">${escapeHtml(i.evidenceHash || "—")}</div>
                  </div>
                  <div class="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <div class="text-[10px] text-slate-500 uppercase tracking-wide">Metadata Hash</div>
                    <div class="mt-1 text-[10px] font-mono break-all text-slate-300">${escapeHtml(i.metadataHash || "—")}</div>
                  </div>
                </div>

                <!-- Face Recognition -->
                ${(() => {
                  const fa = i.faceAnalysis;
                  if (!fa || fa.frDecision === "NO_IMAGE") return "";
                  const d = fa.frDecision || "PENDING";
                  const decisionColor = d === "ALLOW" ? "text-emerald-300" : d === "UNKNOWN" ? "text-amber-300" : "text-slate-400";
                  const match = fa.bestMatch;
                  const confidence = match?.score != null ? `${(match.score * 100).toFixed(1)}%` : "—";
                  const faceCount = Array.isArray(fa.faces) ? fa.faces.length : "—";
                  return `
                  <div class="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-3 space-y-2">
                    <div class="text-[11px] font-bold text-indigo-300 tracking-wide uppercase">Face Recognition</div>
                    <div class="grid grid-cols-3 gap-2">
                      <div>
                        <div class="text-[10px] text-slate-500 uppercase tracking-wide">Decision</div>
                        <div class="mt-0.5 text-[11px] font-bold ${decisionColor}">${d}</div>
                      </div>
                      <div>
                        <div class="text-[10px] text-slate-500 uppercase tracking-wide">Best Match</div>
                        <div class="mt-0.5 text-[11px] text-slate-300">${match?.id ? escapeHtml(match.id) : "—"}</div>
                      </div>
                      <div>
                        <div class="text-[10px] text-slate-500 uppercase tracking-wide">Confidence</div>
                        <div class="mt-0.5 text-[11px] font-mono text-slate-300">${confidence}</div>
                      </div>
                    </div>
                    <div class="text-[10px] text-slate-500">Faces detected: <span class="text-slate-400">${faceCount}</span>${fa.error ? ` · Error: <span class="text-red-400">${escapeHtml(fa.error)}</span>` : ""}</div>
                  </div>`;
                })()}

                <!-- Raw metadata -->
                <div class="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                  <div class="text-[10px] text-slate-500 uppercase tracking-wide mb-1.5">Raw Event Metadata</div>
                  <pre class="text-[10px] text-slate-400 overflow-auto max-h-40 leading-relaxed"><code>${escapeHtml(JSON.stringify({ ...i.meta || {}, faceAnalysis: i.faceAnalysis || undefined }, null, 2))}</code></pre>
                </div>
              </div>
            </details>
          `;
        }).join("")
      : `<div class="text-slate-400 text-sm py-4 text-center">${activeFilter === "ALL" ? "No incidents yet." : `No ${activeFilter} events.`}</div>`;

    // Restore previously open cards
    incidentsEl.querySelectorAll("details[data-key]").forEach(d => {
      if (openKeys.has(d.dataset.key)) d.open = true;
    });
  } catch (e) {
    console.error(e);
    setError(e?.message || String(e));
    setStatus("error", "Failed loading incidents");
    incidentsEl.innerHTML = `<div class="text-red-300 text-sm">Failed to load incidents.</div>`;
  }
}

async function postIncident(payload) {
  const r = await fetch(`${location.origin}/newEvent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || `POST failed (${r.status})`);
  return j;
}

function grabGraySmall() {
  smallCtx.drawImage(remoteMode ? mjpegImg : video, 0, 0, SMALL_W, SMALL_H);
  const img = smallCtx.getImageData(0, 0, SMALL_W, SMALL_H).data;
  const gray = new Uint8ClampedArray(SMALL_W * SMALL_H);
  for (let i = 0, j = 0; i < img.length; i += 4, j++) {
    gray[j] = (img[i] + img[i + 1] + img[i + 2]) / 3;
  }
  return gray;
}

function motionPercent(prev, cur, pixelDelta) {
  let changed = 0;
  const stride = 2;
  for (let i = 0; i < cur.length; i += stride) {
    if (Math.abs(cur[i] - prev[i]) >= pixelDelta) changed++;
  }
  const total = Math.ceil(cur.length / stride);
  return (changed / Math.max(1, total)) * 100;
}

function frameStats(prev, cur) {
  const stride = 3;
  let sum = 0, sumsq = 0, diffSum = 0, n = 0;
  for (let i = 0; i < cur.length; i += stride) {
    const v = cur[i];
    sum += v;
    sumsq += v * v;
    if (prev) diffSum += Math.abs(v - prev[i]);
    n++;
  }
  const mean = sum / Math.max(1, n);
  const variance = (sumsq / Math.max(1, n)) - mean * mean;
  const std = Math.sqrt(Math.max(0, variance));
  const meanAbsDiff = prev ? (diffSum / Math.max(1, n)) : 0;
  return { mean, std, meanAbsDiff };
}

// dHash64 (two Uint32s)
function dHash64(gray, w, h) {
  const cols = 9, rows = 8;
  const sample = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const y = Math.floor((r + 0.5) * (h / rows));
    for (let c = 0; c < cols; c++) {
      const x = Math.floor((c + 0.5) * (w / cols));
      const idx = Math.min(w * h - 1, y * w + x);
      sample[r * cols + c] = gray[idx];
    }
  }
  let lo = 0 >>> 0, hi = 0 >>> 0, bit = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const v = sample[r * cols + c] > sample[r * cols + c + 1] ? 1 : 0;
      if (bit < 32) lo = (lo | (v << bit)) >>> 0;
      else hi = (hi | (v << (bit - 32))) >>> 0;
      bit++;
    }
  }
  return new Uint32Array([lo, hi]);
}

function popcount32(x) {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
}
function hamming64(a, b) {
  return popcount32((a[0] ^ b[0]) >>> 0) + popcount32((a[1] ^ b[1]) >>> 0);
}

function setBaselineNow(source = "MANUAL") {
  if (!prevGray) return;
  baselineHash = dHash64(prevGray, SMALL_W, SMALL_H);
  baselineSetAt = Date.now();
  movedStartAt = null;
  repositionSuspected = false;
  repositionReason = `BASELINE_SET_${source}`;
  movedPill.classList.add("hidden");
}

function updateUI(rawPct, thPct, burst) {
  motionScoreEl.textContent = rawPct.toFixed(2);
  const pct = Math.max(0, Math.min(100, rawPct));
  motionBar.style.width = `${pct}%`;
  motionBar.style.opacity = rawPct > thPct ? "1" : "0.55";
  burstText.textContent = `${Math.round(burst)}ms`;
}

function updatePills() {
  if (tamperSuspected) tamperPill.classList.remove("hidden");
  else tamperPill.classList.add("hidden");
  if (repositionSuspected) movedPill.classList.remove("hidden");
  else movedPill.classList.add("hidden");

  // Keep system status text in sync with live detection state
  if (stream && armed) {
    if (tamperSuspected) {
      setStatus("error", "Live • Armed • TAMPERED");
    } else if (repositionSuspected) {
      setStatus("error", "Live • Armed • MOVED");
    } else {
      setStatus("running", "Live • Armed");
    }
  }

  updateFeedStatus();
}

function flashCell(el, cls) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth; // force reflow to restart animation
  el.classList.add(cls);
}

function updateDebug(rawPct, emaPct, th, stopTh, state, burst, fps) {
  rawText.textContent = rawPct.toFixed(2);
  emaText.textContent = emaPct.toFixed(2);
  thText.textContent = th.toFixed(1);
  stopText.textContent = stopTh.toFixed(1);
  stateText.textContent = state;
  burstDbg.textContent = String(Math.round(burst));
  fpsText.textContent = String(fps);

  // Tamper cell
  tamperText.textContent = tamperSuspected ? "YES" : "NO";
  tamperText.className = tamperSuspected ? "text-red-300 font-bold" : "text-slate-200";
  if (tamperSuspected && !prevTamperSuspected) {
    flashCell(tamperCell, "cell-flash-red");
    refreshIncidents(); // immediate feed update on transition to YES
  }
  prevTamperSuspected = tamperSuspected;

  // Moved cell
  movedText.textContent = repositionSuspected ? "YES" : "NO";
  movedText.className = repositionSuspected ? "text-amber-300 font-bold" : "text-slate-200";
  if (repositionSuspected && !prevRepositionSuspected) {
    flashCell(movedCell, "cell-flash-amber");
    refreshIncidents(); // immediate feed update on transition to YES
  }
  prevRepositionSuspected = repositionSuspected;

  updatePills();
}

async function startCamera() {
  // Remote MJPEG mode — bypass getUserMedia entirely
  if (cameraSelectEl?.value === "__remote__") {
    remoteMode = true;
    mjpegImg.src = location.protocol === "https:"
      ? `${location.origin}/camera`
      : "http://160.202.129.129:5600/camera";
    mjpegImg.classList.remove("hidden");
    video.classList.add("hidden");
    stream = "remote";
    canvas.width = 640;
    canvas.height = 480;

    prevGray = null; ema = 0; motionActive = false; activeStartAt = null;
    burstMs = 0; belowSince = null; quietSince = null;
    tamperStartAt = null; freezeStartAt = null;
    tamperSuspected = false; tamperReason = "—";
    baselineHash = null; baselineSetAt = null; baselineAutoAt = Date.now();
    movedStartAt = null; repositionSuspected = false;
    repositionReason = "—"; lastHashDist = 0; lastTriggeredAt = 0;
    frameCount = 0; lastFpsAt = performance.now();
    loopPill.textContent = "LOOP: RUNNING";
    setStatus("running", armed ? "Live • Armed" : "Live • Disarmed");
    loop();
    return;
  }

  // Local camera mode
  remoteMode = false;
  mjpegImg.src = "";
  mjpegImg.classList.add("hidden");
  video.classList.remove("hidden");

  try {
    await checkHealth();
    setError("none");

    // Populate camera dropdown (labels) after permission if possible
    await populateCameras();

    stream = await navigator.mediaDevices.getUserMedia({
      video: getVideoConstraints(),
      audio: false
    });

    video.srcObject = stream;
    await video.play();

    canvas.width = video.videoWidth || 960;
    canvas.height = video.videoHeight || 540;

    prevGray = null;
    ema = 0;
    motionActive = false;
    activeStartAt = null;
    burstMs = 0;
    belowSince = null;

    quietSince = null;

    tamperStartAt = null;
    freezeStartAt = null;
    tamperSuspected = false;
    tamperReason = "—";

    baselineHash = null;
    baselineSetAt = null;
    baselineAutoAt = Date.now();

    movedStartAt = null;
    repositionSuspected = false;
    repositionReason = "—";
    lastHashDist = 0;

    lastTriggeredAt = 0;

    frameCount = 0;
    lastFpsAt = performance.now();
    loopPill.textContent = "LOOP: RUNNING";

    setStatus("running", armed ? "Live • Armed" : "Live • Disarmed");
    loop();
  } catch (e) {
    console.error(e);
    const isHttp = location.protocol === "http:" && location.hostname !== "localhost";
    const msg = isHttp
      ? "Local camera requires HTTPS — use Axis Camera instead"
      : "Camera blocked/unavailable — check browser permissions";
    setError(e?.message || String(e));
    setStatus("error", msg);
    loopPill.textContent = "LOOP: ERROR";
  }
}

function stopCamera() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  if (remoteMode) {
    mjpegImg.src = "";
    mjpegImg.classList.add("hidden");
    video.classList.remove("hidden");
    remoteMode = false;
  } else if (stream) {
    stream.getTracks().forEach((t) => t.stop());
  }
  stream = null;

  prevGray = null;
  ema = 0;
  motionActive = false;
  activeStartAt = null;
  burstMs = 0;
  belowSince = null;

  quietSince = null;

  tamperStartAt = null;
  freezeStartAt = null;
  tamperSuspected = false;
  tamperReason = "—";

  baselineHash = null;
  baselineSetAt = null;
  baselineAutoAt = null;

  movedStartAt = null;
  repositionSuspected = false;
  repositionReason = "—";
  lastHashDist = 0;

  loopPill.textContent = "LOOP: IDLE";
  setStatus("idle", armed ? "Idle • Armed" : "Idle");

  tamperPill.classList.add("hidden");
  movedPill.classList.add("hidden");
}

function loop() {
  // FPS
  frameCount++;
  const nowPerf = performance.now();
  const elapsed = nowPerf - lastFpsAt;
  let fps = Number(fpsText.textContent || "0");
  if (elapsed >= 1000) {
    fps = Math.round((frameCount * 1000) / elapsed);
    frameCount = 0;
    lastFpsAt = nowPerf;
  }

  const curGray = grabGraySmall();
  const pixelDelta = Number(pixelDeltaEl.value || 18);

  let rawPct = 0;
  if (prevGray) rawPct = motionPercent(prevGray, curGray, pixelDelta);

  ema = ema === 0 ? rawPct : (ema * (1 - EMA_ALPHA) + rawPct * EMA_ALPHA);

  const th = Number(sensitivityEl.value || 6);
  const stopTh = th * 0.6;
  const graceMs = Number(graceMsEl.value || 300);
  const cooldownMs = Number(cooldownEl.value || 1200);
  const minBurstMs = Number(minBurstEl.value || 600);

  const quietRearmMs = Number(quietRearmMsEl.value || 400);

  const now = Date.now();

  // Motion burst (signal)
  if (!motionActive) {
    if (prevGray && ema >= th) {
      motionActive = true;
      activeStartAt = now;
      burstMs = 0;
      belowSince = null;
    }
  } else {
    if (ema < stopTh) {
      if (belowSince === null) belowSince = now;
      const dippedFor = now - belowSince;
      if (dippedFor > graceMs) {
        motionActive = false;
        activeStartAt = null;
        burstMs = 0;
        belowSince = null;
      } else {
        burstMs = activeStartAt ? (now - activeStartAt) : 0;
      }
    } else {
      belowSince = null;
      burstMs = activeStartAt ? (now - activeStartAt) : 0;
    }
  }

  // Quiet re-arm tracking: we only allow another EVENT if the scene has been calm for a bit
  const isQuietNow = ema < stopTh;
  if (isQuietNow) {
    if (quietSince === null) quietSince = now;
  } else {
    quietSince = null;
  }
  const quietEnough = quietRearmMs === 0 ? true : (quietSince !== null && (now - quietSince) >= quietRearmMs);

  // Tamper
  const tamperEnabled = Boolean(tamperEnabledEl?.checked);
  const tamperHoldMs = Number(tamperHoldMsEl.value || 400);
  const freezeHoldMs = Number(freezeHoldMsEl.value || 1200);

  const { mean, std, meanAbsDiff } = frameStats(prevGray, curGray);

  // Relaxed: catches partial blocking, hand-over-lens, dim cover
  const lensCoveredNow = std < 15 && (mean < 60 || mean > 210);
  const frozenNow = prevGray && meanAbsDiff < 0.7;

  let lensCoveredFlag = false;
  let frozenFlag = false;

  const tamperWarm = armedAt !== null && (now - armedAt) >= 3000;
  if (armed && tamperWarm && tamperEnabled && stream && prevGray) {
    if (lensCoveredNow) {
      if (tamperStartAt === null) tamperStartAt = now;
      if (now - tamperStartAt >= tamperHoldMs) lensCoveredFlag = true;
    } else {
      tamperStartAt = null;
    }

    if (frozenNow) {
      if (freezeStartAt === null) freezeStartAt = now;
      if (now - freezeStartAt >= freezeHoldMs) frozenFlag = true;
    } else {
      freezeStartAt = null;
    }
  } else {
    tamperStartAt = null;
    freezeStartAt = null;
  }

  tamperSuspected = Boolean(lensCoveredFlag || frozenFlag);
  tamperReason =
    lensCoveredFlag ? "LENS_COVER_OR_OBSTRUCTION" :
    frozenFlag ? "FEED_FROZEN" :
    "—";

  // Reposition (settle-based)
  const movedEnabled = Boolean(movedEnabledEl?.checked);
  const movedHoldMs = Number(movedHoldMsEl.value || 500);
  const movedThreshold = Number(movedThresholdEl.value || 18);

  if (stream && prevGray && armed && movedEnabled && !tamperSuspected) {
    if (!baselineHash && baselineAutoAt && (now - baselineAutoAt) >= BASELINE_WARMUP_MS) {
      baselineHash = dHash64(curGray, SMALL_W, SMALL_H);
      baselineSetAt = now;
      repositionReason = "BASELINE_AUTO_WARMUP";
    }
  }

  repositionSuspected = false;

  if (stream && prevGray && armed && movedEnabled && baselineHash && !tamperSuspected) {
    const curHash = dHash64(curGray, SMALL_W, SMALL_H);
    const dist = hamming64(baselineHash, curHash);
    lastHashDist = dist;

    if (dist >= movedThreshold) {
      if (movedStartAt === null) movedStartAt = now;
      if (now - movedStartAt >= movedHoldMs) {
        repositionSuspected = true;
        repositionReason = "MOVED";
      }
    } else {
      movedStartAt = null;
      repositionReason = "—";
    }
  } else {
    movedStartAt = null;
  }

  // ---- POLICY: decide what to LOG ----
  const canTrigger = (now - lastTriggeredAt) > cooldownMs;
  const persistentEnough = burstMs >= minBurstMs;

  const logMotionEnabled = Boolean(logMotionEnabledEl?.checked);
  const logMotionThreshold = Number(logMotionThresholdEl.value || 14);

  const highMotionReady =
    Boolean(armed && stream && prevGray && motionActive && persistentEnough && canTrigger && quietEnough && logMotionEnabled && ema >= logMotionThreshold);

  const tamperReady = Boolean(armed && stream && prevGray && tamperSuspected && canTrigger);
  const movedReady  = Boolean(armed && stream && prevGray && repositionSuspected && canTrigger);

  const state =
    !stream ? "NO_CAM" :
    !armed ? "DISARMED" :
    !prevGray ? "WARMUP" :
    tamperReady ? "TAMPER_READY" :
    movedReady ? "MOVED_READY" :
    highMotionReady ? "HIGH_MOTION_READY" :
    motionActive ? (persistentEnough ? "PERSISTENT" : "ACTIVE") :
    "IDLE";

  updateUI(rawPct, th, burstMs);
  updateDebug(rawPct, ema, th, stopTh, state, burstMs, fps);

  const baselineAge = baselineSetAt ? (now - baselineSetAt) : 0;
  movedReasonText.textContent =
    `policy: log(tamper=${tamperEnabled ? "on" : "off"}, moved=${movedEnabled ? "on" : "off"}, highMotion=${logMotionEnabled ? "on" : "off"}@${logMotionThreshold}%) ` +
    `| quietEnough=${quietEnough ? "YES" : "NO"}(${quietRearmMs}ms) ` +
    `| moved=${repositionSuspected ? "YES" : "NO"}(dist=${lastHashDist}, baseAge=${baselineAge}ms) ` +
    `| tamper=${tamperSuspected ? "YES" : "NO"}(${tamperReason})`;

  // ---- LOGGING (only the meaningful ones) ----
  if (tamperReady || movedReady || highMotionReady) {
    lastTriggeredAt = now;

    ctx.drawImage(remoteMode ? mjpegImg : video, 0, 0, canvas.width, canvas.height);
    const imageBase64 = canvas.toDataURL("image/jpeg", 0.72);

    let type = "MOTION";
    let severity = 60;
    let why = "HIGH_MOTION_POLICY";

    if (tamperReady) {
      type = "TAMPER";
      severity = 90;
      why = tamperReason;
    } else if (movedReady) {
      type = "MOVED";
      severity = 88;
      why = repositionReason;
    } else {
      // high motion only
      severity = Math.min(100, Math.max(60, Math.round(ema * 2)));
    }

    const meta = {
      why,
      policy: {
        logMotionEnabled,
        logMotionThreshold,
        quietRearmMs
      },

      // Motion signal always included for audit context
      motionScore: rawPct,
      motionEma: ema,
      threshold: th,
      stopTh,
      pixelDelta,
      graceMs,
      burstMs,

      // Tamper
      tamperSuspected,
      tamperReason,
      tamperStats: { mean, std, meanAbsDiff },
      tamperHoldMs,
      freezeHoldMs,

      // Reposition
      repositionSuspected,
      repositionReason,
      movedThreshold,
      movedHoldMs,
      hashDistance: lastHashDist,
      baselineSetAt,
      baselineAgeMs: baselineAge,

      w: canvas.width,
      h: canvas.height
    };

    postIncident({
      cameraId: getActiveCameraId(),
      type,
      severity,
      meta,
      imageBase64
    })
      .then(() => refreshIncidents())
      .catch((err) => {
        console.error(err);
        setError(err?.message || String(err));
        setStatus("error", "POST failed");
      });
  }

  prevGray = curGray;
  rafId = requestAnimationFrame(loop);
}

async function autoCalibrate() {
  try {
    setError("none");
    if (!stream) return alert("Start Camera first.");

    btnCalibrate.disabled = true;
    btnCalibrate.textContent = "Calibrating…";

    const pixelDelta = Number(pixelDeltaEl.value || 18);
    const samples = [];
    const start = performance.now();
    let last = null;

    while (performance.now() - start < 1800) {
      const cur = grabGraySmall();
      if (last) samples.push(motionPercent(last, cur, pixelDelta));
      last = cur;
      await new Promise((r) => setTimeout(r, 60));
    }

    const mean = samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);
    const varr = samples.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, samples.length);
    const std = Math.sqrt(varr);

    const th = Math.max(1, Math.min(30, mean + 4 * std));
    sensitivityEl.value = String(Math.round(th));

    alert(`Calibrated SIGNAL threshold to ~${th.toFixed(2)}% (noise mean ${mean.toFixed(2)}%, std ${std.toFixed(2)}%).\n\nNote: Logging is separately controlled by Log Motion Threshold.`);
  } catch (e) {
    console.error(e);
    setError(e?.message || String(e));
    alert("Calibration failed. Check Last Error.");
  } finally {
    btnCalibrate.disabled = false;
    btnCalibrate.textContent = "Auto-Calibrate";
  }
}

async function simulateIncident() {
  try {
    setError("none");
    if (!stream) return alert("Start Camera first.");
    if (!armed) return alert("Arm the system first.");

    ctx.drawImage(remoteMode ? mjpegImg : video, 0, 0, canvas.width, canvas.height);
    const imageBase64 = canvas.toDataURL("image/jpeg", 0.72);

    await postIncident({
      cameraId: getActiveCameraId(),
      type: "MOTION",
      severity: 25,
      meta: { simulated: true, note: "Operator forced test event", w: canvas.width, h: canvas.height },
      imageBase64
    });

    await refreshIncidents();
    alert("Simulated incident created. Pipeline is working.");
  } catch (e) {
    console.error(e);
    setError(e?.message || String(e));
    alert("Simulate failed. See Last Error.");
  }
}

// Controls
btnStart.addEventListener("click", startCamera);
btnStop.addEventListener("click", stopCamera);
btnRefresh.addEventListener("click", async () => {
  const orig = btnRefresh.textContent;
  btnRefresh.textContent = "Refreshing…";
  btnRefresh.disabled = true;
  await Promise.all([refreshIncidents(), checkHealth()]);
  btnRefresh.textContent = orig;
  btnRefresh.disabled = false;
});
btnArm.addEventListener("click", () => setArmed(true));
btnDisarm.addEventListener("click", () => setArmed(false));
btnCalibrate.addEventListener("click", autoCalibrate);
btnSimulate.addEventListener("click", simulateIncident);
btnSetBaseline.addEventListener("click", () => {
  if (!stream) return alert("Start Camera first.");
  setBaselineNow("MANUAL");
  alert("Baseline set. Current view is now considered normal.");
});

// Init
setArmed(false);
setStatus("idle", "Idle");
checkHealth();
refreshIncidents();

// Poll feed every 3 seconds — WebSocket handles real-time; this is just a fallback
setInterval(refreshIncidents, 3000);

// Re-check backend health every 10 seconds
setInterval(checkHealth, 10000);

// Populate camera list on load (may be blank labels until permission)
populateCameras();
