import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  collection, collectionGroup, query, where, orderBy, onSnapshot, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, SUPER_ADMIN_EMAIL, CURRENCY, WEEK_START } from "./config.js";

/* ---------------- helpers ---------------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = n => (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const todayStr = () => ymd(new Date());
const niceDate = s => parseYmd(s).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
const shortDate = s => parseYmd(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}
const busy = on => $("#busy").classList.toggle("hidden", !on);

function rangeFor(key, from, to) {
  const now = new Date(), t = ymd(now);
  switch (key) {
    case "today": return [t, t];
    case "week": {
      const s = new Date(now); s.setDate(now.getDate() - ((now.getDay() - WEEK_START + 7) % 7));
      const e = new Date(s); e.setDate(s.getDate() + 6);
      return [ymd(s), ymd(e)];
    }
    case "month": return [ymd(new Date(now.getFullYear(), now.getMonth(), 1)), ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0))];
    case "lastmonth": return [ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)), ymd(new Date(now.getFullYear(), now.getMonth(), 0))];
    case "year": return [`${now.getFullYear()}-01-01`, `${now.getFullYear()}-12-31`];
    case "custom": return [from || "0000-01-01", to || "9999-12-31"];
    default: return null; // all
  }
}
const inRange = (e, r) => !r || (e.date >= r[0] && e.date <= r[1]);
function sums(list) {
  let inc = 0, exp = 0;
  for (const e of list) { if (e.type === "income") inc += +e.amount || 0; else exp += +e.amount || 0; }
  return { inc, exp, net: inc - exp, count: list.length };
}
const rangeLabel = r => !r ? "All time" : (r[0] === r[1] ? shortDate(r[0]) : `${shortDate(r[0])} – ${shortDate(r[1])}`);

/* ---------------- firebase ---------------- */
const configured = !String(firebaseConfig.apiKey).startsWith("PASTE");
let app, auth, db;
if (configured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
}

const DEFAULT_HEADS = [
  ["income", "Cash received"], ["income", "Petty cash from office"], ["income", "Refund"], ["income", "Other income"],
  ["expense", "Fuel"], ["expense", "Food"], ["expense", "Transport / Taxi"], ["expense", "Materials"],
  ["expense", "Tools"], ["expense", "Parking / Salik"], ["expense", "Office supplies"], ["expense", "Other expense"]
];

/* ---------------- state ---------------- */
const S = {
  user: null, profile: null,
  viewUid: null, viewProfile: null,
  heads: [], entries: [],
  users: [], allEntries: [],
  range: "month", from: "", to: "",
  entryType: "expense", editing: null,
  newReceipts: [], oldReceipts: [], removedReceipts: [],
  subs: [], adminSubs: []
};
const isAdmin = () => S.profile?.role === "admin";
const clear = arr => { arr.forEach(u => { try { u(); } catch {} }); arr.length = 0; };

function show(screen) {
  ["setup", "login", "blocked", "app"].forEach(s => $(`#screen-${s}`).classList.toggle("hidden", s !== screen));
}
function blocked(title, text) {
  $("#blocked-title").textContent = title;
  $("#blocked-text").textContent = text;
  show("blocked");
}

/* ---------------- auth ---------------- */
if (!configured) show("setup");
else onAuthStateChanged(auth, async u => {
  clear(S.subs); clear(S.adminSubs);
  if (!u) { S.user = S.profile = null; show("login"); return; }
  busy(true);
  try {
    const ref = doc(db, "users", u.uid);
    let snap = await getDoc(ref);
    if (!snap.exists()) {
      if (u.email.toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase()) {
        await setDoc(ref, { name: u.displayName || "Admin", email: u.email, role: "admin", active: true, openingBalance: 0, createdAt: serverTimestamp() });
        await seedHeads(u.uid);
        snap = await getDoc(ref);
      } else { blocked("Account not set up", "Your login exists but no expense account is linked to it. Ask the admin to create your account."); return; }
    }
    const p = snap.data();
    if (p.active === false) { blocked("Account disabled", "Your account has been disabled by the admin."); return; }
    S.user = u; S.profile = { id: u.uid, ...p };
    $("#me-name").textContent = p.name || u.email;
    $$(".admin-only").forEach(el => el.classList.toggle("hidden", !isAdmin()));
    show("app");
    if (isAdmin()) startAdmin();
    switchAccount(u.uid);
  } catch (err) {
    console.error(err);
    blocked("Could not load your account", err.message);
  } finally { busy(false); }
});

$("#login-form").addEventListener("submit", async e => {
  e.preventDefault();
  const m = $("#login-msg"); m.className = "msg"; m.textContent = "Signing in…";
  try { await signInWithEmailAndPassword(auth, $("#login-email").value.trim(), $("#login-pass").value); m.textContent = ""; }
  catch (err) { m.className = "msg err"; m.textContent = friendly(err); }
});
$("#forgot-btn").addEventListener("click", async () => {
  const email = $("#login-email").value.trim(), m = $("#login-msg");
  if (!email) { m.className = "msg err"; m.textContent = "Type your email first."; return; }
  try { await sendPasswordResetEmail(auth, email); m.className = "msg ok"; m.textContent = "Reset link sent to " + email; }
  catch (err) { m.className = "msg err"; m.textContent = friendly(err); }
});
$("#logout-btn").addEventListener("click", () => signOut(auth));
$("#blocked-logout").addEventListener("click", () => signOut(auth));

function friendly(err) {
  const c = err.code || "";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found")) return "Wrong email or password.";
  if (c.includes("email-already-in-use")) return "That email already has a login.";
  if (c.includes("weak-password")) return "Password must be at least 6 characters.";
  if (c.includes("too-many-requests")) return "Too many attempts. Try again in a few minutes.";
  if (c.includes("permission-denied")) return "Permission denied — check the Firestore rules are published.";
  return err.message || String(err);
}

async function seedHeads(uid) {
  const b = writeBatch(db);
  DEFAULT_HEADS.forEach(([type, name]) => b.set(doc(collection(db, "users", uid, "heads")), { type, name, createdAt: serverTimestamp() }));
  await b.commit();
}

/* ---------------- account switching & live data ---------------- */
function switchAccount(uid) {
  clear(S.subs);
  S.viewUid = uid; S.heads = []; S.entries = [];
  const mine = uid === S.user.uid;
  $("#viewing-banner").classList.toggle("hidden", mine);
  S.subs.push(onSnapshot(doc(db, "users", uid), s => {
    S.viewProfile = { id: uid, ...s.data() };
    if (!mine) $("#viewing-name").textContent = S.viewProfile.name || S.viewProfile.email;
    $("#opening-input").value = S.viewProfile.openingBalance || 0;
    renderHome();
  }));
  S.subs.push(onSnapshot(query(collection(db, "users", uid, "heads"), orderBy("name")), s => {
    S.heads = s.docs.map(d => ({ id: d.id, ...d.data() }));
    renderHeads(); fillHeadFilters(); renderHome();
  }, err => toast(friendly(err))));
  S.subs.push(onSnapshot(query(collection(db, "users", uid, "entries"), orderBy("date", "desc")), s => {
    S.entries = s.docs.map(d => ({ id: d.id, uid, ...d.data() }));
    renderHome(); renderHeads(); renderReportPreview();
  }, err => toast(friendly(err))));
  fillReportScope();
}
$("#back-to-mine").addEventListener("click", () => switchAccount(S.user.uid));

/* ---------------- tabs ---------------- */
$$(".tabs button").forEach(b => b.addEventListener("click", () => {
  $$(".tabs button").forEach(x => x.classList.toggle("active", x === b));
  $$(".tab").forEach(t => t.classList.toggle("hidden", t.id !== "tab-" + b.dataset.tab));
  $("#fab").classList.toggle("hidden", b.dataset.tab !== "home");
  if (b.dataset.tab === "reports") renderReportPreview();
}));

/* ---------------- home ---------------- */
$$("#range-chips button").forEach(b => b.addEventListener("click", () => {
  $$("#range-chips button").forEach(x => x.classList.toggle("active", x === b));
  S.range = b.dataset.range;
  $("#custom-range").style.display = S.range === "custom" ? "flex" : "none";
  if (S.range === "custom" && !$("#from-date").value) { $("#from-date").value = rangeFor("month")[0]; $("#to-date").value = todayStr(); }
  renderHome();
}));
["#from-date", "#to-date"].forEach(s => $(s).addEventListener("change", renderHome));
["#f-type", "#f-head"].forEach(s => $(s).addEventListener("change", renderHome));
$("#f-search").addEventListener("input", () => { clearTimeout(renderHome._t); renderHome._t = setTimeout(renderHome, 150); });

function fillHeadFilters() {
  const cur = $("#f-head").value;
  const names = [...new Set(S.heads.map(h => h.name))].sort();
  $("#f-head").innerHTML = `<option value="">All heads</option>` + names.map(n => `<option>${esc(n)}</option>`).join("");
  $("#f-head").value = names.includes(cur) ? cur : "";
}

function renderHome() {
  if (!S.viewUid) return;
  const E = S.entries;
  const opening = +(S.viewProfile?.openingBalance || 0);
  const all = sums(E);
  const bal = opening + all.net;
  $("#bal-total").textContent = `${CURRENCY} ${money(bal)}`;
  $("#bal-total").classList.toggle("neg", bal < 0);
  $("#bal-sub").textContent = `Total in ${money(all.inc)} · Total out ${money(all.exp)}` + (opening ? ` · Opening ${money(opening)}` : "");

  $("#period-grid").innerHTML = [["Today", "today"], ["This week", "week"], ["This month", "month"], ["This year", "year"]].map(([t, k]) => {
    const s = sums(E.filter(e => inRange(e, rangeFor(k))));
    return `<div class="pcard"><div class="t">${t}</div>
      <div class="l"><span>In</span><span class="inc">${money(s.inc)}</span></div>
      <div class="l"><span>Out</span><span class="exp">${money(s.exp)}</span></div>
      <div class="l net"><span>Net</span><span class="${s.net < 0 ? "exp" : "inc"}">${money(s.net)}</span></div></div>`;
  }).join("");

  const r = rangeFor(S.range, $("#from-date").value, $("#to-date").value);
  const inR = E.filter(e => inRange(e, r));
  const rs = sums(inR);
  $("#range-totals").innerHTML = `
    <div class="rt"><div class="k">Income</div><div class="v inc">${money(rs.inc)}</div></div>
    <div class="rt"><div class="k">Expense</div><div class="v exp">${money(rs.exp)}</div></div>
    <div class="rt"><div class="k">Net</div><div class="v ${rs.net < 0 ? "exp" : "inc"}">${money(rs.net)}</div></div>
    <div class="rt"><div class="k">Entries · ${esc(rangeLabel(r))}</div><div class="v">${rs.count}</div></div>`;

  // head breakdown
  let html = "";
  for (const type of ["income", "expense"]) {
    const m = new Map();
    inR.filter(e => e.type === type).forEach(e => m.set(e.headName || "—", (m.get(e.headName || "—") || 0) + (+e.amount || 0)));
    if (!m.size) continue;
    const rows = [...m].sort((a, b) => b[1] - a[1]); const max = rows[0][1] || 1;
    html += `<div class="grp">${type === "income" ? "Income" : "Expense"}</div>` + rows.map(([n, v]) =>
      `<div class="bh"><span>${esc(n)}</span><b class="${type === "income" ? "inc" : "exp"}">${money(v)}</b>
       <div class="bar"><span style="width:${(v / max * 100).toFixed(1)}%;background:var(--${type === "income" ? "inc" : "exp"})"></span></div></div>`).join("");
  }
  $("#head-breakdown").innerHTML = html || `<div class="empty">No entries in this period.</div>`;

  // entry list
  const ft = $("#f-type").value, fh = $("#f-head").value, q = $("#f-search").value.trim().toLowerCase();
  const list = inR.filter(e => (!ft || e.type === ft) && (!fh || e.headName === fh) &&
    (!q || [e.headName, e.note, e.ref, e.mode, String(e.amount)].join(" ").toLowerCase().includes(q)));
  if (!list.length) { $("#entry-list").innerHTML = `<div class="empty">No entries. Tap + to add one.</div>`; return; }
  const LIMIT = renderHome.limit || 300;
  let out = "", lastDay = null;
  const dayNet = {};
  list.forEach(e => { dayNet[e.date] = (dayNet[e.date] || 0) + (e.type === "income" ? 1 : -1) * (+e.amount || 0); });
  list.slice(0, LIMIT).forEach(e => {
    if (e.date !== lastDay) { lastDay = e.date; out += `<div class="day-h"><span>${niceDate(e.date)}</span><span>${money(dayNet[e.date])}</span></div>`; }
    const inc = e.type === "income";
    out += `<div class="entry" data-id="${e.id}">
      <div class="dot ${inc ? "inc" : "exp"}">${inc ? "↓" : "↑"}</div>
      <div><div class="h">${esc(e.headName || "—")}</div><div class="n">${esc(e.note || e.mode || "")}${e.receiptCount ? ` · 📎${e.receiptCount}` : ""}</div></div>
      <div class="a ${inc ? "inc" : "exp"}">${inc ? "+" : "−"}${money(e.amount)}<small>${esc(e.mode || "")}</small></div></div>`;
  });
  if (list.length > LIMIT) out += `<div class="empty"><button class="btn small" id="more-btn">Show more (${list.length - LIMIT})</button></div>`;
  $("#entry-list").innerHTML = out;
  $("#more-btn")?.addEventListener("click", () => { renderHome.limit = LIMIT + 300; renderHome(); });
}
$("#entry-list").addEventListener("click", e => {
  const row = e.target.closest(".entry"); if (!row) return;
  openEntry(S.entries.find(x => x.id === row.dataset.id));
});

/* ---------------- entry modal ---------------- */
$("#fab").addEventListener("click", () => openEntry());
$("#add-btn-top").addEventListener("click", () => openEntry());
$$(".modal").forEach(m => m.addEventListener("click", e => {
  if (e.target === m || e.target.closest("[data-close]")) m.classList.add("hidden");
}));

function setEntryType(t, keepHead) {
  S.entryType = t;
  $$("#entry-type button").forEach(b => b.classList.toggle("active", b.dataset.type === t));
  const heads = S.heads.filter(h => h.type === t);
  let opts = heads.map(h => `<option value="${h.id}">${esc(h.name)}</option>`).join("");
  if (keepHead && keepHead.headId && !heads.some(h => h.id === keepHead.headId))
    opts = `<option value="${keepHead.headId}" data-name="${esc(keepHead.headName)}">${esc(keepHead.headName)} (removed)</option>` + opts;
  $("#e-head").innerHTML = opts || `<option value="">— add a head first —</option>`;
  if (keepHead?.headId) $("#e-head").value = keepHead.headId;
}
$$("#entry-type button").forEach(b => b.addEventListener("click", () => setEntryType(b.dataset.type)));

async function openEntry(entry) {
  S.editing = entry || null; S.newReceipts = []; S.oldReceipts = []; S.removedReceipts = [];
  $("#entry-title").textContent = entry ? "Edit entry" : "Add entry";
  $("#e-delete").classList.toggle("hidden", !entry);
  setEntryType(entry?.type || S.entryType || "expense", entry);
  $("#e-amount").value = entry?.amount ?? "";
  $("#e-date").value = entry?.date || todayStr();
  $("#e-mode").value = entry?.mode || "Cash";
  $("#e-note").value = entry?.note || "";
  $("#e-ref").value = entry?.ref || "";
  $("#e-meta").textContent = entry ? metaLine(entry) : "";
  renderThumbs();
  $("#entry-modal").classList.remove("hidden");
  if (!entry) setTimeout(() => $("#e-amount").focus(), 50);
  if (entry?.receiptCount) {
    const s = await getDocs(query(collection(db, "users", S.viewUid, "receipts"), where("entryId", "==", entry.id)));
    if (S.editing?.id !== entry.id) return;
    S.oldReceipts = s.docs.map(d => ({ id: d.id, ...d.data() }));
    renderThumbs();
  }
}
function metaLine(e) {
  const f = ts => ts?.toDate ? ts.toDate().toLocaleString("en-GB") : "";
  let s = `Added ${f(e.createdAt)}${e.createdBy ? " by " + e.createdBy : ""}`;
  if (e.updatedAt && e.editCount) s += ` · Edited ${e.editCount}× · last ${f(e.updatedAt)}${e.updatedBy ? " by " + e.updatedBy : ""}`;
  return s;
}

function renderThumbs() {
  const items = [
    ...S.oldReceipts.filter(r => !S.removedReceipts.includes(r.id)).map(r => ({ ...r, kind: "old" })),
    ...S.newReceipts.map((r, i) => ({ ...r, kind: "new", idx: i }))
  ];
  $("#e-receipts").innerHTML = items.length ? items.map(r => `
    <div class="thumb" data-kind="${r.kind}" data-key="${r.kind === "old" ? r.id : r.idx}">
      ${r.mime.startsWith("image/") ? `<img src="${r.data}" alt="">` : `📄<br>${esc(r.name).slice(0, 18)}`}
      <button type="button" class="x" title="Remove">✕</button></div>`).join("")
    : `<span class="muted small">No receipts attached.</span>`;
}
$("#e-receipts").addEventListener("click", e => {
  const t = e.target.closest(".thumb"); if (!t) return;
  const { kind, key } = t.dataset;
  if (e.target.classList.contains("x")) {
    if (kind === "old") S.removedReceipts.push(key); else S.newReceipts.splice(+key, 1);
    renderThumbs(); return;
  }
  const r = kind === "old" ? S.oldReceipts.find(x => x.id === key) : S.newReceipts[+key];
  viewReceipt(r);
});

function viewReceipt(r) {
  $("#viewer-name").textContent = r.name;
  const a = $("#viewer-dl"); a.href = r.data; a.download = r.name;
  if (r.mime.startsWith("image/")) $("#viewer-body").innerHTML = `<img src="${r.data}" alt="">`;
  else {
    const blob = dataUrlToBlob(r.data);
    $("#viewer-body").innerHTML = `<iframe src="${URL.createObjectURL(blob)}"></iframe>`;
  }
  $("#viewer").classList.remove("hidden");
}
function dataUrlToBlob(d) {
  const [h, b64] = d.split(","); const mime = h.match(/:(.*?);/)[1];
  const bin = atob(b64); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

$("#e-files").addEventListener("change", async e => {
  const files = [...e.target.files]; e.target.value = "";
  busy(true);
  for (const f of files) {
    try { S.newReceipts.push(await fileToReceipt(f)); }
    catch (err) { toast(`${f.name}: ${err.message}`, 4000); }
  }
  busy(false); renderThumbs();
});

const readDataUrl = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("Can't read this image format")); i.src = src; });

// Receipts are stored inside Firestore (works on the free Spark plan). Images are compressed to stay under the 1 MB document limit.
async function fileToReceipt(file) {
  if (file.type === "application/pdf") {
    if (file.size > 650 * 1024) throw new Error("PDF is larger than 650 KB — take a photo of it instead");
    return { name: file.name, mime: file.type, data: await readDataUrl(file) };
  }
  if (!file.type.startsWith("image/")) throw new Error("Only images and PDFs are allowed");
  const url = URL.createObjectURL(file);
  const img = await loadImg(url); URL.revokeObjectURL(url);
  let max = 1600, q = 0.78, data = "";
  for (let i = 0; i < 8; i++) {
    const sc = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
    const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    data = c.toDataURL("image/jpeg", q);
    if (data.length < 850000) break;
    max = Math.round(max * 0.8); q = Math.max(0.45, q - 0.07);
  }
  return { name: file.name.replace(/\.[^.]+$/, "") + ".jpg", mime: "image/jpeg", data };
}

$("#entry-form").addEventListener("submit", async e => {
  e.preventDefault();
  const amount = Math.round(parseFloat($("#e-amount").value) * 100) / 100;
  const headSel = $("#e-head");
  if (!headSel.value) { toast("Add an account head first (Account heads tab)"); return; }
  if (!(amount > 0)) { toast("Enter an amount"); return; }
  const opt = headSel.selectedOptions[0];
  const headName = opt.dataset.name || S.heads.find(h => h.id === headSel.value)?.name || opt.textContent;
  const uid = S.viewUid, who = S.user.email;
  const ed = S.editing;
  const ref = ed ? doc(db, "users", uid, "entries", ed.id) : doc(collection(db, "users", uid, "entries"));
  const keptOld = S.oldReceipts.filter(r => !S.removedReceipts.includes(r.id)).length;
  const data = {
    type: S.entryType, amount, date: $("#e-date").value,
    headId: headSel.value, headName,
    mode: $("#e-mode").value, note: $("#e-note").value.trim(), ref: $("#e-ref").value.trim(),
    receiptCount: (ed ? keptOld : 0) + S.newReceipts.length,
    updatedAt: serverTimestamp(), updatedBy: who
  };
  if (ed) data.editCount = (ed.editCount || 0) + 1;
  else Object.assign(data, { createdAt: serverTimestamp(), createdBy: who, editCount: 0 });
  busy(true);
  try {
    for (const r of S.newReceipts)
      await addDoc(collection(db, "users", uid, "receipts"), { entryId: ref.id, name: r.name, mime: r.mime, data: r.data, createdAt: serverTimestamp(), createdBy: who });
    for (const id of S.removedReceipts) await deleteDoc(doc(db, "users", uid, "receipts", id));
    await setDoc(ref, data, { merge: true });
    $("#entry-modal").classList.add("hidden");
    toast(ed ? "Entry updated" : "Entry saved");
  } catch (err) { console.error(err); toast(friendly(err), 5000); }
  finally { busy(false); }
});

$("#e-delete").addEventListener("click", async () => {
  const ed = S.editing; if (!ed) return;
  if (!confirm(`Delete this ${ed.type} of ${money(ed.amount)}? This cannot be undone.`)) return;
  busy(true);
  try {
    const s = await getDocs(query(collection(db, "users", S.viewUid, "receipts"), where("entryId", "==", ed.id)));
    const b = writeBatch(db);
    s.docs.forEach(d => b.delete(d.ref));
    b.delete(doc(db, "users", S.viewUid, "entries", ed.id));
    await b.commit();
    $("#entry-modal").classList.add("hidden"); toast("Entry deleted");
  } catch (err) { toast(friendly(err)); }
  finally { busy(false); }
});

/* ---------------- heads ---------------- */
function renderHeads() {
  for (const type of ["income", "expense"]) {
    const list = S.heads.filter(h => h.type === type);
    $(`#heads-${type}`).innerHTML = list.length ? list.map(h => {
      const used = S.entries.filter(e => e.headId === h.id).length;
      return `<div class="head-item" data-id="${h.id}"><input value="${esc(h.name)}" data-old="${esc(h.name)}">
        <span class="muted small" style="margin-right:8px">${used}</span><button class="icon-btn del" title="Delete">🗑</button></div>`;
    }).join("") : `<div class="empty">None yet</div>`;
  }
}
$("#head-form").addEventListener("submit", async e => {
  e.preventDefault();
  const name = $("#head-name").value.trim(), type = $("#head-type").value;
  if (!name) return;
  if (S.heads.some(h => h.type === type && h.name.toLowerCase() === name.toLowerCase())) { toast("That head already exists"); return; }
  try { await addDoc(collection(db, "users", S.viewUid, "heads"), { name, type, createdAt: serverTimestamp() }); $("#head-name").value = ""; toast("Head added"); }
  catch (err) { toast(friendly(err)); }
});
["#heads-income", "#heads-expense"].forEach(sel => {
  $(sel).addEventListener("change", async e => {
    if (e.target.tagName !== "INPUT") return;
    const id = e.target.closest(".head-item").dataset.id, name = e.target.value.trim();
    if (!name) { e.target.value = e.target.dataset.old; return; }
    busy(true);
    try {
      const b = writeBatch(db);
      b.update(doc(db, "users", S.viewUid, "heads", id), { name });
      S.entries.filter(x => x.headId === id).forEach(x => b.update(doc(db, "users", S.viewUid, "entries", x.id), { headName: name }));
      await b.commit(); toast("Head renamed");
    } catch (err) { toast(friendly(err)); } finally { busy(false); }
  });
  $(sel).addEventListener("click", async e => {
    if (!e.target.classList.contains("del")) return;
    const id = e.target.closest(".head-item").dataset.id;
    const h = S.heads.find(x => x.id === id);
    const used = S.entries.filter(x => x.headId === id).length;
    if (!confirm(`Delete head "${h.name}"?` + (used ? `\n${used} entries keep the name "${h.name}".` : ""))) return;
    try { await deleteDoc(doc(db, "users", S.viewUid, "heads", id)); toast("Head deleted"); } catch (err) { toast(friendly(err)); }
  });
});
$("#opening-form").addEventListener("submit", async e => {
  e.preventDefault();
  try { await updateDoc(doc(db, "users", S.viewUid), { openingBalance: parseFloat($("#opening-input").value) || 0 }); toast("Opening balance saved"); }
  catch (err) { toast(friendly(err)); }
});

/* ---------------- admin: users ---------------- */
function startAdmin() {
  S.adminSubs.push(onSnapshot(query(collection(db, "users"), orderBy("name")), s => {
    S.users = s.docs.map(d => ({ id: d.id, ...d.data() }));
    renderUsers(); fillReportScope();
  }, err => toast(friendly(err))));
  S.adminSubs.push(onSnapshot(collectionGroup(db, "entries"), s => {
    S.allEntries = s.docs.map(d => ({ id: d.id, uid: d.ref.parent.parent.id, ...d.data() }));
    renderUsers(); renderReportPreview();
  }, err => console.warn("all-entries", err)));
}

function renderUsers() {
  const month = rangeFor("month");
  let tIn = 0, tOut = 0, tBal = 0;
  $("#users-table tbody").innerHTML = S.users.map(u => {
    const E = S.allEntries.filter(e => e.uid === u.id);
    const m = sums(E.filter(e => inRange(e, month))), a = sums(E);
    const bal = (+u.openingBalance || 0) + a.net;
    tIn += m.inc; tOut += m.exp; tBal += bal;
    return `<tr data-id="${u.id}"><td><b>${esc(u.name)}</b><br><span class="muted small">${esc(u.email)}</span></td>
      <td>${u.role === "admin" ? "Admin" : "User"}</td>
      <td class="num inc">${money(m.inc)}</td><td class="num exp">${money(m.exp)}</td>
      <td class="num"><b class="${bal < 0 ? "exp" : ""}">${money(bal)}</b></td>
      <td><span class="tag ${u.active === false ? "off" : "on"}">${u.active === false ? "Disabled" : "Active"}</span></td>
      <td><button class="btn small open">Open</button> <button class="btn small edit">Edit</button></td></tr>`;
  }).join("") + `<tr><td><b>Total</b></td><td></td><td class="num inc"><b>${money(tIn)}</b></td><td class="num exp"><b>${money(tOut)}</b></td><td class="num"><b>${money(tBal)}</b></td><td></td><td></td></tr>`;
  $("#users-total").textContent = `${S.users.length} users`;
}
$("#users-table").addEventListener("click", e => {
  const tr = e.target.closest("tr[data-id]"); if (!tr) return;
  const id = tr.dataset.id;
  if (e.target.classList.contains("open")) {
    switchAccount(id);
    $('.tabs button[data-tab="home"]').click();
    window.scrollTo(0, 0);
  } else if (e.target.classList.contains("edit")) openUserEdit(id);
});

$("#user-form").addEventListener("submit", async e => {
  e.preventDefault();
  const m = $("#user-msg"); m.className = "msg"; m.textContent = "Creating…";
  const name = $("#u-name").value.trim(), email = $("#u-email").value.trim().toLowerCase(), pass = $("#u-pass").value;
  busy(true);
  let sec;
  try {
    // A second Firebase app instance creates the login without signing the admin out.
    sec = initializeApp(firebaseConfig, "creator-" + Date.now());
    const secAuth = getAuth(sec);
    const cred = await createUserWithEmailAndPassword(secAuth, email, pass);
    await signOut(secAuth);
    const uid = cred.user.uid;
    await setDoc(doc(db, "users", uid), {
      name, email, role: $("#u-role").value, active: true,
      openingBalance: parseFloat($("#u-opening").value) || 0,
      createdAt: serverTimestamp(), createdBy: S.user.email
    });
    await seedHeads(uid);
    m.className = "msg ok"; m.textContent = `Created ${name}. Login: ${email} / the password you set.`;
    e.target.reset(); $("#u-opening").value = 0;
  } catch (err) { m.className = "msg err"; m.textContent = friendly(err); }
  finally { if (sec) deleteApp(sec).catch(() => {}); busy(false); }
});

let editingUser = null;
function openUserEdit(id) {
  const u = S.users.find(x => x.id === id); editingUser = u;
  $("#ue-name").value = u.name || ""; $("#ue-role").value = u.role || "user";
  $("#ue-opening").value = u.openingBalance || 0; $("#ue-active").value = String(u.active !== false);
  $("#ue-email").textContent = u.email;
  $("#user-modal").classList.remove("hidden");
}
$("#user-edit-form").addEventListener("submit", async e => {
  e.preventDefault();
  const u = editingUser, self = u.id === S.user.uid;
  const upd = { name: $("#ue-name").value.trim(), role: $("#ue-role").value, openingBalance: parseFloat($("#ue-opening").value) || 0, active: $("#ue-active").value === "true" };
  if (self && (upd.role !== "admin" || !upd.active)) { toast("You can't remove your own admin access"); return; }
  try { await updateDoc(doc(db, "users", u.id), upd); $("#user-modal").classList.add("hidden"); toast("User updated"); }
  catch (err) { toast(friendly(err)); }
});
$("#ue-reset").addEventListener("click", async () => {
  try { await sendPasswordResetEmail(auth, editingUser.email); toast("Reset email sent to " + editingUser.email); }
  catch (err) { toast(friendly(err)); }
});

/* ---------------- reports ---------------- */
function fillReportScope() {
  const sel = $("#r-scope"); const cur = sel.value;
  if (!isAdmin()) { sel.innerHTML = ""; return; }
  sel.innerHTML = `<option value="__view">Account on screen</option><option value="__all">All users (combined)</option>` +
    S.users.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join("");
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : "__view";
}
$("#r-range").addEventListener("change", () => {
  $$(".r-custom").forEach(el => el.classList.toggle("hidden", $("#r-range").value !== "custom"));
  if ($("#r-range").value === "custom" && !$("#r-from").value) { $("#r-from").value = rangeFor("month")[0]; $("#r-to").value = todayStr(); }
  renderReportPreview();
});
["#r-scope", "#r-from", "#r-to", "#r-type", "#r-head"].forEach(s => $(s).addEventListener("change", renderReportPreview));

function reportData() {
  const scope = isAdmin() ? $("#r-scope").value : "__view";
  let base, opening, title;
  if (scope === "__all") {
    base = S.allEntries; opening = S.users.reduce((a, u) => a + (+u.openingBalance || 0), 0); title = "All users";
  } else {
    const uid = scope === "__view" ? S.viewUid : scope;
    base = uid === S.viewUid ? S.entries : S.allEntries.filter(e => e.uid === uid);
    const prof = uid === S.viewUid ? S.viewProfile : S.users.find(u => u.id === uid);
    opening = +(prof?.openingBalance || 0); title = prof?.name || prof?.email || "";
  }
  const r = rangeFor($("#r-range").value, $("#r-from").value, $("#r-to").value);
  const type = $("#r-type").value, head = $("#r-head").value;
  const rows = base.filter(e => inRange(e, r) && (!type || e.type === type) && (!head || e.headName === head))
    .sort((a, b) => a.date.localeCompare(b.date) || ((a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0)));
  const before = r ? base.filter(e => e.date < r[0]) : [];
  const bf = opening + sums(before).net;
  const s = sums(rows);
  const heads = [...new Set(base.map(e => e.headName).filter(Boolean))].sort();
  return { scope, base, rows, r, s, bf, closing: bf + sums(base.filter(e => inRange(e, r))).net, title, type, head, heads, filtered: !!(type || head) };
}

function renderReportPreview() {
  if (!S.viewUid) return;
  const d = reportData();
  const hs = $("#r-head"), cur = hs.value;
  hs.innerHTML = `<option value="">All heads</option>` + d.heads.map(h => `<option>${esc(h)}</option>`).join("");
  hs.value = d.heads.includes(cur) ? cur : "";
  $("#r-preview").innerHTML = `
    <div class="rt"><div class="k">Opening (b/f)</div><div class="v">${money(d.bf)}</div></div>
    <div class="rt"><div class="k">Income</div><div class="v inc">${money(d.s.inc)}</div></div>
    <div class="rt"><div class="k">Expense</div><div class="v exp">${money(d.s.exp)}</div></div>
    <div class="rt"><div class="k">Closing balance</div><div class="v">${money(d.closing)}</div></div>`;
}

const userName = uid => S.users.find(u => u.id === uid)?.name || (uid === S.viewUid ? S.viewProfile?.name : "") || uid;
function buildTables(d) {
  const all = d.scope === "__all";
  const showRun = !d.filtered && !all;
  let run = d.bf;
  const entryHead = ["Date", ...(all ? ["User"] : []), "Head", "Description", "Ref", "Mode", "Income", "Expense", ...(showRun ? ["Balance"] : []), "Receipts"];
  const entryRows = d.rows.map(e => {
    const inc = e.type === "income" ? +e.amount : 0, exp = e.type === "expense" ? +e.amount : 0;
    run += inc - exp;
    return [e.date, ...(all ? [userName(e.uid)] : []), e.headName || "", e.note || "", e.ref || "", e.mode || "",
      inc || "", exp || "", ...(showRun ? [Math.round(run * 100) / 100] : []), e.receiptCount || 0];
  });
  const hm = new Map();
  d.rows.forEach(e => { const k = `${e.type}|${e.headName || "—"}`; hm.set(k, (hm.get(k) || 0) + +e.amount); });
  const headRows = [...hm].sort().map(([k, v]) => { const [t, n] = k.split("|"); return [t === "income" ? "Income" : "Expense", n, Math.round(v * 100) / 100]; });
  const dm = new Map();
  d.rows.forEach(e => { const o = dm.get(e.date) || { i: 0, x: 0 }; e.type === "income" ? o.i += +e.amount : o.x += +e.amount; dm.set(e.date, o); });
  const dayRows = [...dm].sort().map(([k, o]) => [k, round2(o.i), round2(o.x), round2(o.i - o.x)]);
  let userRows = null;
  if (all) {
    userRows = S.users.map(u => {
      const E = d.base.filter(e => e.uid === u.id);
      const p = sums(d.rows.filter(e => e.uid === u.id));
      const bal = (+u.openingBalance || 0) + sums(E).net;
      return [u.name, u.email, round2(p.inc), round2(p.exp), round2(p.net), round2(bal)];
    });
  }
  return { entryHead, entryRows, headRows, dayRows, userRows };
}
const round2 = n => Math.round(n * 100) / 100;
const fileBase = d => `Expense_${(d.title || "report").replace(/[^\w]+/g, "_")}_${d.r ? d.r[0] + "_to_" + d.r[1] : "all"}`;

$("#dl-xlsx").addEventListener("click", () => {
  if (!window.XLSX) { toast("Excel library not loaded — check internet"); return; }
  const d = reportData(), t = buildTables(d), wb = XLSX.utils.book_new();
  const summary = [
    ["LLCT Expense report"], ["Account", d.title], ["Period", rangeLabel(d.r)],
    ["Filter", [d.type && (d.type === "income" ? "Income only" : "Expense only"), d.head].filter(Boolean).join(" · ") || "None"],
    ["Generated", new Date().toLocaleString("en-GB") + " by " + S.user.email], [],
    [`Opening balance (b/f) ${CURRENCY}`, round2(d.bf)], ["Income", round2(d.s.inc)], ["Expense", round2(d.s.exp)],
    ["Net", round2(d.s.net)], [`Closing balance ${CURRENCY}`, round2(d.closing)], ["Entries", d.s.count]
  ];
  XLSX.utils.book_append_sheet(wb, sheet(summary, [28, 40]), "Summary");
  XLSX.utils.book_append_sheet(wb, sheet([t.entryHead, ...t.entryRows, [], totalRow(t.entryHead, d)], t.entryHead.map(h => ({ Description: 34, Head: 22, User: 20 }[h] || 13))), "Entries");
  XLSX.utils.book_append_sheet(wb, sheet([["Type", "Head", "Total"], ...t.headRows], [12, 28, 14]), "By head");
  XLSX.utils.book_append_sheet(wb, sheet([["Date", "Income", "Expense", "Net"], ...t.dayRows], [13, 13, 13, 13]), "Daily");
  if (t.userRows) XLSX.utils.book_append_sheet(wb, sheet([["User", "Email", "Income (period)", "Expense (period)", "Net (period)", "Current balance"], ...t.userRows], [22, 28, 16, 16, 14, 16]), "By user");
  XLSX.writeFile(wb, fileBase(d) + ".xlsx");
});
function sheet(aoa, widths) { const ws = XLSX.utils.aoa_to_sheet(aoa); ws["!cols"] = widths.map(w => ({ wch: w })); return ws; }
function totalRow(head, d) {
  return head.map(h => h === "Date" ? "TOTAL" : h === "Income" ? round2(d.s.inc) : h === "Expense" ? round2(d.s.exp) : "");
}

$("#dl-csv").addEventListener("click", () => {
  const d = reportData(), t = buildTables(d);
  const csv = [t.entryHead, ...t.entryRows, totalRow(t.entryHead, d)]
    .map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
  a.download = fileBase(d) + ".csv"; a.click();
});

$("#dl-pdf").addEventListener("click", () => {
  if (!window.jspdf) { toast("PDF library not loaded — check internet"); return; }
  const d = reportData(), t = buildTables(d);
  const pdf = new window.jspdf.jsPDF({ orientation: t.entryHead.length > 9 ? "landscape" : "portrait", unit: "pt", format: "a4" });
  const W = pdf.internal.pageSize.getWidth(), orange = [232, 100, 30], dark = [43, 47, 51];
  pdf.setFillColor(...dark); pdf.rect(0, 0, W, 56, "F");
  pdf.setFillColor(...orange); pdf.roundedRect(28, 14, 28, 28, 5, 5, "F");
  pdf.setTextColor(255); pdf.setFont("helvetica", "bold"); pdf.setFontSize(11); pdf.text("LL", 34, 32);
  pdf.setFontSize(15); pdf.text("LLCT Expense report", 66, 33);
  pdf.setFont("helvetica", "normal"); pdf.setFontSize(9); pdf.text(new Date().toLocaleString("en-GB"), W - 28, 33, { align: "right" });
  pdf.setTextColor(30); pdf.setFontSize(10);
  pdf.text(`Account: ${d.title}`, 28, 78); pdf.text(`Period: ${rangeLabel(d.r)}`, 28, 93);
  if (d.filtered) pdf.text(`Filter: ${[d.type, d.head].filter(Boolean).join(" · ")}`, 28, 108);
  pdf.autoTable({
    startY: d.filtered ? 118 : 104, theme: "grid", styles: { fontSize: 9 }, headStyles: { fillColor: orange },
    head: [["Opening (b/f)", "Income", "Expense", "Net", "Closing balance"]],
    body: [[money(d.bf), money(d.s.inc), money(d.s.exp), money(d.s.net), money(d.closing)]]
  });
  if (t.userRows) pdf.autoTable({
    startY: pdf.lastAutoTable.finalY + 14, theme: "striped", styles: { fontSize: 8.5 }, headStyles: { fillColor: dark },
    head: [["User", "Income", "Expense", "Net", "Current balance"]],
    body: t.userRows.map(r => [r[0], money(r[2]), money(r[3]), money(r[4]), money(r[5])])
  });
  if (t.headRows.length) pdf.autoTable({
    startY: pdf.lastAutoTable.finalY + 14, theme: "striped", styles: { fontSize: 8.5 }, headStyles: { fillColor: dark },
    head: [["Type", "Account head", "Total"]], body: t.headRows.map(r => [r[0], r[1], money(r[2])]),
    columnStyles: { 2: { halign: "right" } }
  });
  const numCols = {}; t.entryHead.forEach((h, i) => { if (["Income", "Expense", "Balance"].includes(h)) numCols[i] = { halign: "right" }; });
  pdf.autoTable({
    startY: pdf.lastAutoTable.finalY + 14, theme: "grid", styles: { fontSize: 8, cellPadding: 3 }, headStyles: { fillColor: orange },
    head: [t.entryHead],
    body: t.entryRows.map(r => r.map((v, i) => numCols[i] && v !== "" ? money(v) : v)),
    foot: [totalRow(t.entryHead, d).map((v, i) => numCols[i] && v !== "" ? money(v) : v)],
    footStyles: { fillColor: [240, 240, 240], textColor: 20 }, columnStyles: numCols, showFoot: "lastPage"
  });
  const pages = pdf.getNumberOfPages();
  for (let i = 1; i <= pages; i++) { pdf.setPage(i); pdf.setFontSize(8); pdf.setTextColor(120); pdf.text(`Page ${i} of ${pages}`, W - 28, pdf.internal.pageSize.getHeight() - 16, { align: "right" }); }
  pdf.save(fileBase(d) + ".pdf");
});

/* ---------------- PWA ---------------- */
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
