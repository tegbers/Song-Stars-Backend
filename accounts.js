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

/* What the app shows the user: paid balance + free songs left. */
async function statusFor(userId, fingerprint) {
  const { data: prof } = await db().from("profiles").select("paid_balance, free_used").eq("user_id", userId).maybeSingle();
  let devUsed = 0;
  if (fingerprint) {
    const { data: dev } = await db().from("device_usage").select("free_used").eq("fingerprint", String(fingerprint).slice(0, 200)).maybeSingle();
    devUsed = dev ? dev.free_used : 0;
  }
  const accUsed = prof ? prof.free_used : 0;
  return {
    paidBalance: prof ? prof.paid_balance : 0,
    freeRemaining: Math.max(0, FREE_SONGS - Math.max(accUsed, devUsed)),
    freeSongs: FREE_SONGS,
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
/* Idempotently mark an order paid and credit its qty to the buyer. */
async function markOrderPaidAndCredit({ checkoutId, orderId }) {
  let q = db().from("orders").select("*");
  q = checkoutId ? q.eq("yoco_checkout_id", checkoutId) : q.eq("id", orderId);
  const { data: order } = await q.maybeSingle();
  if (!order || order.status === "paid") return order || null;
  await db().from("orders").update({ status: "paid", paid_at: new Date().toISOString() }).eq("id", order.id);
  await db().rpc("add_balance", { p_user: order.user_id, p_qty: order.qty });
  return order;
}

module.exports = {
  accountsEnabled, getUser, requireAuth,
  claimSong, releaseSong, statusFor, recordSong, listSongs,
  createOrder, attachCheckout, findOrder, markOrderPaidAndCredit,
  FREE_SONGS,
};
