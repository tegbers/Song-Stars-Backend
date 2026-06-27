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
    freeRemaining: Math.max(0, FREE_SONGS - Math.max(accUsed, devUsed)),
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
async function findOrder({ orderId, userId }) {
  let q = db().from("orders").select("*").eq("id", orderId);
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
const APPLE_VERIFY = (process.env.APPLE_VERIFY || "auto"); // 'full' | 'decodeonly' | 'auto'

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
  if (APPLE_VERIFY !== "decodeonly") {
    try {
      const { SignedDataVerifier, Environment } = require("@apple/app-store-server-library");
      const fs = require("fs");
      const certDir = process.env.APPLE_ROOT_CERT_DIR; // folder of Apple root .cer/.pem files
      if (certDir) {
        const roots = fs.readdirSync(certDir).map((f) => fs.readFileSync(require("path").join(certDir, f)));
        const env = (process.env.APPLE_ENVIRONMENT === "production") ? Environment.PRODUCTION : Environment.SANDBOX;
        const appAppleId = Number(process.env.APPLE_APP_APPLE_ID || 6784852955);
        const verifier = new SignedDataVerifier(roots, true, env, APPLE_BUNDLE_ID, appAppleId);
        const payload = await verifier.verifyAndDecodeTransaction(jws);
        return { payload, verified: true };
      }
    } catch (e) {
      if (APPLE_VERIFY === "full") throw new Error("apple verify failed: " + e.message);
      console.warn("apple full-verify unavailable, using decode-only:", e.message);
    }
  }
  return { payload: decodeJwsPayload(jws), verified: false };
}

/* Verify an Apple purchase and grant it. Idempotent on transactionId. */
async function grantApplePurchase(userId, jws) {
  const { payload, verified } = await verifyAppleJws(jws);
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
   CHARTS — social, bragging-rights only (no sales). Songs are
   PRIVATE by default; a creator opts in to "Release to the Charts".
   Stays dark until CHARTS_ENABLED=true (and public-hosting rights
   with Suno/Apiframe are confirmed).
   ============================================================ */
const CHARTS_ENABLED = process.env.CHARTS_ENABLED === "true";

/* Creator opts a song in/out of the public charts. Must own it,
   and it must not be flagged "protected" (about a child / real person). */
async function publishSong(userId, songId, { isPublic, chartTitle }) {
  const { data: song } = await db().from("songs").select("id, user_id, protected").eq("id", songId).maybeSingle();
  if (!song || song.user_id !== userId) throw new Error("not your song");
  if (isPublic && song.protected) throw new Error("This song is protected and can't be released to the charts.");
  const patch = { is_public: !!isPublic };
  if (isPublic) patch.published_at = new Date().toISOString();
  if (chartTitle !== undefined) patch.chart_title = chartTitle || null;
  const { error } = await db().from("songs").update(patch).eq("id", songId);
  if (error) throw new Error(error.message);
  return { id: songId, isPublic: !!isPublic };
}

/* Heart a song (toggle). Returns the new heart count. */
async function toggleHeart(userId, songId) {
  const { data, error } = await db().rpc("toggle_heart", { p_user: userId, p_song: songId });
  if (error) throw new Error(error.message);
  return data;
}

/* Count a play (only public songs increment). */
async function addPlay(songId) {
  try { await db().rpc("add_play", { p_song: songId }); } catch (e) { console.error("add_play:", e.message); }
}

/* Report a song for review. */
async function reportSong(songId, reporterId, reason) {
  await db().from("song_reports").insert({ song_id: songId, reporter_id: reporterId || null, reason: (reason || "").slice(0, 500) });
}

/* A chart. type: 'top' (hearts) | 'new' (recent) | 'played' (plays). */
async function listCharts(type = "top", limit = 40) {
  let q = db().from("songs")
    .select("id, title, chart_title, genre, image_url, audio_url, hearts, plays, published_at")
    .eq("is_public", true);
  if (type === "new") q = q.order("published_at", { ascending: false });
  else if (type === "played") q = q.order("plays", { ascending: false });
  else q = q.order("hearts", { ascending: false });
  const { data, error } = await q.limit(limit);
  if (error) throw new Error(error.message);
  // never expose the creator's identity — bragging rights are about the song
  return (data || []).map((s) => ({
    id: s.id, title: s.chart_title || s.title, genre: s.genre,
    image: s.image_url, url: s.audio_url, hearts: s.hearts, plays: s.plays,
  }));
}

/* One public song's page data (only if it's published). */
async function getPublicSong(songId) {
  const { data: s } = await db().from("songs")
    .select("id, title, chart_title, genre, image_url, audio_url, hearts, plays, is_public")
    .eq("id", songId).maybeSingle();
  if (!s || !s.is_public) return null;
  return { id: s.id, title: s.chart_title || s.title, genre: s.genre, image: s.image_url, url: s.audio_url, hearts: s.hearts, plays: s.plays };
}

module.exports = {
  accountsEnabled, getUser, requireAuth,
  claimSong, releaseSong, statusFor, recordSong, listSongs,
  createOrder, attachCheckout, findOrder, markOrderPaidAndCredit,
  claimPassSong, releasePassSong, grantApplePurchase,
  publishSong, toggleHeart, addPlay, reportSong, listCharts, getPublicSong,
  IAP_PRODUCTS, PASS_CAP, FREE_SONGS, CHARTS_ENABLED,
};
