import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword, sendPasswordResetEmail, updatePassword, reauthenticateWithCredential, EmailAuthProvider
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  collection, collectionGroup, query, where, orderBy, onSnapshot, writeBatch, serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app-check.js";
import { firebaseConfig, SUPER_ADMIN_EMAIL, DEFAULT_CURRENCY, WEEK_START, RECAPTCHA_KEY, AI_MODELS } from "./config.js";

/* ---------------- helpers ---------------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Currencies: code → symbol shown on screen (PDF uses the code) and number grouping style
const CURRENCIES = {
  INR: { sym: "₹", name: "Indian Rupee", loc: "en-IN" }, AED: { sym: "AED", name: "UAE Dirham" }, USD: { sym: "$", name: "US Dollar" },
  EUR: { sym: "€", name: "Euro" }, GBP: { sym: "£", name: "British Pound" }, SAR: { sym: "SAR", name: "Saudi Riyal" },
  QAR: { sym: "QAR", name: "Qatari Riyal" }, OMR: { sym: "OMR", name: "Omani Rial" }, KWD: { sym: "KWD", name: "Kuwaiti Dinar" },
  BHD: { sym: "BHD", name: "Bahraini Dinar" }, PKR: { sym: "PKR", name: "Pakistani Rupee" }, LKR: { sym: "LKR", name: "Sri Lankan Rupee" },
  BDT: { sym: "৳", name: "Bangladeshi Taka" }, NPR: { sym: "NPR", name: "Nepalese Rupee" }, PHP: { sym: "₱", name: "Philippine Peso" }
};
let CUR = DEFAULT_CURRENCY; // currency of the account on screen
const curInfo = c => CURRENCIES[c] || { sym: c, loc: "en-US" };
const money = (n, c = CUR) => (Number(n) || 0).toLocaleString(curInfo(c).loc || "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sym = (c = CUR) => curInfo(c).sym;
const curOptions = () => Object.entries(CURRENCIES).map(([k, v]) => `<option value="${k}">${k} – ${v.name}</option>`).join("");
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
const busy = (on, msg = "") => { $("#busy").classList.toggle("hidden", !on); $("#busy-msg").textContent = msg; };

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
  // App Check proves requests come from this website (required for the bill-reading AI).
  try { initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(RECAPTCHA_KEY), isTokenAutoRefreshEnabled: true }); }
  catch (err) { console.warn("App Check", err); }
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
  users: [], allEntries: [], booksMap: {},
  books: [], bookId: null, rawEntries: [],
  range: "month", from: "", to: "",
  entryType: "expense", editing: null,
  newReceipts: [], oldReceipts: [], removedReceipts: [],
  subs: [], adminSubs: []
};
const isAdmin = () => S.profile?.role === "admin";
const clear = arr => { arr.forEach(u => { try { u(); } catch {} }); arr.length = 0; };

function show(screen) {
  document.getElementById("boot").style.display = "none";
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
    $('.tabs button[data-tab="home"]').click();
    if (isAdmin()) startAdmin();
    switchAccount(u.uid);
  } catch (err) {
    console.error(err);
    blocked("Could not load your account", err.message);
  } finally { busy(false); }
});

/* ---------------- usernames ---------------- */
// Users without an email sign in with a username; Firebase gets a private placeholder address.
const LOGIN_DOMAIN = "users." + firebaseConfig.authDomain;
const isPlaceholder = email => String(email || "").endsWith("@" + LOGIN_DOMAIN);
const cleanUsername = v => String(v || "").trim().toLowerCase();
const validUsername = v => /^[a-z0-9][a-z0-9._-]{2,23}$/.test(v);
async function emailForLogin(input) {
  const v = cleanUsername(input);
  if (v.includes("@")) return v;
  const snap = await getDoc(doc(db, "usernames", v));
  if (!snap.exists()) { const e = new Error("No user with that username."); e.code = "auth/user-not-found"; throw e; }
  return snap.data().email;
}
// Show a person's name instead of their login email
function personName(email) {
  if (!email) return "";
  const u = S.users.find(x => x.email === email) || (S.profile?.email === email ? S.profile : null) || (S.viewProfile?.email === email ? S.viewProfile : null);
  return u?.name || u?.username || String(email).split("@")[0];
}

$("#login-form").addEventListener("submit", async e => {
  e.preventDefault();
  const m = $("#login-msg"); m.className = "msg"; m.textContent = "Signing in…";
  try { await signInWithEmailAndPassword(auth, await emailForLogin($("#login-email").value), $("#login-pass").value); m.textContent = ""; }
  catch (err) { m.className = "msg err"; m.textContent = friendly(err); }
});
$("#forgot-btn").addEventListener("click", async () => {
  const m = $("#login-msg");
  if (!$("#login-email").value.trim()) { m.className = "msg err"; m.textContent = "Type your username or email first."; return; }
  try {
    const email = await emailForLogin($("#login-email").value);
    if (isPlaceholder(email)) { m.className = "msg err"; m.textContent = "This username has no email. Ask your admin to set a new password for you."; return; }
    await sendPasswordResetEmail(auth, email); m.className = "msg ok"; m.textContent = "Reset link sent to " + email;
  }
  catch (err) { m.className = "msg err"; m.textContent = friendly(err); }
});
$("#logout-btn").addEventListener("click", () => signOut(auth));
$("#pw-btn").addEventListener("click", async () => {
  const cur = prompt("Current password"); if (!cur) return;
  const nw = prompt("New password (at least 6 characters)"); if (!nw) return;
  if (nw.length < 6) { toast("Password must be at least 6 characters"); return; }
  try {
    await reauthenticateWithCredential(auth.currentUser, EmailAuthProvider.credential(auth.currentUser.email, cur));
    await updatePassword(auth.currentUser, nw); toast("Password changed");
  } catch (err) { toast(friendly(err), 4000); }
});
$("#blocked-logout").addEventListener("click", () => signOut(auth));

function friendly(err) {
  const c = err.code || "";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found")) return "Wrong username or password.";
  if (c.includes("email-already-in-use")) return "That username or email already has a login.";
  if (c.includes("requires-recent-login")) return "Please sign out and sign in again, then retry.";
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
const bookOf = e => e?.bookId || "main";
const legacyBook = u => ({ id: "main", name: "Cash book", currency: DEFAULT_CURRENCY, openingBalance: +(u?.openingBalance || 0), virtual: true });
const sortBooks = arr => arr.sort((x, y) => (x.order ?? 0) - (y.order ?? 0) || String(x.name).localeCompare(y.name));
const booksFor = uid => uid === S.viewUid && S.books.length ? S.books : (S.booksMap[uid] || [legacyBook(S.users.find(u => u.id === uid))]);
const curBook = () => S.books.find(b => b.id === S.bookId) || S.books[0];
const bookBal = (b, entries) => (+b.openingBalance || 0) + sums(entries.filter(e => bookOf(e) === b.id)).net;
const curOf = uid => { const c = [...new Set(booksFor(uid).map(b => b.currency || DEFAULT_CURRENCY))]; return c.length === 1 ? c[0] : "MIXED"; };

function switchAccount(uid) {
  clear(S.subs);
  S.viewUid = uid; S.heads = []; S.entries = []; S.rawEntries = []; S.books = []; S.bookId = null;
  try { S.bookId = localStorage.getItem("book:" + uid); } catch {}
  const mine = uid === S.user.uid;
  $("#viewing-banner").classList.toggle("hidden", mine);
  S.subs.push(onSnapshot(doc(db, "users", uid), s => {
    S.viewProfile = { id: uid, ...s.data() };
    const nm = S.viewProfile.name || S.viewProfile.email;
    $("#who-name").textContent = nm;
    if (!mine) $("#viewing-name").textContent = nm;
    renderHome();
  }));
  S.subs.push(onSnapshot(collection(db, "users", uid, "books"), s => {
    if (!s.docs.length) { createMainBook(uid); return; }
    S.books = sortBooks(s.docs.map(d => ({ id: d.id, ...d.data() })));
    S.booksMap[uid] = S.books;
    applyBook();
  }, err => toast(friendly(err))));
  S.subs.push(onSnapshot(query(collection(db, "users", uid, "heads"), orderBy("name")), s => {
    S.heads = s.docs.map(d => ({ id: d.id, ...d.data() }));
    renderHeads(); fillHeadFilters(); renderHome();
  }, err => toast(friendly(err))));
  S.subs.push(onSnapshot(query(collection(db, "users", uid, "entries"), orderBy("date", "desc")), s => {
    S.rawEntries = s.docs.map(d => ({ id: d.id, uid, ...d.data() }));
    applyBook();
  }, err => toast(friendly(err))));
  fillReportScope();
}

// First book for an account; carries over the old account-level currency and opening balance.
async function createMainBook(uid, cur, opening) {
  if (S.creatingBook === uid) return; S.creatingBook = uid;
  try {
    if (cur === undefined) { try { cur = (await getDoc(doc(db, "users", uid, "settings", "main"))).data()?.currency; } catch {} }
    if (opening === undefined) { try { opening = (await getDoc(doc(db, "users", uid))).data()?.openingBalance; } catch {} }
    await setDoc(doc(db, "users", uid, "books", "main"), { name: "Cash book", currency: cur || DEFAULT_CURRENCY, openingBalance: +opening || 0, order: 0, createdAt: serverTimestamp() });
  } catch (err) { toast(friendly(err)); }
  finally { S.creatingBook = null; }
}

function applyBook() {
  const b = curBook();
  if (!b) { S.entries = []; renderBookBar(); return; }
  S.bookId = b.id;
  try { localStorage.setItem("book:" + S.viewUid, b.id); } catch {}
  CUR = b.currency || DEFAULT_CURRENCY;
  S.entries = S.rawEntries.filter(e => bookOf(e) === b.id);
  $("#e-cur").textContent = sym();
  renderBookBar(); renderHome(); renderHeads(); renderBooks(); fillReportBooks(); renderReportPreview();
  if (isAdmin()) renderUsers();
}

function renderBookBar() {
  $("#book-pills").innerHTML = S.books.map(b => `<button type="button" data-book="${b.id}" class="${b.id === S.bookId ? "active" : ""}">
      <span>${esc(b.name)}</span><small>${sym(b.currency)} ${money(bookBal(b, S.rawEntries), b.currency)}</small></button>`).join("")
    + `<button type="button" class="add" data-add-book>＋ Book</button>`;
}
$("#book-pills").addEventListener("click", e => {
  const btn = e.target.closest("button"); if (!btn) return;
  if (btn.hasAttribute("data-add-book")) {
    $('.tabs button[data-tab="heads"]').click(); window.scrollTo(0, 0);
    setTimeout(() => $("#book-name").focus(), 100); return;
  }
  S.bookId = btn.dataset.book; renderHome.limit = 0; applyBook();
});

/* ---------------- books management ---------------- */
function renderBooks() {
  $("#books-list").innerHTML = S.books.map(b => {
    const n = S.rawEntries.filter(e => bookOf(e) === b.id).length;
    return `<div class="book-item" data-id="${b.id}">
      <input class="bk-name" value="${esc(b.name)}" aria-label="Book name">
      <select class="bk-cur" aria-label="Currency">${curOptions()}</select>
      <label class="bk-open-l">Opening<input class="bk-open" type="number" step="0.01" value="${+b.openingBalance || 0}"></label>
      <span class="muted small bk-n">${n} entries · ${sym(b.currency)} ${money(bookBal(b, S.rawEntries), b.currency)}</span>
      <button type="button" class="icon-btn bk-del" title="Delete book">🗑</button></div>`;
  }).join("");
  $$("#books-list .book-item").forEach(row => { row.querySelector(".bk-cur").value = S.books.find(b => b.id === row.dataset.id)?.currency || DEFAULT_CURRENCY; });
  if (!$("#book-cur").value) $("#book-cur").value = CUR;
}
$("#books-list").addEventListener("change", async e => {
  const row = e.target.closest(".book-item"); if (!row) return;
  const id = row.dataset.id, upd = {};
  if (e.target.classList.contains("bk-name")) { const v = e.target.value.trim(); if (!v) { renderBooks(); return; } upd.name = v; }
  if (e.target.classList.contains("bk-cur")) upd.currency = e.target.value;
  if (e.target.classList.contains("bk-open")) upd.openingBalance = parseFloat(e.target.value) || 0;
  try { await updateDoc(doc(db, "users", S.viewUid, "books", id), upd); toast("Book updated"); }
  catch (err) { toast(friendly(err)); }
});
$("#books-list").addEventListener("click", async e => {
  if (!e.target.classList.contains("bk-del")) return;
  const id = e.target.closest(".book-item").dataset.id, b = S.books.find(x => x.id === id);
  const n = S.rawEntries.filter(x => bookOf(x) === id).length;
  if (S.books.length === 1) { toast("You need at least one book"); return; }
  if (n) { toast(`"${b.name}" has ${n} entries — delete them first`, 3500); return; }
  if (!confirm(`Delete book "${b.name}"?`)) return;
  try { if (S.bookId === id) S.bookId = null; await deleteDoc(doc(db, "users", S.viewUid, "books", id)); applyBook(); toast("Book deleted"); }
  catch (err) { toast(friendly(err)); }
});
$("#book-form").addEventListener("submit", async e => {
  e.preventDefault();
  const name = $("#book-name").value.trim(); if (!name) return;
  if (S.books.some(b => b.name.toLowerCase() === name.toLowerCase())) { toast("A book with that name exists"); return; }
  try {
    const ref = await addDoc(collection(db, "users", S.viewUid, "books"), { name, currency: $("#book-cur").value || CUR, openingBalance: parseFloat($("#book-open").value) || 0, order: S.books.length, createdAt: serverTimestamp() });
    $("#book-name").value = ""; $("#book-open").value = "";
    S.bookId = ref.id; applyBook(); toast(`Book "${name}" added`);
  } catch (err) { toast(friendly(err)); }
});
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
  const opening = +(curBook()?.openingBalance || 0);
  const all = sums(E);
  const bal = opening + all.net;
  $("#bal-total").textContent = `${sym()} ${money(bal)}`;
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
      <div><div class="h">${esc(e.headName || "—")}</div><div class="n">${esc(e.note || e.mode || "")}${e.receiptCount ? ` · 📎${e.receiptCount}` : ""}${e.location?.lat != null ? ` · <span class="pin">📍</span>` : ""}</div></div>
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
  $("#e-mode").closest("label").classList.toggle("hidden", false);
  if (t === "transfer") {
    const tr = keepHead?.transfer;
    $("#e-head-label").textContent = tr?.fromBook ? "From book" : "To book";
    const others = S.books.filter(b => b.id !== S.bookId);
    $("#e-head").innerHTML = others.length ? others.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join("")
      : `<option value="">— add a second book first —</option>`;
    if (tr) $("#e-head").value = tr.toBook || tr.fromBook;
    updateRecv(); return;
  }
  $("#e-head-label").textContent = "Account head";
  $("#e-recv-wrap").classList.add("hidden");
  const heads = S.heads.filter(h => h.type === t);
  let opts = heads.map(h => `<option value="${h.id}">${esc(h.name)}</option>`).join("");
  if (keepHead && keepHead.headId && !heads.some(h => h.id === keepHead.headId))
    opts = `<option value="${keepHead.headId}" data-name="${esc(keepHead.headName)}">${esc(keepHead.headName)} (removed)</option>` + opts;
  $("#e-head").innerHTML = opts || `<option value="">— add a head first —</option>`;
  if (keepHead?.headId) $("#e-head").value = keepHead.headId;
}
// Show "received" amount when a transfer goes between books of different currencies
function updateRecv() {
  const other = S.books.find(b => b.id === $("#e-head").value);
  const show = S.entryType === "transfer" && other && (other.currency || DEFAULT_CURRENCY) !== CUR;
  $("#e-recv-wrap").classList.toggle("hidden", !show);
  $("#e-recv").required = !!show;
  if (show) $("#e-recv-cur").textContent = other.currency;
}
$("#e-head").addEventListener("change", updateRecv);
$$("#entry-type button").forEach(b => b.addEventListener("click", () => { if (!S.editing) setEntryType(b.dataset.type); }));

async function openEntry(entry) {
  S.editing = entry || null; S.newReceipts = []; S.oldReceipts = []; S.removedReceipts = [];
  S.touched = new Set(entry ? ["e-amount", "e-date", "e-head", "e-mode", "type", ...(entry.note ? ["e-note"] : []), ...(entry.ref ? ["e-ref"] : [])] : []);
  setAiStatus("");
  $("#entry-title").textContent = entry ? "Edit entry" : "Add entry";
  $("#e-delete").classList.toggle("hidden", !entry);
  const isTr = !!entry?.transfer;
  setEntryType(isTr ? "transfer" : (entry?.type || (S.entryType === "transfer" && S.books.length < 2 ? "expense" : S.entryType) || "expense"), entry);
  $("#entry-type").classList.toggle("locked", !!entry);
  $("#e-head").disabled = isTr;
  $("#e-recv").value = "";
  if (isTr) {
    const peer = S.rawEntries.find(x => x.id === entry.transfer.peer);
    if (peer && !$("#e-recv-wrap").classList.contains("hidden")) $("#e-recv").value = peer.amount;
  }
  $("#e-amount").value = entry?.amount ?? "";
  $("#e-date").value = entry?.date || todayStr();
  $("#e-mode").value = entry?.mode || "Cash";
  $("#e-note").value = entry?.note || "";
  $("#e-ref").value = entry?.ref || "";
  $("#e-meta").textContent = entry ? metaLine(entry) : "";
  if (entry) showGeo(entry.location); else captureLocation();
  renderThumbs();
  $$(".ai-filled").forEach(el => el.classList.remove("ai-filled"));
  $("#entry-modal").classList.remove("hidden");
  if (!entry) setTimeout(() => $("#e-amount").focus(), 50);
  if (entry?.receiptCount) {
    const s = await getDocs(query(collection(db, "users", S.viewUid, "receipts"), where("entryId", "==", entry.id)));
    if (S.editing?.id !== entry.id) return;
    S.oldReceipts = s.docs.map(d => ({ id: d.id, ...d.data() }));
    renderThumbs();
  }
}

/* ---------------- GPS location ---------------- */
const mapUrl = l => `https://maps.google.com/?q=${l.lat},${l.lng}`;
function showGeo(loc) {
  const el = $("#e-geo");
  if (!loc) { el.innerHTML = `<span class="muted">📍 No location recorded</span>`; return; }
  if (loc.status === "pending") { el.innerHTML = `<span class="dot-spin"></span> Getting location…`; return; }
  if (loc.lat == null) {
    el.innerHTML = loc.status === "denied"
      ? `<span class="warn-t">📍 Location blocked — allow location for this site in browser settings</span>`
      : `<span class="warn-t">📍 Location not available (turn on GPS)</span> <button type="button" class="btn small" id="geo-retry">Retry</button>`;
    $("#geo-retry")?.addEventListener("click", captureLocation);
    return;
  }
  el.innerHTML = `📍 <a href="${mapUrl(loc)}" target="_blank" rel="noopener">${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}</a> <span class="muted">±${Math.round(loc.acc || 0)} m</span>`;
}
function captureLocation() {
  S.geo = { status: "pending" }; showGeo(S.geo);
  S.geoPromise = new Promise(resolve => {
    if (!navigator.geolocation) { S.geo = { status: "unavailable" }; showGeo(S.geo); return resolve(); }
    navigator.geolocation.getCurrentPosition(p => {
      S.geo = { status: "ok", lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, at: new Date(p.timestamp).toISOString() };
      if (!S.editing) showGeo(S.geo); resolve();
    }, err => {
      S.geo = { status: err.code === 1 ? "denied" : "unavailable" };
      if (!S.editing) showGeo(S.geo); resolve();
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
  });
}

function metaLine(e) {
  const f = ts => ts?.toDate ? ts.toDate().toLocaleString("en-GB") : "";
  let s = `Added ${f(e.createdAt)}${e.createdBy ? " by " + personName(e.createdBy) : ""}`;
  if (e.updatedAt && e.editCount) s += ` · Edited ${e.editCount}× · last ${f(e.updatedAt)}${e.updatedBy ? " by " + personName(e.updatedBy) : ""}`;
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
    : "";
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

["#e-files", "#e-camera"].forEach(sel => $(sel).addEventListener("change", async e => {
  const files = [...e.target.files]; e.target.value = "";
  busy(true);
  for (const f of files) {
    try { S.newReceipts.push(await fileToReceipt(f)); }
    catch (err) { toast(`${f.name}: ${err.message}`, 4000); }
  }
  busy(false); renderThumbs();
  const img = S.newReceipts[S.newReceipts.length - 1];
  if (img && files.length) readBill(img);
}));

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
  const isTr = S.entryType === "transfer";
  if (!headSel.value) { toast(isTr ? "Add a second book first (Books & heads tab)" : "Add an account head first (Books & heads tab)"); return; }
  if (!(amount > 0)) { toast("Enter an amount"); return; }
  const uid = S.viewUid, who = S.user.email, ed = S.editing;
  const col = collection(db, "users", uid, "entries");
  const ref = ed ? doc(db, "users", uid, "entries", ed.id) : doc(col);
  const keptOld = S.oldReceipts.filter(r => !S.removedReceipts.includes(r.id)).length;
  const common = {
    amount, date: $("#e-date").value, mode: $("#e-mode").value, note: $("#e-note").value.trim(), ref: $("#e-ref").value.trim(),
    receiptCount: (ed ? keptOld : 0) + S.newReceipts.length, updatedAt: serverTimestamp(), updatedBy: who
  };
  if (ed) common.editCount = (ed.editCount || 0) + 1;
  else Object.assign(common, { createdAt: serverTimestamp(), createdBy: who, editCount: 0 });
  const recvVisible = !$("#e-recv-wrap").classList.contains("hidden");
  const recv = recvVisible ? Math.round(parseFloat($("#e-recv").value) * 100) / 100 : amount;
  if (isTr && !(recv > 0)) { toast("Enter the amount received in the other book"); return; }
  busy(true);
  try {
    if (!ed) {
      if (S.geo?.status === "pending") await Promise.race([S.geoPromise, new Promise(r => setTimeout(r, 8000))]);
      common.location = S.geo?.status === "ok" ? { lat: S.geo.lat, lng: S.geo.lng, acc: Math.round(S.geo.acc), at: S.geo.at } : { status: S.geo?.status || "unavailable" };
    }
    for (const r of S.newReceipts)
      await addDoc(collection(db, "users", uid, "receipts"), { entryId: ref.id, name: r.name, mime: r.mime, data: r.data, createdAt: serverTimestamp(), createdBy: who });
    for (const id of S.removedReceipts) await deleteDoc(doc(db, "users", uid, "receipts", id));
    const bt = writeBatch(db);
    if (isTr && !ed) {
      const from = curBook(), to = S.books.find(b => b.id === headSel.value), peerRef = doc(col);
      bt.set(ref, { ...common, type: "expense", bookId: from.id, headId: "__transfer", headName: `Transfer → ${to.name}`, transfer: { peer: peerRef.id, toBook: to.id } });
      bt.set(peerRef, { ...common, amount: recv, receiptCount: 0, type: "income", bookId: to.id, headId: "__transfer", headName: `Transfer ← ${from.name}`, transfer: { peer: ref.id, fromBook: from.id } });
    } else if (isTr && ed) {
      bt.set(ref, common, { merge: true });
      const peer = S.rawEntries.find(x => x.id === ed.transfer.peer);
      if (peer) {
        const { receiptCount, editCount, ...shared } = common;
        bt.set(doc(db, "users", uid, "entries", peer.id), { ...shared, amount: recv, editCount: (peer.editCount || 0) + 1 }, { merge: true });
      }
    } else {
      const opt = headSel.selectedOptions[0];
      const headName = opt.dataset.name || S.heads.find(h => h.id === headSel.value)?.name || opt.textContent;
      bt.set(ref, { ...common, type: S.entryType, headId: headSel.value, headName, bookId: ed ? bookOf(ed) : S.bookId }, { merge: true });
    }
    await bt.commit();
    $("#entry-modal").classList.add("hidden");
    toast(ed ? "Entry updated" : isTr ? "Transfer saved" : "Entry saved");
  } catch (err) { console.error(err); toast(friendly(err), 5000); }
  finally { busy(false); }
});

$("#e-delete").addEventListener("click", async () => {
  const ed = S.editing; if (!ed) return;
  if (!confirm(ed.transfer ? `Delete this transfer of ${money(ed.amount)}? It is removed from both books.` : `Delete this ${ed.type} of ${money(ed.amount)}? This cannot be undone.`)) return;
  busy(true);
  try {
    const s = await getDocs(query(collection(db, "users", S.viewUid, "receipts"), where("entryId", "==", ed.id)));
    const b = writeBatch(db);
    s.docs.forEach(d => b.delete(d.ref));
    b.delete(doc(db, "users", S.viewUid, "entries", ed.id));
    if (ed.transfer?.peer && S.rawEntries.some(x => x.id === ed.transfer.peer)) b.delete(doc(db, "users", S.viewUid, "entries", ed.transfer.peer));
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
      const used = S.rawEntries.filter(e => e.headId === h.id).length;
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
      S.rawEntries.filter(x => x.headId === id).forEach(x => b.update(doc(db, "users", S.viewUid, "entries", x.id), { headName: name }));
      await b.commit(); toast("Head renamed");
    } catch (err) { toast(friendly(err)); } finally { busy(false); }
  });
  $(sel).addEventListener("click", async e => {
    if (!e.target.classList.contains("del")) return;
    const id = e.target.closest(".head-item").dataset.id;
    const h = S.heads.find(x => x.id === id);
    const used = S.rawEntries.filter(x => x.headId === id).length;
    if (!confirm(`Delete head "${h.name}"?` + (used ? `\n${used} entries keep the name "${h.name}".` : ""))) return;
    try { await deleteDoc(doc(db, "users", S.viewUid, "heads", id)); toast("Head deleted"); } catch (err) { toast(friendly(err)); }
  });
});
$("#book-cur").innerHTML = curOptions(); $("#u-cur").innerHTML = curOptions();
$("#u-cur").value = DEFAULT_CURRENCY; $("#book-cur").value = DEFAULT_CURRENCY;

/* ---------------- admin: users ---------------- */
function startAdmin() {
  S.adminSubs.push(onSnapshot(query(collection(db, "users"), orderBy("name")), s => {
    S.users = s.docs.map(d => ({ id: d.id, ...d.data() })).filter(u => !u.archived);
    renderUsers(); fillReportScope();
    Promise.all(S.users.map(async u => {
      if (u.id === S.viewUid && S.books.length) return;
      try {
        const bs = (await getDocs(collection(db, "users", u.id, "books"))).docs.map(d => ({ id: d.id, ...d.data() }));
        if (bs.length) S.booksMap[u.id] = sortBooks(bs);
        else {
          const c = (await getDoc(doc(db, "users", u.id, "settings", "main"))).data()?.currency;
          S.booksMap[u.id] = [{ ...legacyBook(u), currency: c || DEFAULT_CURRENCY }];
        }
      } catch { }
    })).then(() => { renderUsers(); fillReportScope(); renderReportPreview(); });
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
    const bks = booksFor(u.id);
    const bal = bks.reduce((t, b) => t + (+b.openingBalance || 0), 0) + a.net;
    tIn += m.inc; tOut += m.exp; tBal += bal;
    const balHtml = bks.map(b => { const v = bookBal(b, E); return `<div class="${v < 0 ? "exp" : ""}">${bks.length > 1 ? `<span class="muted small">${esc(b.name)}</span> ` : ""}<b>${sym(b.currency)} ${money(v, b.currency)}</b></div>`; }).join("");
    return `<tr data-id="${u.id}"><td><b>${esc(u.name)}</b><br><span class="muted small">${u.username ? "@" + esc(u.username) : esc(u.email)}</span></td>
      <td>${u.role === "admin" ? "Admin" : "User"}</td>
      <td class="num inc">${money(m.inc, curOf(u.id))}</td><td class="num exp">${money(m.exp, curOf(u.id))}</td>
      <td class="num">${balHtml}</td>
      <td><span class="tag ${u.active === false ? "off" : "on"}">${u.active === false ? "Disabled" : "Active"}</span></td>
      <td><button class="btn small open">Open</button> <button class="btn small edit">Edit</button></td></tr>`;
  }).join("") + (() => {
    const curs = new Set(S.users.map(u => curOf(u.id)));
    if (curs.size > 1 || curs.has("MIXED")) return `<tr><td colspan="7" class="muted small">Books use different currencies — no combined total.</td></tr>`;
    const c = [...curs][0];
    return `<tr><td><b>Total</b></td><td></td><td class="num inc"><b>${money(tIn, c)}</b></td><td class="num exp"><b>${money(tOut, c)}</b></td><td class="num"><b>${sym(c)} ${money(tBal, c)}</b></td><td></td><td></td></tr>`;
  })();
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
  const name = $("#u-name").value.trim(), username = cleanUsername($("#u-username").value), realEmail = $("#u-email").value.trim().toLowerCase(), pass = $("#u-pass").value;
  if (!validUsername(username)) { m.className = "msg err"; m.textContent = "Username: 3–24 letters/numbers (dot, dash, underscore allowed), no spaces."; return; }
  const email = realEmail || `${username}@${LOGIN_DOMAIN}`;
  busy(true);
  try { if ((await getDoc(doc(db, "usernames", username))).exists()) { m.className = "msg err"; m.textContent = `Username "${username}" is taken.`; busy(false); return; } }
  catch (err) { m.className = "msg err"; m.textContent = friendly(err) + " (publish the updated Firestore rules)"; busy(false); return; }
  let sec;
  try {
    // A second Firebase app instance creates the login without signing the admin out.
    sec = initializeApp(firebaseConfig, "creator-" + Date.now());
    const secAuth = getAuth(sec);
    const cred = await createUserWithEmailAndPassword(secAuth, email, pass);
    await signOut(secAuth);
    const uid = cred.user.uid;
    await setDoc(doc(db, "users", uid), {
      name, username, email, role: $("#u-role").value, active: true,
      openingBalance: parseFloat($("#u-opening").value) || 0,
      createdAt: serverTimestamp(), createdBy: S.user.email
    });
    await setDoc(doc(db, "usernames", username), { email, uid });
    await setDoc(doc(db, "users", uid, "books", "main"), { name: "Cash book", currency: $("#u-cur").value, openingBalance: parseFloat($("#u-opening").value) || 0, order: 0, createdAt: serverTimestamp() });
    await seedHeads(uid);
    m.className = "msg ok"; m.textContent = `Created ${name}. Login: ${username} / the password you set.`;
    e.target.reset(); $("#u-opening").value = 0; $("#u-cur").value = DEFAULT_CURRENCY;
  } catch (err) { m.className = "msg err"; m.textContent = friendly(err); }
  finally { if (sec) deleteApp(sec).catch(() => {}); busy(false); }
});

let editingUser = null;
function openUserEdit(id) {
  const u = S.users.find(x => x.id === id); editingUser = u;
  $("#ue-name").value = u.name || ""; $("#ue-role").value = u.role || "user";
  $("#ue-active").value = String(u.active !== false);
  $("#ue-username").value = u.username || "";
  $("#ue-email").textContent = isPlaceholder(u.email) ? "No email — sign-in by username only" : "Email: " + u.email;
  $("#ue-reset").textContent = isPlaceholder(u.email) ? "Set new password" : "Send password reset email";
  $("#user-modal").classList.remove("hidden");
}
$("#user-edit-form").addEventListener("submit", async e => {
  e.preventDefault();
  const u = editingUser, self = u.id === S.user.uid;
  const upd = { name: $("#ue-name").value.trim(), role: $("#ue-role").value, active: $("#ue-active").value === "true" };
  if (self && (upd.role !== "admin" || !upd.active)) { toast("You can't remove your own admin access"); return; }
  const newU = cleanUsername($("#ue-username").value);
  if (newU && newU !== (u.username || "")) {
    if (!validUsername(newU)) { toast("Username: 3–24 letters/numbers, no spaces"); return; }
    try {
      const taken = await getDoc(doc(db, "usernames", newU));
      if (taken.exists() && taken.data().uid !== u.id) { toast(`Username "${newU}" is taken`); return; }
      await setDoc(doc(db, "usernames", newU), { email: u.email, uid: u.id });
      if (u.username) await deleteDoc(doc(db, "usernames", u.username));
      upd.username = newU;
    } catch (err) { toast(friendly(err) + " (publish the updated Firestore rules)", 5000); return; }
  }
  try {
    await updateDoc(doc(db, "users", u.id), upd);
    $("#user-modal").classList.add("hidden"); toast("User updated"); }
  catch (err) { toast(friendly(err)); }
});
$("#ue-reset").addEventListener("click", async () => {
  if (isPlaceholder(editingUser.email)) return adminSetPassword(editingUser);
  try { await sendPasswordResetEmail(auth, editingUser.email); toast("Reset email sent to " + editingUser.email); }
  catch (err) { toast(friendly(err)); }
});

// Username-only users have no email to reset with, and a browser app can't change another
// person's password. So the admin gives them a fresh login with the same username and moves
// all their data (books, heads, entries, receipts) across; the old login is switched off.
async function adminSetPassword(u) {
  if (u.id === S.user.uid) { toast("Use the 🔑 button to change your own password"); return; }
  const nw = prompt(`New password for ${u.name} (${u.username}) — at least 6 characters`);
  if (!nw) return;
  if (nw.length < 6) { toast("Password must be at least 6 characters"); return; }
  let sec;
  try {
    busy(true, "Copying data…");
    const acc = await exportAccount(u.id, true);
    sec = initializeApp(firebaseConfig, "creator-" + Date.now());
    const secAuth = getAuth(sec);
    const email = `${u.username}.${Date.now().toString(36)}@${LOGIN_DOMAIN}`;
    const cred = await createUserWithEmailAndPassword(secAuth, email, nw);
    await signOut(secAuth);
    const nu = cred.user.uid;
    await setDoc(doc(db, "users", nu), { name: u.name, username: u.username, email, role: u.role || "user", active: true, openingBalance: +u.openingBalance || 0, createdAt: serverTimestamp(), createdBy: S.user.email, replaces: u.id });
    busy(true, "Moving books & entries…");
    await writeAll(nu, "books", acc.books || [], 400);
    await writeAll(nu, "heads", acc.heads || [], 400);
    await writeAll(nu, "entries", acc.entries || [], 400);
    for (let i = 0; i < (acc.receipts || []).length; i++) {
      busy(true, `Moving receipts ${i + 1}/${acc.receipts.length}…`);
      const { id, ...rest } = acc.receipts[i];
      await setDoc(doc(db, "users", nu, "receipts", id), revive(rest));
    }
    if (acc.settings) await setDoc(doc(db, "users", nu, "settings", "main"), acc.settings);
    await setDoc(doc(db, "usernames", u.username), { email, uid: nu });
    busy(true, "Removing old copy…");
    for (const name of ["receipts", "entries", "heads", "books", "settings"]) {
      const docs = (await getDocs(collection(db, "users", u.id, name))).docs;
      for (let i = 0; i < docs.length; i += 400) { const b = writeBatch(db); docs.slice(i, i + 400).forEach(d => b.delete(d.ref)); await b.commit(); }
    }
    await updateDoc(doc(db, "users", u.id), { active: false, archived: true, replacedBy: nu });
    $("#user-modal").classList.add("hidden");
    toast(`New password set. ${u.name} signs in with "${u.username}" and the new password.`, 5000);
  } catch (err) { console.error(err); toast("Could not set password: " + friendly(err), 6000); }
  finally { if (sec) deleteApp(sec).catch(() => {}); busy(false); }
}

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
["#r-scope", "#r-from", "#r-to", "#r-type", "#r-head", "#r-book"].forEach(s => $(s).addEventListener("change", renderReportPreview));
function fillReportBooks() {
  const sel = $("#r-book"), cur = sel.value;
  sel.innerHTML = `<option value="">All books</option>` + S.books.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join("");
  sel.value = S.books.some(b => b.id === cur) ? cur : "";
}

function reportData() {
  const scope = isAdmin() ? $("#r-scope").value : "__view";
  const onScreen = scope === "__view" || scope === S.viewUid;
  $("#r-book-wrap").classList.toggle("hidden", !onScreen || S.books.length < 2);
  const bookSel = onScreen ? $("#r-book").value : "";
  let base, books, title;
  if (scope === "__all") {
    base = S.allEntries; title = "All users";
    books = S.users.flatMap(u => booksFor(u.id).map(b => ({ ...b, uid: u.id })));
  } else {
    const uid = scope === "__view" ? S.viewUid : scope;
    base = uid === S.viewUid ? S.rawEntries : S.allEntries.filter(e => e.uid === uid);
    books = booksFor(uid).map(b => ({ ...b, uid }));
    const prof = uid === S.viewUid ? S.viewProfile : S.users.find(u => u.id === uid);
    title = prof?.name || prof?.email || "";
    if (bookSel) {
      books = books.filter(b => b.id === bookSel);
      base = base.filter(e => bookOf(e) === bookSel);
      title += ` · ${books[0]?.name || ""}`;
    }
  }
  const opening = books.reduce((t, b) => t + (+b.openingBalance || 0), 0);
  const r = rangeFor($("#r-range").value, $("#r-from").value, $("#r-to").value);
  const type = $("#r-type").value, head = $("#r-head").value;
  const rows = base.filter(e => inRange(e, r) && (!type || e.type === type) && (!head || e.headName === head))
    .sort((a, b) => a.date.localeCompare(b.date) || ((a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0)));
  const before = r ? base.filter(e => e.date < r[0]) : [];
  const bf = opening + sums(before).net;
  const s = sums(rows);
  const heads = [...new Set(base.map(e => e.headName).filter(Boolean))].sort();
  const curs = [...new Set(books.map(b => b.currency || DEFAULT_CURRENCY))];
  const cur = curs.length === 1 ? curs[0] : "MIXED";
  const bookName = e => (booksFor(e.uid).find(b => b.id === bookOf(e)) || {}).name || "Cash book";
  const multiBook = books.length > 1;
  return { cur, scope, base, rows, r, s, bf, closing: bf + sums(base.filter(e => inRange(e, r))).net, title, type, head, heads, filtered: !!(type || head), multiBook, bookName };
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
function buildTables(d, withLoc = true) {
  const all = d.scope === "__all";
  const showRun = !d.filtered && !all && !d.multiBook;
  let run = d.bf;
  const entryHead = ["Date", ...(all ? ["User"] : []), ...(d.multiBook ? ["Book"] : []), "Head", "Description", "Ref", "Mode", "Income", "Expense", ...(showRun ? ["Balance"] : []), "Receipts", ...(withLoc ? ["Location", "Map"] : [])];
  const entryRows = d.rows.map(e => {
    const inc = e.type === "income" ? +e.amount : 0, exp = e.type === "expense" ? +e.amount : 0;
    run += inc - exp;
    return [e.date, ...(all ? [userName(e.uid)] : []), ...(d.multiBook ? [d.bookName(e)] : []), e.headName || "", e.note || "", e.ref || "", e.mode || "",
      inc || "", exp || "", ...(showRun ? [Math.round(run * 100) / 100] : []), e.receiptCount || 0,
      ...(withLoc ? (e.location?.lat != null ? [`${e.location.lat.toFixed(5)}, ${e.location.lng.toFixed(5)}`, mapUrl(e.location)] : [e.location?.status ? "No GPS (" + e.location.status + ")" : "", ""]) : [])];
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
      const bal = booksFor(u.id).reduce((t, b) => t + (+b.openingBalance || 0), 0) + sums(E).net;
      return [u.name, u.username || u.email, curOf(u.id), round2(p.inc), round2(p.exp), round2(p.net), round2(bal)];
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
    ["Expense report"], ["Account", d.title], ["Period", rangeLabel(d.r)],
    ["Filter", [d.type && (d.type === "income" ? "Income only" : "Expense only"), d.head].filter(Boolean).join(" · ") || "None"],
    ["Generated", new Date().toLocaleString("en-GB") + " by " + (S.profile?.name || personName(S.user.email))], [],
    ["Currency", d.cur === "MIXED" ? "Mixed — see By user sheet" : d.cur], [], [`Opening balance (b/f)`, round2(d.bf)], ["Income", round2(d.s.inc)], ["Expense", round2(d.s.exp)],
    ["Net", round2(d.s.net)], [`Closing balance`, round2(d.closing)], ["Entries", d.s.count]
  ];
  XLSX.utils.book_append_sheet(wb, sheet(summary, [28, 40]), "Summary");
  XLSX.utils.book_append_sheet(wb, sheet([t.entryHead, ...t.entryRows, [], totalRow(t.entryHead, d)], t.entryHead.map(h => ({ Description: 34, Head: 22, User: 20, Book: 16, Location: 22, Map: 40 }[h] || 13))), "Entries");
  XLSX.utils.book_append_sheet(wb, sheet([["Type", "Head", "Total"], ...t.headRows], [12, 28, 14]), "By head");
  XLSX.utils.book_append_sheet(wb, sheet([["Date", "Income", "Expense", "Net"], ...t.dayRows], [13, 13, 13, 13]), "Daily");
  if (t.userRows) XLSX.utils.book_append_sheet(wb, sheet([["User", "Login", "Currency", "Income (period)", "Expense (period)", "Net (period)", "Current balance"], ...t.userRows], [22, 28, 10, 16, 16, 14, 16]), "By user");
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

// App logo for PDF headers
let logoData = null;
(() => { const i = new Image(); i.onload = () => { const c = document.createElement("canvas"); c.width = c.height = 128; c.getContext("2d").drawImage(i, 0, 0, 128, 128); try { logoData = c.toDataURL("image/png"); } catch {} }; i.src = "icon-192.png"; })();

$("#dl-pdf").addEventListener("click", () => {
  if (!window.jspdf) { toast("PDF library not loaded — check internet"); return; }
  const d = reportData(), t = buildTables(d, false);
  const money = (n, c = d.cur === "MIXED" ? "USD" : d.cur) => (Number(n) || 0).toLocaleString(curInfo(c).loc || "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pdf = new window.jspdf.jsPDF({ orientation: t.entryHead.length > 9 ? "landscape" : "portrait", unit: "pt", format: "a4" });
  const W = pdf.internal.pageSize.getWidth(), orange = [232, 100, 30], dark = [43, 47, 51];
  pdf.setFillColor(...dark); pdf.rect(0, 0, W, 56, "F");
  if (logoData) pdf.addImage(logoData, "PNG", 28, 14, 28, 28);
  pdf.setTextColor(255); pdf.setFont("helvetica", "bold");
  pdf.setFontSize(15); pdf.text("Expense report", 66, 33);
  pdf.setFont("helvetica", "normal"); pdf.setFontSize(9); pdf.text(new Date().toLocaleString("en-GB"), W - 28, 33, { align: "right" });
  pdf.setTextColor(30); pdf.setFontSize(10);
  pdf.text(`Account: ${d.title}   ·   Currency: ${d.cur === "MIXED" ? "mixed (see per-user table)" : d.cur}`, 28, 78); pdf.text(`Period: ${rangeLabel(d.r)}`, 28, 93);
  if (d.filtered) pdf.text(`Filter: ${[d.type, d.head].filter(Boolean).join(" · ")}`, 28, 108);
  pdf.autoTable({
    startY: d.filtered ? 118 : 104, theme: "grid", styles: { fontSize: 9 }, headStyles: { fillColor: orange },
    head: [["Opening (b/f)", "Income", "Expense", "Net", "Closing balance"]],
    body: [[money(d.bf), money(d.s.inc), money(d.s.exp), money(d.s.net), money(d.closing)]]
  });
  if (t.userRows) pdf.autoTable({
    startY: pdf.lastAutoTable.finalY + 14, theme: "striped", styles: { fontSize: 8.5 }, headStyles: { fillColor: dark },
    head: [["User", "Currency", "Income", "Expense", "Net", "Current balance"]],
    body: t.userRows.map(r => [r[0], r[2], money(r[3], r[2]), money(r[4], r[2]), money(r[5], r[2]), money(r[6], r[2])])
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



/* ---------------- backup: export / import ---------------- */
const BACKUP_KIND = "expense-backup";
const plain = o => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, v?.toDate ? { __ts: v.toDate().toISOString() } : v]));
const revive = o => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, v && typeof v === "object" && v.__ts ? Timestamp.fromDate(new Date(v.__ts)) : v]));

async function exportAccount(uid, withReceipts) {
  const prof = (await getDoc(doc(db, "users", uid))).data() || {};
  const grab = async name => (await getDocs(collection(db, "users", uid, name))).docs.map(d => ({ id: d.id, ...plain(d.data()) }));
  const settings = (await getDoc(doc(db, "users", uid, "settings", "main"))).data() || null;
  const acc = { uid, profile: plain(prof), settings, books: await grab("books"), heads: await grab("heads"), entries: await grab("entries") };
  if (withReceipts) acc.receipts = await grab("receipts");
  return acc;
}

$("#bk-export").addEventListener("click", async () => {
  const all = isAdmin() && $("#bk-scope").value === "all";
  const uids = all ? S.users.map(u => u.id) : [S.viewUid];
  const withReceipts = $("#bk-receipts").checked;
  try {
    const accounts = [];
    for (let i = 0; i < uids.length; i++) {
      busy(true, `Exporting ${i + 1} of ${uids.length}…`);
      accounts.push(await exportAccount(uids[i], withReceipts));
    }
    const data = { kind: BACKUP_KIND, version: 1, exportedAt: new Date().toISOString(), exportedBy: S.user.email, includesReceipts: withReceipts, accounts };
    const name = all ? "All_users" : (S.viewProfile?.name || "account").replace(/[^\w]+/g, "_");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
    a.download = `Expense_backup_${name}_${todayStr()}.json`; a.click();
    const n = accounts.reduce((t, x) => t + x.entries.length, 0);
    toast(`Backup saved: ${accounts.length} account(s), ${n} entries`);
  } catch (err) { console.error(err); toast(friendly(err), 5000); }
  finally { busy(false); }
});

async function writeAll(uid, name, rows, perBatch) {
  for (let i = 0; i < rows.length; i += perBatch) {
    const b = writeBatch(db);
    rows.slice(i, i + perBatch).forEach(({ id, ...rest }) => b.set(doc(db, "users", uid, name, id), revive(rest)));
    await b.commit();
  }
}

$("#bk-file").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  let data;
  try { data = JSON.parse(await f.text()); } catch { toast("That file is not a valid backup"); return; }
  if (data?.kind !== BACKUP_KIND || !Array.isArray(data.accounts) || !data.accounts.length) { toast("That file is not an Expense backup"); return; }

  // Decide where each account in the file goes
  let plan = [];
  if (data.accounts.length === 1) plan = [{ acc: data.accounts[0], uid: S.viewUid }];
  else if (isAdmin()) {
    plan = data.accounts.filter(a => S.users.some(u => u.id === a.uid)).map(a => ({ acc: a, uid: a.uid }));
  } else {
    const mine = data.accounts.find(a => a.uid === S.user.uid);
    if (mine) plan = [{ acc: mine, uid: S.user.uid }];
  }
  if (!plan.length) { toast("No matching accounts in this backup"); return; }
  const skipped = data.accounts.length - plan.length;
  const lines = plan.map(p => {
    const target = p.uid === S.viewUid ? (S.viewProfile?.name || "this account") : userName(p.uid);
    return `• ${p.acc.profile?.name || p.acc.uid} → ${target}: ${p.acc.books?.length || 1} books, ${p.acc.heads?.length || 0} heads, ${p.acc.entries?.length || 0} entries, ${p.acc.receipts?.length || 0} receipts`;
  });
  if (!confirm(`Restore this backup (${new Date(data.exportedAt).toLocaleString("en-GB")})?\n\n${lines.join("\n")}${skipped ? `\n\n${skipped} account(s) in the file have no matching user and will be skipped.` : ""}\n\nEntries with the same ID are updated; nothing is duplicated.`)) return;

  try {
    for (let i = 0; i < plan.length; i++) {
      const { acc, uid } = plan[i], step = `(${i + 1}/${plan.length})`;
      busy(true, `Restoring heads & entries ${step}…`);
      await writeAll(uid, "books", acc.books || [], 400);
      await writeAll(uid, "heads", acc.heads || [], 400);
      await writeAll(uid, "entries", acc.entries || [], 400);
      const rec = acc.receipts || [];
      for (let r = 0; r < rec.length; r++) {
        busy(true, `Restoring receipts ${step} ${r + 1}/${rec.length}…`);
        const { id, ...rest } = rec[r];
        await setDoc(doc(db, "users", uid, "receipts", id), revive(rest));
      }
      if (acc.settings) await setDoc(doc(db, "users", uid, "settings", "main"), acc.settings, { merge: true });
      const p = acc.profile || {};
      if (isAdmin()) await updateDoc(doc(db, "users", uid), { openingBalance: +p.openingBalance || 0, ...(p.name ? { name: p.name } : {}) });
      else await updateDoc(doc(db, "users", uid), { openingBalance: +p.openingBalance || 0 });
    }
    toast(`Restore complete${skipped ? ` (${skipped} skipped)` : ""}`, 4000);
  } catch (err) { console.error(err); toast("Restore stopped: " + friendly(err), 6000); }
  finally { busy(false); }
});

/* ---------------- bill reading (Gemini via Firebase AI Logic) ---------------- */
["e-amount", "e-date", "e-head", "e-mode", "e-note", "e-ref"].forEach(id =>
  ["input", "change"].forEach(ev => $("#" + id).addEventListener(ev, e => { if (e.isTrusted) S.touched?.add(id); })));
$$("#entry-type button").forEach(b => b.addEventListener("click", () => S.touched?.add("type")));

function setAiStatus(html, cls = "") {
  const el = $("#ai-status"); el.className = "ai-status " + cls; el.innerHTML = html;
  el.classList.toggle("hidden", !html);
}

let aiModule = null;
async function getModel(name) {
  if (!aiModule) aiModule = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-ai.js");
  const { getAI, getGenerativeModel, GoogleAIBackend, Schema } = aiModule;
  const ai = getAI(app, { backend: new GoogleAIBackend() });
  const schema = Schema.object({
    properties: {
      isBill: Schema.boolean(),
      amount: Schema.number(),
      date: Schema.string(),
      vendor: Schema.string(),
      billNo: Schema.string(),
      description: Schema.string(),
      vat: Schema.number(),
      paymentMode: Schema.enumString({ enum: ["Cash", "Bank transfer", "Card", "Cheque", "Other"] }),
      type: Schema.enumString({ enum: ["expense", "income"] }),
      head: Schema.string()
    },
    optionalProperties: ["amount", "date", "vendor", "billNo", "description", "vat", "paymentMode", "type", "head"]
  });
  return getGenerativeModel(ai, { model: name, generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0 } });
}

async function readBill(rec) {
  const want = ["e-amount", "e-date", "e-head", "e-mode", "e-note", "e-ref"].filter(id => !S.touched.has(id));
  if (!want.length) return;
  const heads = S.heads.map(h => `${h.type}: ${h.name}`).join("\n");
  const prompt = `You read bills, receipts and invoices (any language, e.g. English, Arabic, Hindi) for an expense app. The account currency is ${CUR}. Today is ${todayStr()}.
Extract:
- amount: the FINAL total actually paid, including VAT (not the subtotal, not VAT alone), as a number.
- date: bill date as YYYY-MM-DD (bills from UAE/India use day/month order).
- vendor: shop or company name, short.
- billNo: invoice / receipt / bill number if printed.
- description: 3-8 words on what was bought, e.g. "Diesel 40L" or "Lunch for site team".
- vat: VAT amount if shown.
- paymentMode: Card if card/visa/mastercard payment shown, Cash if cash, else omit.
- type: "expense" for purchases; "income" only if it is clearly money received (e.g. a cash receipt voucher given to us).
- head: pick the single best matching name from this list (same type), exactly as written:
${heads}
Set isBill=false and omit other fields if the image is not a bill or receipt.`;
  const part = { inlineData: { mimeType: rec.mime, data: rec.data.split(",")[1] } };
  const editingAt = S.editing, openedFor = $("#entry-modal");
  setAiStatus(`<span class="dot-spin"></span> Reading bill…`);
  let out = null, lastErr = null;
  for (const name of AI_MODELS) {
    try {
      const model = await getModel(name);
      const res = await model.generateContent([prompt, part]);
      out = JSON.parse(res.response.text());
      break;
    } catch (err) { lastErr = err; console.warn("AI", name, err); }
  }
  if (openedFor.classList.contains("hidden") || S.editing !== editingAt) return; // form closed meanwhile
  if (!out) {
    const msg = String(lastErr?.message || lastErr || "");
    setAiStatus(/app.?check|recaptcha|attest/i.test(msg) ? "Couldn't read the bill (security check failed). Fill in manually."
      : /quota|429|exhaust/i.test(msg) ? "Bill reading is busy right now. Fill in manually or try again later."
      : "Couldn't read the bill. Fill in manually.", "warn");
    $("#ai-status").insertAdjacentHTML("beforeend", `<small class="ai-err">${esc((lastErr?.code ? lastErr.code + ": " : "") + msg).slice(0, 220)}</small>`);
    return;
  }
  if (out.isBill === false) { setAiStatus("This doesn't look like a bill — nothing filled.", "warn"); return; }
  const filled = [];
  const fill = (id, val, label) => {
    if (val === undefined || val === null || val === "" || S.touched.has(id)) return;
    const el = $("#" + id);
    if (el.tagName === "SELECT" && ![...el.options].some(o => o.value === val)) return;
    el.value = val; el.classList.add("ai-filled"); filled.push(label);
  };
  if (out.type && !S.touched.has("type") && S.entryType !== "transfer" && out.type !== S.entryType) setEntryType(out.type);
  if (out.amount > 0) fill("e-amount", Math.round(out.amount * 100) / 100, "amount");
  if (/^\d{4}-\d{2}-\d{2}$/.test(out.date || "") && out.date <= todayStr()) fill("e-date", out.date, "date");
  if (out.head && S.entryType !== "transfer") {
    const h = S.heads.find(x => x.type === S.entryType && x.name.toLowerCase() === out.head.toLowerCase().replace(/^(income|expense):\s*/, ""));
    if (h) fill("e-head", h.id, "head");
  }
  fill("e-mode", out.paymentMode, "payment mode");
  const desc = [out.vendor, out.description].filter(Boolean).join(" – ") + (out.vat ? ` (VAT ${money(out.vat)})` : "");
  fill("e-note", desc, "description");
  fill("e-ref", out.billNo, "bill no");
  setAiStatus(filled.length ? `✓ Filled from bill: ${filled.join(", ")}. Please check before saving.` : "Bill read — your entries were kept.", "ok");
}

/* ---------------- keyboard-aware sheet ---------------- */
// Keep modals sized to the visible area so the form and Save button stay above the phone keyboard.
function fitViewport() {
  const vv = window.visualViewport; if (!vv) return;
  document.documentElement.style.setProperty("--vvh", vv.height + "px");
  document.documentElement.style.setProperty("--vvt", vv.offsetTop + "px");
}
if (window.visualViewport) {
  visualViewport.addEventListener("resize", fitViewport);
  visualViewport.addEventListener("scroll", fitViewport);
  fitViewport();
}
document.addEventListener("focusin", e => {
  if (!e.target.closest(".modal") || !e.target.matches("input,select,textarea")) return;
  setTimeout(() => { fitViewport(); e.target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" }); }, 300);
});

/* ---------------- PWA ---------------- */
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
