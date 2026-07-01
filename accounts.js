/* ============================================================
   SONG STARS — accounts + anti-abuse (server-side source of truth)
   ------------------------------------------------------------
   Talks to Supabase (auth + Postgres). Free songs and paid
   balance live HERE, never in the browser, so the limit is real.

   Needs env: SUPABASE_URL, SUPABASE_SERVICE_KEY  (service/secret key).
   If those are unset, accountsEnabled() is false and the app runs
   in the old open mode (handy for local dev).
   ============================================================ */
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const FREE_SONGS = Number(process.env.FREE_SONGS || 2);

let _supa = null;
function db() {
  if (!_supa) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_KEY");
    _supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return _supa;
}
const accountsEnabled = () => !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);

/* Verify a Supabase access token -> user object, or null. */
async function getUser(token) {
  if (!token) return null;
  try {
    const { data, error } = await db().auth.getUser(token);
    if (error || !data || !data.user) return null;
    return data.user;
  } catch { return null; }
}

/* Express middleware: require a signed-in user (Bearer <supabase access token>). */
async function requireAuth(req, res, next) {
  if (!accountsEnabled()) { req.user = null; return next(); } // dev/open mode
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : null;
  const user = await getUser(token);
  if (!user) return res.status(401).json({ error: "Please sign in to continue." });
  req.user = user;
  try {
    await db().from("profiles").upsert(
      { user_id: user.id, email: user.email || null, phone: user.phone || null },
      { onConflict: "user_id", ignoreDuplicates: true }
    );
  } catch (e) { console.error("profile upsert:", e.message); }
  next();
}

/* Atomically claim ONE song. Returns 'paid' | 'free' | 'none'. */
async function claimSong(userId, fingerprint) {
  const { data, error } = await db().rpc("claim_song", {
    p_user: userId, p_fingerprint: (fingerprint || "none").slice(0, 200), p_free_max: FREE_SONGS,
  });
  if (error) throw new Error("claim_song: " + error.message);
  return data; // 'paid' | 'free' | 'none'
}

/* Give a claimed song back if generation fails (don't punish the user for our error). */
async function releaseSong(userId, fingerprint, mode) {
  if (mode !== "paid" && mode !== "free") return;
  try {
    await db().rpc("release_song", { p_user: userId, p_fingerprint: (fingerprint || "none").slice(0, 200), p_mode: mode });
  } catch (e) { console.error("release_song:", e.message); }
}

/* What the app shows the user: paid balance + free songs + Studio Pass. */
async function statusFor(userId, fingerprint) {
  const { data: prof } = await db().from("profiles")
    .select("paid_balance, free_used, pass_until, pass_month_used, pass_month_start")
    .eq("user_id", userId).maybeSingle();
  let devUsed = 0;
  if (fingerprint) {
    const { data: dev } = await db().from("device_usage").select("free_used").eq("fingerprint", String(fingerprint).slice(0, 200)).maybeSingle();
    devUsed = dev ? dev.free_used : 0;
  }
  const accUsed = prof ? prof.free_used : 0;
  // Studio Pass: active if pass_until is in the future. Monthly fair-use
  // counter rolls every 30 days, so if the window has lapsed, treat used as 0.
  const now = Date.now();
  const passUntil = prof && prof.pass_until ? new Date(prof.pass_until).getTime() : 0;
  const passActive = passUntil > now;
  let monthUsed = prof ? (prof.pass_month_used || 0) : 0;
  const monthStart = prof && prof.pass_month_start ? new Date(prof.pass_month_start).getTime() : 0;
  if (!monthStart || monthStart < now - 30 * 864e5) monthUsed = 0;
  return {
    paidBalance: prof ? prof.paid_balance : 0,
    freeRemaining: Math.max(0, FREE_SONGS - accUsed),
    freeSongs: FREE_SONGS,
    passActive,
    passUntil: passActive ? new Date(passUntil).toISOString() : null,
    passRemaining: passActive ? Math.max(0, PASS_CAP - monthUsed) : 0,
    passCap: PASS_CAP,
  };
}

/* ============================================================
   PERMANENT SONG LIBRARY
   ------------------------------------------------------------
   Suno/Apiframe hand us a TEMPORARY CDN link that expires, so a
   saved track would vanish. The moment a song finishes we pull
   our OWN copy of the audio + cover into Supabase Storage and
   store those permanent URLs. After that the track can never
   disappear: it survives closing the app, new devices, re-login.
   ============================================================ */
const SONGS_BUCKET = process.env.SONGS_BUCKET || "songs";
let _bucketReady = false;

/* Make sure the public storage bucket exists (runs once). */
async function ensureBucket() {
  if (_bucketReady) return;
  try {
    const { data } = await db().storage.getBucket(SONGS_BUCKET);
    if (!data) {
      await db().storage.createBucket(SONGS_BUCKET, { public: true });
    }
  } catch (e) {
    // createBucket throws if it already exists — that's fine.
    if (!/exist/i.test(e.message || "")) console.error("ensureBucket:", e.message);
  }
  _bucketReady = true;
}

/* Download a remote file and upload it into our bucket. Returns
   { path, url } of the permanent copy, or null if anything fails
   (caller then falls back to the original link — never lose a song). */
async function mirrorToStorage(remoteUrl, destPath, contentType) {
  if (!remoteUrl) return null;
  try {
    await ensureBucket();
    const resp = await fetch(remoteUrl);
    if (!resp.ok) throw new Error("download " + resp.status);
    const buf = Buffer.from(await resp.arrayBuffer());
    const { error } = await db().storage.from(SONGS_BUCKET).upload(destPath, buf, {
      contentType: contentType || resp.headers.get("content-type") || "application/octet-stream",
      upsert: true,
    });
    if (error) throw new Error(error.message);
    const { data } = db().storage.from(SONGS_BUCKET).getPublicUrl(destPath);
    return { path: destPath, url: data.publicUrl };
  } catch (e) {
    console.error("mirrorToStorage:", e.message);
    return null;
  }
}

/* Save a finished song permanently. Mirrors audio + cover into our
   own storage, then writes the row with the PERMANENT urls. Returns
   the saved record (with permanent audio_url/image_url) or null. */
async function recordSong(userId, { title, genre, names, audioUrl, imageUrl, isFree }) {
  try {
    const id = require("crypto").randomUUID();
    const folder = `${userId}/${id}`;
    const audio = await mirrorToStorage(audioUrl, `${folder}/track.mp3`, "audio/mpeg");
    const cover = await mirrorToStorage(imageUrl, `${folder}/cover.jpg`, "image/jpeg");
    const row = {
      id,
      user_id: userId,
      title: title || null,
      genre: genre || null,
      names: names || null,
      audio_url: (audio && audio.url) || audioUrl || null,   // permanent if we got it, else original
      image_url: (cover && cover.url) || imageUrl || null,
      audio_path: (audio && audio.path) || null,
      image_path: (cover && cover.path) || null,
      is_free: !!isFree,
    };
    const { data, error } = await db().from("songs").insert(row).select("id, title, genre, names, audio_url, image_url, is_free, created_at").single();
    if (error) throw new Error(error.message);
    return data;
  } catch (e) { console.error("recordSong:", e.message); return null; }
}

/* Delete one of the user's songs: remove the stored files, then the row.
   Only ever deletes a row that belongs to this user. Returns true on success. */
async function deleteSong(userId, songId) {
  const { data: song, error: selErr } = await db().from("songs")
    .select("id, user_id, audio_path, image_path").eq("id", songId).maybeSingle();
  if (selErr) throw new Error("deleteSong: " + selErr.message);
  if (!song || song.user_id !== userId) return false;     // not theirs, or already gone
  const paths = [song.audio_path, song.image_path].filter(Boolean);
  if (paths.length) {
    try { await db().storage.from(SONGS_BUCKET).remove(paths); }
    catch (e) { console.error("deleteSong storage:", e.message); }
  }
  const { error } = await db().from("songs").delete().eq("id", songId).eq("user_id", userId);
  if (error) throw new Error("deleteSong: " + error.message);
  return true;
}

/* Permanently delete a user's account and ALL their data (App Store
   Guideline 5.1.1(v) — in-app account deletion). Removes stored files,
   their rows across our tables, then the auth user itself. Best-effort
   per table so one failure doesn't strand the rest; the auth user is
   removed last so the account truly disappears. */
async function deleteAccount(userId) {
  if (!userId) return false;
  // 1) Remove this user's stored audio + cover files from storage.
  try {
    const { data: songs } = await db().from("songs")
      .select("audio_path, image_path").eq("user_id", userId);
    const paths = (songs || []).flatMap(s => [s.audio_path, s.image_path]).filter(Boolean);
    if (paths.length) { try { await db().storage.from(SONGS_BUCKET).remove(paths); } catch (e) { console.error("deleteAccount storage:", e.message); } }
  } catch (e) { console.error("deleteAccount songs lookup:", e.message); }
  // 2) Delete their rows from our tables (best-effort).
  for (const t of ["songs", "house_bands", "orders", "apple_transactions", "profiles"]) {
    try { await db().from(t).delete().eq("user_id", userId); }
    catch (e) { console.error(`deleteAccount ${t}:`, e.message); }
  }
  // 3) Delete the auth user itself (this is the part that truly removes the account).
  try {
    const { error } = await db().auth.admin.deleteUser(userId);
    if (error) throw new Error(error.message);
  } catch (e) { console.error("deleteAccount auth:", e.message); throw new Error("deleteAccount: " + e.message); }
  return true;
}

/* The user's permanent library, newest first. */
async function listSongs(userId, limit = 200) {
  const { data, error } = await db().from("songs")
    .select("id, title, genre, names, audio_url, image_url, is_free, created_at")
    .eq("user_id", userId).order("created_at", { ascending: false }).limit(limit);
  if (error) throw new Error("listSongs: " + error.message);
  return data || [];
}

/* ---------- Orders (payments credited server-side only) ---------- */
async function createOrder({ userId, packId, qty, amountCents }) {
  const { data, error } = await db().from("orders")
    .insert({ user_id: userId, pack_id: packId, qty, amount_cents: amountCents, status: "pending" })
    .select("id").single();
  if (error) throw new Error("createOrder: " + error.message);
  return data.id;
}
async function attachCheckout(orderId, checkoutId) {
  if (!checkoutId) return;
  await db().from("orders").update({ yoco_checkout_id: checkoutId }).eq("id", orderId);
}
async function findOrder({ orderId, userId, checkoutId }) {
  let q = db().from("orders").select("*");
  q = checkoutId ? q.eq("yoco_checkout_id", checkoutId) : q.eq("id", orderId);
  if (userId) q = q.eq("user_id", userId);
  const { data } = await q.maybeSingle();
  return data || null;
}
/* Idempotently mark an order paid, then grant it: a Studio Pass order
   (pack_id 'studiopass') adds one pass-month; any other order credits its qty. */
async function markOrderPaidAndCredit({ checkoutId, orderId }) {
  let q = db().from("orders").select("*");
  q = checkoutId ? q.eq("yoco_checkout_id", checkoutId) : q.eq("id", orderId);
  const { data: order } = await q.maybeSingle();
  if (!order || order.status === "paid") return order || null;
  await db().from("orders").update({ status: "paid", paid_at: new Date().toISOString() }).eq("id", order.id);
  if (order.pack_id === "studiopass") {
    await db().rpc("extend_pass", { p_user: order.user_id, p_days: 31 });
  } else {
    await db().rpc("add_balance", { p_user: order.user_id, p_qty: order.qty });
  }
  return order;
}

/* ============================================================
   STUDIO PASS — entitlement (monthly "up to N songs")
   ------------------------------------------------------------
   An active pass lets a user make songs without spending paid
   credits or free songs, up to a fair-use cap per pass-month.
   ============================================================ */
const PASS_CAP = Number(process.env.PASS_MONTHLY_CAP || 30);

/* Try to claim ONE song under an active Studio Pass. 'pass' | 'none'. */
async function claimPassSong(userId) {
  const { data, error } = await db().rpc("claim_pass_song", { p_user: userId, p_cap: PASS_CAP });
  if (error) throw new Error("claim_pass_song: " + error.message);
  return data; // 'pass' | 'none'
}
/* Refund a pass-song if our generation fails. */
async function releasePassSong(userId) {
  try { await db().rpc("release_pass_song", { p_user: userId }); }
  catch (e) { console.error("release_pass_song:", e.message); }
}

/* ============================================================
   APPLE IN-APP PURCHASE — verify + grant (server-side only)
   ------------------------------------------------------------
   iOS app buys via StoreKit 2 and sends us the signed transaction
   (a JWS). We decode it (and verify its signature in production),
   map the productId -> reward, and grant it ONCE (apple_transactions
   row = replay protection). Credits use add_balance; Studio Pass
   sets pass_until to Apple's expiry date (Apple owns renewals).

   Product IDs must match what you create in App Store Connect.
   ============================================================ */
const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID || "store.bandinyourhand";
// 'full' = verify signature, FAIL CLOSED (default, production-safe).
// 'decodeonly' = skip verification — SANDBOX BRING-UP ONLY, never in production.
const APPLE_VERIFY = (process.env.APPLE_VERIFY || "full");
const APPLE_ROOT_CERT_DIR = process.env.APPLE_ROOT_CERT_DIR || require("path").join(__dirname, "apple-certs");

const IAP_PRODUCTS = {
  // One-off credit consumables (match the web PACKS: single/three/album)
  "byh.credit.single": { kind: "credits", qty: 1 },
  "byh.credit.three":  { kind: "credits", qty: 3 },
  "byh.credit.album":  { kind: "credits", qty: 7 },
  // Studio Pass — auto-renewable subscription ("up to N songs/month")
  "byh.studiopass.monthly": { kind: "pass" },
};
// Maps the app's web pack id -> the Apple product id created in App Store Connect.
const PACK_TO_APPLE = { single: "byh.credit.single", three: "byh.credit.three", album: "byh.credit.album" };

/* Decode the JWS payload (middle segment). No signature check. */
function decodeJwsPayload(jws) {
  const parts = String(jws || "").split(".");
  if (parts.length !== 3) throw new Error("malformed signed transaction");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

/* Verify + decode a StoreKit 2 signed transaction. Uses Apple's official
   library for full signature verification when it's installed and configured;
   otherwise falls back to decode-only (fine for sandbox bring-up, NOT for
   production — set APPLE_VERIFY=full once the lib + root certs are wired). */
async function verifyAppleJws(jws) {
  // Sandbox escape hatch ONLY. Never set APPLE_VERIFY=decodeonly in production.
  if (APPLE_VERIFY === "decodeonly") {
    console.warn("APPLE_VERIFY=decodeonly — signature NOT checked (sandbox only)");
    return { payload: decodeJwsPayload(jws), verified: false };
  }
  // Production path: cryptographically verify the signed transaction against Apple's
  // root certs. Any problem (missing certs, bad signature, wrong bundle) THROWS, so
  // grantApplePurchase never credits an unverified/forged transaction.
  const { SignedDataVerifier, Environment } = require("@apple/app-store-server-library");
  const fs = require("fs");
  const path = require("path");
  let roots;
  try {
    roots = fs.readdirSync(APPLE_ROOT_CERT_DIR)
      .filter((f) => /\.(cer|pem|der|crt)$/i.test(f))
      .map((f) => fs.readFileSync(path.join(APPLE_ROOT_CERT_DIR, f)));
  } catch (e) {
    throw new Error("Apple root certs missing (" + APPLE_ROOT_CERT_DIR + ") — cannot verify purchase. See apple-certs/README.md");
  }
  if (!roots.length) throw new Error("No Apple root certs in " + APPLE_ROOT_CERT_DIR + " — see apple-certs/README.md");
  const env = (process.env.APPLE_ENVIRONMENT === "production") ? Environment.PRODUCTION : Environment.SANDBOX;
  const appAppleId = Number(process.env.APPLE_APP_APPLE_ID || 6784852955);
  const verifier = new SignedDataVerifier(roots, true, env, APPLE_BUNDLE_ID, appAppleId);
  const payload = await verifier.verifyAndDecodeTransaction(jws); // throws on invalid signature/chain
  return { payload, verified: true };
}

/* Verify an Apple purchase and grant it. Idempotent on transactionId. */
async function grantApplePurchase(userId, jws) {
  const { payload, verified } = await verifyAppleJws(jws);
  // Never grant an unverified purchase (the only unverified case is the explicit
  // sandbox decodeonly mode, which must not be used in production).
  if (!verified && APPLE_VERIFY !== "decodeonly") throw new Error("purchase could not be verified");
  if (payload.bundleId && payload.bundleId !== APPLE_BUNDLE_ID) throw new Error("bundle id mismatch");
  const txId = String(payload.transactionId);
  const productId = payload.productId;
  const prod = IAP_PRODUCTS[productId];
  if (!prod) throw new Error("unknown product: " + productId);

  // already granted? -> idempotent no-op (StoreKit may re-deliver)
  const { data: existing } = await db().from("apple_transactions")
    .select("transaction_id").eq("transaction_id", txId).maybeSingle();
  if (existing) return { ok: true, alreadyGranted: true, kind: prod.kind, productId };

  const expiresIso = payload.expiresDate ? new Date(Number(payload.expiresDate)).toISOString() : null;
  if (prod.kind === "credits") {
    await db().rpc("add_balance", { p_user: userId, p_qty: prod.qty });
  } else if (prod.kind === "pass") {
    const until = expiresIso || new Date(Date.now() + 31 * 864e5).toISOString();
    await db().rpc("set_pass_until", { p_user: userId, p_until: until });
  }
  await db().from("apple_transactions").insert({
    transaction_id: txId,
    original_transaction_id: payload.originalTransactionId ? String(payload.originalTransactionId) : null,
    user_id: userId, product_id: productId, kind: prod.kind, qty: prod.qty || 0,
    expires_at: expiresIso,
  });
  return { ok: true, kind: prod.kind, productId, verified };
}

/* ============================================================
   THE CHARTS — a single-player "chart run", never a marketplace.
   You "Release My Song"; it debuts on the chart and rises or slips.
   You climb by SHARING (shares + reach), plus a fixed dash of chance
   and freshness. NO public streaming — nobody hears anyone else's
   song; a shared link shows a landing CARD only. Every released song
   has a position; the Top 40 is just the visible tip.
   Stays dark until CHARTS_ENABLED=true.
   ============================================================ */
const CHARTS_ENABLED = process.env.CHARTS_ENABLED === "true";

/* ---- House Bands: a public artist name per creator (never their login) ---- */
async function getHouseBand(userId) {
  const { data } = await db().from("house_bands").select("name").eq("user_id", userId).maybeSingle();
  return data ? data.name : null;
}
async function setHouseBand(userId, name) {
  name = (name || "").trim().replace(/\s+/g, " ").slice(0, 40);
  if (!name) throw new Error("Please give your House Band a name.");
  const { error } = await db().from("house_bands").upsert({ user_id: userId, name }, { onConflict: "user_id" });
  if (error) throw new Error(error.message);
  return name;
}

/* ---- Release a song to the charts ("Release My Song") ---- */
async function releaseToCharts(userId, songId, { releaseTitle, category, kind } = {}) {
  const { data: song } = await db().from("songs")
    .select("id, user_id, protected, released, title").eq("id", songId).maybeSingle();
  if (!song || song.user_id !== userId) throw new Error("not your song");
  if (song.protected) throw new Error("This song is protected and can't be released.");
  const patch = {
    released: true,
    release_title: (releaseTitle || song.title || "Untitled").toString().slice(0, 80),
    category: category || null,
    kind: kind === "album" ? "album" : "single",
  };
  if (!song.released) patch.debuted_at = new Date().toISOString();
  const { error } = await db().from("songs").update(patch).eq("id", songId);
  if (error) throw new Error(error.message);
  const pos = await positionOf(songId, patch.kind);
  return { id: songId, position: pos.position, total: pos.total, kind: patch.kind };
}

/* ---- Share / reach: the climb levers ---- */
async function recordShare(songId) { try { await db().rpc("record_share", { p_song: songId }); } catch (e) { console.error("record_share:", e.message); } }
async function recordReach(songId) { try { await db().rpc("record_reach", { p_song: songId }); } catch (e) { console.error("record_reach:", e.message); } }

/* ---- Scoring (computed on read; no cron needed for v1) ---- */
function _daysSince(iso) { if (!iso) return 999; return (Date.now() - new Date(iso).getTime()) / 864e5; }
function scoreOf(s) {
  const fresh = Math.max(0, 8 - _daysSince(s.debuted_at) * 0.8); // new releases break in, fade over ~10 days
  const momentum = (s.shares || 0) * 3 + (s.reach || 0);          // sharing is the dominant lever
  const luck = Number(s.chance_seed || 0) * 4;                    // a fixed dash of chance per song
  return momentum + luck + fresh;
}
async function rankedSongs(kind) {
  let q = db().from("songs")
    .select("id, user_id, title, release_title, genre, image_url, shares, reach, chance_seed, debuted_at, peak_position, kind")
    .eq("released", true);
  if (kind) q = q.eq("kind", kind);
  const { data, error } = await q.limit(2000);
  if (error) throw new Error(error.message);
  const rows = (data || []).map((s) => ({ ...s, _score: scoreOf(s) }));
  rows.sort((a, b) => b._score - a._score);
  return rows;
}
async function _bandNames(userIds) {
  const ids = [...new Set(userIds)];
  const map = {};
  if (ids.length) {
    const { data } = await db().from("house_bands").select("user_id, name").in("user_id", ids);
    (data || []).forEach((b) => { map[b.user_id] = b.name; });
  }
  return map;
}

/* The Top 40 (or fewer). kind: 'single' | 'album'. */
async function listCharts(kind = "single", limit = 40) {
  const rows = await rankedSongs(kind === "album" ? "album" : "single");
  const top = rows.slice(0, limit);
  const bands = await _bandNames(top.map((r) => r.user_id));
  return top.map((s, i) => ({
    position: i + 1,
    title: s.release_title || s.title,
    band: bands[s.user_id] || "A House Band",
    genre: s.genre, image: s.image_url, shares: s.shares || 0,
  }));
}

/* A single song's live position within its chart. */
async function positionOf(songId, kind) {
  const rows = await rankedSongs(kind || "single");
  const idx = rows.findIndex((r) => r.id === songId);
  return { position: idx >= 0 ? idx + 1 : null, total: rows.length };
}

/* Achievement badges for a released song, from its live position + shares. */
function badgesFor(pos, shares) {
  const b = [];
  if (pos === 1) b.push("👑 Number One");
  else if (pos && pos <= 5) b.push("🏆 Top 5");
  else if (pos && pos <= 10) b.push("🔟 Top 10");
  else if (pos && pos <= 40) b.push("⭐ Top 40");
  if ((shares || 0) >= 25) b.push("🔥 On Fire");
  else if ((shares || 0) >= 5) b.push("📈 Climbing");
  return b;
}

/* The creator's own released songs with their live positions + badges. */
async function myReleases(userId) {
  const singles = await rankedSongs("single");
  const albums = await rankedSongs("album");
  const pick = (rows) => rows.map((r, i) => ({ r, pos: i + 1 })).filter((x) => x.r.user_id === userId);
  const mk = (x) => ({ id: x.r.id, title: x.r.release_title || x.r.title, position: x.pos, kind: x.r.kind, shares: x.r.shares || 0, image: x.r.image_url, peak: x.r.peak_position || x.pos, badges: badgesFor(x.pos, x.r.shares) });
  const list = [...pick(singles).map(mk), ...pick(albums).map(mk)];
  if (list.length) list[0].badges = ["🎬 First Release", ...list[0].badges].filter((b, i, a) => a.indexOf(b) === i);
  return list;
}

/* Report a song for review. */
async function reportSong(songId, reporterId, reason) {
  await db().from("song_reports").insert({ song_id: songId, reporter_id: reporterId || null, reason: (reason || "").slice(0, 500) });
}

/* Public landing card for a shared link — NO audio (no public streaming).
   Viewing one counts as 'reach' (a real climb signal). */
async function getPublicSong(songId) {
  const { data: s } = await db().from("songs")
    .select("id, user_id, title, release_title, genre, image_url, released, kind").eq("id", songId).maybeSingle();
  if (!s || !s.released) return null;
  await recordReach(songId);
  const pos = await positionOf(songId, s.kind);
  const band = await getHouseBand(s.user_id);
  return { id: s.id, title: s.release_title || s.title, band: band || "A House Band", genre: s.genre, image: s.image_url, position: pos.position, kind: s.kind };
}

/* The weekly Hit Parade story (computed on read). */
async function hitParade() {
  const rows = await rankedSongs("single");
  const top = rows.slice(0, 40);
  const bands = await _bandNames(top.map((r) => r.user_id));
  const card = (s, i) => (s ? { position: i + 1, title: s.release_title || s.title, band: bands[s.user_id] || "A House Band", image: s.image_url } : null);
  let highestNew = null;
  top.forEach((s, i) => { if (_daysSince(s.debuted_at) <= 7 && !highestNew) highestNew = { ...card(s, i) }; });
  return {
    numberOne: card(top[0], 0),
    highestNewEntry: highestNew,
    topTen: top.slice(0, 10).map((s, i) => card(s, i)),
  };
}

module.exports = {
  accountsEnabled, getUser, requireAuth,
  claimSong, releaseSong, statusFor, recordSong, listSongs, deleteSong, deleteAccount,
  createOrder, attachCheckout, findOrder, markOrderPaidAndCredit,
  claimPassSong, releasePassSong, grantApplePurchase,
  getHouseBand, setHouseBand, releaseToCharts, recordShare, recordReach,
  listCharts, positionOf, myReleases, reportSong, getPublicSong, hitParade,
  IAP_PRODUCTS, PASS_CAP, FREE_SONGS, CHARTS_ENABLED,
};
