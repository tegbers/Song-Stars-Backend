/* ============================================================
   SONG STARS — backend (the part users never see)
   ------------------------------------------------------------
   Your app calls THIS server. THIS server talks to Suno and
   returns just an audio URL. Your Suno credentials stay here,
   on the server — never in the browser.

   Two ways to make real songs, switched by PROVIDER in .env:

     PROVIDER=selfhost   → you run the open-source gcui-art/suno-api
                           on your own Suno account (cheapest, but
                           one account = limited concurrency).
     PROVIDER=thirdparty → a paid Suno API provider handles scale
                           (APIPASS, Sunor, EvoLink, Apiframe…).

   Leave PROVIDER unset to run in DEMO mode (returns a sample
   track) so you can test the whole pipe end-to-end for free.
   ============================================================ */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
require("dotenv").config();
const accounts = require("./accounts");

const app = express();
app.use(cors());                 // lock this to your app's domain before launch
app.use(express.json());
app.use(express.urlencoded({ extended: true }));  // PayFast ITN posts form-encoded data

const PROVIDER = (process.env.PROVIDER || "demo").toLowerCase();
const PORT = process.env.PORT || 8787;

/* Interim abuse guard: cap song generations per IP per window (resets on restart).
   A speed bump that stops runaway drain — incl. the private-browser trick, since
   those share one IP — until proper per-account server-side limits exist. */
const RATE = new Map();
const RATE_MAX = Number(process.env.RATE_MAX || 20);
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 60 * 60 * 1000);
function rateOk(ip) {
  const now = Date.now(), r = RATE.get(ip);
  if (!r || now > r.resetAt) { RATE.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS }); return true; }
  if (r.count >= RATE_MAX) return false;
  r.count++; return true;
}
const DEMO_TRACK = "https://cdn.pixabay.com/audio/2022/03/15/audio_8cb749d484.mp3";

/* ============================================================
   STYLE PRESETS  — the secret to good songs.
   Edit these to tune how each vibe sounds. Rich tags = great
   songs; one-word tags = bland songs. Keyed by the vibe/genre
   the user picks in the app.
   ============================================================ */
/* SOUND ONLY. Describe instruments, tempo, groove, arrangement and
   vocal type — NEVER mood, emotion, theme or "family-friendly". The
   VIBE the user picks sets the mood; the STORY sets the meaning. This
   keeps Suno true to the chosen style (Drill stays Drill, Funny stays
   funny) instead of being forced "wholesome / heartfelt / joyful". */
const STYLES = {
  // ---- legacy mood keys (no longer selectable; kept sound-only) ----
  funny: "Comedic pop, bouncy around 120 BPM. Ukulele and acoustic guitar, glockenspiel and xylophone, kazoo, tuba, hand claps and finger snaps, walking bassline, brass stabs, occasional cartoon sound effects. Lead vocal with gang backing vocals doing call-and-response. Clean, modern production.",
  party: "Dance-pop, around 124 BPM, four-on-the-floor kick, punchy claps and snare, plucky synths, sidechained pads, funky bass, risers and build-ups into the chorus. Lead vocal with stacked gang-vocal hooks and crowd chants. Crisp, glossy, radio-ready production.",
  emotional: "Acoustic ballad, slow around 70 BPM. Felt piano, fingerpicked acoustic guitar, strings, warm pads, light brushed drums entering in the second half, glockenspiel. Close lead vocal with soft harmonies, building from quiet verses to a fuller chorus. Organic, spacious production.",
  epic: "Cinematic anthem, around 90 BPM, building from intimate to large. Orchestral strings and brass, taiko and big drums, booming hits, choir 'ahhs', anthemic piano, hybrid-trailer synths and risers. Lead vocal with a stacked choir on the chorus. Polished, wide production.",
  catchy: "Radio pop, around 110 BPM. Plucked synths, clean electric guitar, warm bass, programmed drums with claps and tambourine, piano, whistling and 'oh-oh-oh' hooks. Lead vocal with layered backing vocals, strong pre-chorus lift into a hooky chorus. Clean, modern production.",
  bedtime: "Lullaby, very slow around 60 BPM. Music box and felt piano, warm pads, nylon guitar, harp, celeste, slow strings. Quiet breathy lead vocal almost a whisper, airy 'la-la' harmonies. Minimal, spacious, little or no percussion. Warm, intimate production.",
  cool: "Mid-tempo pop, around 95 BPM. Electric piano, muted funky guitar, round bassline, drums with rim-clicks and soft claps, synth touches, vinyl warmth. Lead vocal with smooth backing harmonies. Clean, warm, contemporary production with space.",
  "sports anthem": "Stadium anthem, around 130 BPM, stomping four-on-the-floor. Stomp-clap drums, power-chord electric guitars, synth brass, driving bass, crowd chants and gang vocals, whistle and air-horn stabs. Lead vocal with a crowd-sized chorus. Punchy, arena-sized production.",
  // ---- genres ----
  pop: "Modern pop, around 112 BPM. Clean electric guitars, synths, snappy drums with claps, piano, layered backing vocals on the chorus. Lead vocal. Clean, polished, radio-ready production.",
  rock: "Pop-rock, driving, around 130 BPM. Power-chord electric guitars, melodic lead-guitar licks, live drums, driving bass, tom fills. Lead vocal with gang-vocal backing shouts on the chorus. Polished modern rock production.",
  gospel: "Gospel, around 100 BPM. Hammond organ, gospel piano, warm bass, live drums with tambourine, brass. Lead vocal with a harmonised choir doing call-and-response and ad-libs, key-change lift near the end. Warm, live, full production.",
  rb: "Contemporary R&B, mid-slow around 75 BPM. Electric piano, mellow guitar, deep round bass, finger-snaps and soft drums, pads, vocal chops. Smooth lead vocal with stacked harmonies and runs. Clean, warm, modern production with space.",
  soul: "Classic soul, vintage Motown/Stax flavour, around 100 BPM. Horn section, electric piano and organ, rhythm guitar, melodic bass, live drums with tambourine. Lead vocal with backing singers and call-and-response. Warm, analog, live-band production.",
  "hip hop": "Hip hop, around 95 BPM. Booming 808 bass, trap hi-hats and snappy snare, melodic synth or piano loop, vocal chops. Rhythmic flow with chanted hooks and call-and-response. Clean, modern, polished hip-hop production.",
  dance: "Electronic dance pop, around 126 BPM, four-on-the-floor kick, punchy claps, plucky and saw synths, risers into a drop-style chorus. Lead vocal with stacked gang-vocal hooks. Crisp, glossy, festival-ready production.",
  trance: "Trance, around 138 BPM. Rolling four-on-the-floor kick, driving offbeat bass, supersaw leads, lush pads, sparkling arpeggios, a breakdown then an energetic drop. Airy reverb-soaked vocal hooks. Wide, polished, festival production.",
  kwaito: "South African kwaito, slow grooving house tempo around 100 BPM. Deep house bassline, synth stabs, log-drum and percussive shakers, spacious claps, hypnotic loop. Chanted call-and-response vocals. Warm, spacious, authentically South African production.",
  amapiano: "South African amapiano, around 112 BPM. Log-drum bassline, airy piano chords, soft shakers, rim-clicks, spacious percussion, vocal chops, atmospheric pads. Lead vocal with breezy harmonies and chanted hooks. Warm, spacious production with deep low-end.",
  afrobeats: "Modern afrobeats, around 105 BPM. Log-drum and percussion, marimba and guitar plucks, warm bass, airy pads, vocal chops. Melodic lead vocal with gang harmonies and chanted hooks. Clean, spacious, modern Afropop production.",
  reggae: "Reggae, around 75 BPM. Off-beat 'skank' guitar and organ bubble, deep round bass, one-drop drums, percussion. Lead vocal with harmonies and chanted hooks. Warm, organic, spacious production.",
  disco: "70s disco, around 120 BPM. Four-on-the-floor kick, syncopated funky bass, wah rhythm guitar, strings, brass stabs, shimmering hi-hats, handclaps. Lead vocal with stacked disco harmonies. Warm, lively, classic disco production.",
  country: "Acoustic country, around 90 BPM. Acoustic guitar, banjo, slide and pedal-steel guitar, fiddle, warm bass, brushed drums. Lead vocal with close harmonies. Warm, organic, polished country production.",
  lullaby: "Lullaby, very slow around 60 BPM. Music box and felt piano, warm pads, nylon guitar, celeste, slow strings. Quiet breathy lead vocal almost a whisper, airy 'la-la' harmonies. Minimal, spacious, little or no percussion. Warm, intimate production.",
  // ---- fun & cinematic ----
  "80s cartoon": "80s Saturday-morning cartoon theme, around 130 BPM. Bright synth brass, arpeggiated synths, gated-reverb drums, slap bass, electric-guitar stabs. Lead vocal with a big anthemic gang-vocal chorus. Punchy retro-80s production.",
  telenovela: "Latin telenovela theme, around 100 BPM. Sweeping strings, Spanish nylon guitar, piano, accordion and bandoneon, soft Latin percussion. Expressive lead vocal with lush strings. Cinematic, lush production.",
  "action movie": "Action-movie score, around 120 BPM. Hybrid orchestra, driving percussion and taiko, brass blasts, distorted synth bass, electric guitar, risers and braams. Strong lead vocal over the score. Big, wide cinematic production.",
  "80s movie theme": "80s movie-theme anthem, around 118 BPM. Gated-reverb drums, bright synths, sax solo, electric guitar, big reverb. Anthemic lead vocal with stacked backing on the chorus. Wide, retro-80s production.",
  "video game": "Video-game theme, chiptune-meets-orchestra, around 140 BPM. Square-wave and saw synth leads, arpeggios, chiptune bleeps, driving synth bass, energetic electronic drums, occasional orchestral hits. Lead vocal with catchy synth hooks. Punchy, bright, game-soundtrack production.",
  "national anthem": "Stately national anthem, slow-to-mid around 80 BPM. Full orchestra, swelling strings, French horns and trumpets, timpani rolls, choir. Proud lead vocal with a grand harmonised choir on the chorus. Wide, ceremonial, orchestral production.",
};
function normStyle(s) { return (s || "").replace(/[^a-z0-9 ]/gi, "").trim().toLowerCase(); }
function styleFor(s) { return STYLES[normStyle(s)] || normStyle(s) || "pop"; }

/* The Vibe is the ONLY mood we add — a short tag matching exactly what
   the user picked, nothing extra layered on. Keyed by normalised vibe. */
const VIBE_MOD = {
  heartfelt: "heartfelt", funny: "funny and playful", feelgood: "feel-good", happy: "happy and upbeat",
  emotional: "emotional", cool: "cool and laid-back", chill: "chilled and mellow", magical: "magical and dreamy",
  epic: "epic and cinematic", "road trip": "driving road-trip energy", party: "party energy",
  silly: "silly and goofy", hopeful: "hopeful and uplifting", romantic: "romantic", bedtime: "soft and sleepy",
  // legacy keys
  sweet: "sweet and tender", chilled: "chilled and mellow", sporty: "high-energy and chant-along",
};
function vibeTag(v) { const k = normStyle(v); if (k === "surprise me") return ""; return VIBE_MOD[k] ? (", " + VIBE_MOD[k]) : ""; }

/* Vibe → a short tone note for the lyrics. Only the chosen vibe, no extra. */
const VIBE_FEEL = {
  heartfelt: "heartfelt", funny: "funny and playful", feelgood: "feel-good", happy: "happy and upbeat",
  emotional: "emotional", cool: "cool and laid-back", chill: "relaxed and chilled", magical: "magical and dreamy",
  epic: "epic", "road trip": "carefree road-trip", party: "party", silly: "silly and goofy",
  hopeful: "hopeful", romantic: "romantic", bedtime: "soft and sleepy",
  sweet: "sweet and tender", chilled: "relaxed and chilled", sporty: "pumped-up and chant-along",
};
function vibeFeel(v) { const k = normStyle(v); if (!k || k === "surprise me") return ""; return VIBE_FEEL[k] ? `Tone: ${VIBE_FEEL[k]}. ` : `Tone: ${v}. `; }

/* Turn the user's inputs into a vivid, personal Suno prompt. */
function buildSongPrompt({ names, about, category, mood, fallback, bandChoice, genre2 }) {
  if (!names && !about) return fallback || "";
  const who = names || category || "someone special";
  const first = (names || "").split(/[,&]| and /i)[0].trim() || who;
  const story = about ? about.replace(/^who\s+/i, "") + ". " : "";
  const styleLine = bandChoice
    ? "Let the band choose the musical style that fits this song. "
    : (genre2
        ? `Style: ${mood} with noticeable ${genre2} influences (keep it primarily ${mood}, not a 50/50 blend). `
        : (mood ? `Style: ${mood}. ` : ""));
  return `A song about ${who}. ${story}${styleLine}` +
         `It must clearly be about and feature ${first}, working the name in naturally (it does not need to be in every line).`;
}

/* ============================================================
   LYRICS (optional but recommended) — write the WORDS with a
   separate AI (ChatGPT or Claude), then Suno sings them. This
   guarantees the person's name lands in every chorus and makes
   the lyrics genuinely good instead of generic.
   LYRICS_PROVIDER in .env:  openai | anthropic | off (default)
   ============================================================ */
const LYRICS_PROVIDER = (process.env.LYRICS_PROVIDER || "off").toLowerCase();

function lyricBrief({ names, about, genre, category, vibe, pronounce, mustHave }) {
  const first = (names || "").split(/[,&]| and /i)[0].trim() || (names || "them");
  const feel = vibeFeel(vibe);
  const must = (mustHave && String(mustHave).trim())
    ? `- MUST include these exact words / phrases / ideas, woven in naturally: ${String(mustHave).trim()}.\n`
    : "";
  const pron = pronounce
    ? `The name is pronounced "${pronounce}" — make sure it is sung exactly that way.`
    : `The name may be a regional or non-English name (e.g. South African, African, Indian or other origins). Make sure it is sung and pronounced correctly; if an English-singing voice would likely mispronounce it, spell it phonetically in the lyrics so it sounds right when sung, while keeping it clearly their name.`;
  return `Write original ${genre || "pop"} song lyrics about ${names || "someone special"}.
About them: ${about || "a wonderful person"}. ${feel}
Rules:
- The song must clearly be about and feature "${first}". Work the name in naturally and memorably (the chorus or hook is a great spot) so there is no doubt it is their song. It does not need to be in every line. ${pron}
- Let the style and tone above lead — match them, don't fight them.
${must}- Use these section tags on their own lines: [Verse 1], [Chorus], [Verse 2], [Chorus], [Bridge], [Chorus].
- Catchy, singable chorus. Keep it clean — no explicit content.
- Keep it concise, about 16 to 24 lines total.
Output ONLY the lyrics with the section tags. Nothing else.`;
}

async function writeLyrics(input) {
  try {
    if (LYRICS_PROVIDER === "openai") return await lyricsOpenAI(lyricBrief(input));
    if (LYRICS_PROVIDER === "anthropic") return await lyricsAnthropic(lyricBrief(input));
  } catch (e) { console.error("lyrics failed (Suno will write them instead):", e.message); }
  return null;
}
async function lyricsOpenAI(brief) {
  const key = process.env.OPENAI_API_KEY; if (!key) throw new Error("Set OPENAI_API_KEY");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0.9, max_tokens: 500,
      messages: [ { role: "system", content: "You are a hit songwriter who writes fun, warm, catchy, family-friendly song lyrics." },
                  { role: "user", content: brief } ] }),
  });
  if (!r.ok) throw new Error("OpenAI " + r.status);
  const d = await r.json(); return (d.choices && d.choices[0] && d.choices[0].message.content || "").trim() || null;
}
async function lyricsAnthropic(brief) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) throw new Error("Set ANTHROPIC_API_KEY");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-3-5-haiku-latest", max_tokens: 600,
      system: "You are a hit songwriter who writes fun, warm, catchy, family-friendly song lyrics.",
      messages: [ { role: "user", content: brief } ] }),
  });
  if (!r.ok) throw new Error("Anthropic " + r.status);
  const d = await r.json(); return (d.content && d.content[0] && d.content[0].text || "").trim() || null;
}

/* small helpers */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function pollUntil(fn, { tries = 40, every = 3000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await wait(every);
  }
  throw new Error("Timed out waiting for the song to finish");
}

/* ------------------------------------------------------------
   The one route your app calls.
   Body: { title, genre, prompt, lyrics }
   Returns: { audioUrl }
   ------------------------------------------------------------ */
app.post("/api/generate", accounts.requireAuth, async (req, res) => {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
  if (!rateOk(ip)) return res.status(429).json({ error: "Too many songs from this connection — please slow down a bit." });

  const { title, genre, genre2, bandChoice, voice, prompt, lyrics, mustHave, names, about, category, mood, vibe, pronounce, fingerprint } = req.body || {};
  const primary = mood || genre;
  const isBandChoice = !!bandChoice || normStyle(primary) === "bands choice";
  const influenceName = (genre2 && !isBandChoice) ? genre2 : "";
  const primaryStyle = isBandChoice
    ? "the band chooses the most fitting musical style for this song"
    : styleFor(primary);
  const influence = influenceName ? `, with noticeable ${influenceName} influences (keep it primarily ${primary}, not a 50/50 blend)` : "";
  const voiceTag = voice === "female" ? ", female lead vocal" : voice === "male" ? ", male lead vocal" : "";
  const tags = primaryStyle + influence + vibeTag(vibe) + voiceTag;
  const lyricGenre = isBandChoice ? "" : (influenceName ? `${primary} with a touch of ${influenceName}` : primary);
  const fullPrompt = buildSongPrompt({ names, about, category, mood: isBandChoice ? "" : primary, fallback: prompt, bandChoice: isBandChoice, genre2: influenceName });
  if (!fullPrompt) return res.status(400).json({ error: "Missing prompt" });

  // --- entitlement: claim ONE song server-side (paid credit or a free song,
  //     capped per account AND per device). 'none' => must pay. ---
  let mode = "open";
  if (accounts.accountsEnabled() && req.user) {
    try {
      // Studio Pass first (free-to-make under the monthly cap), then a paid
      // credit or a free song. 'none' from both => must pay.
      mode = await accounts.claimPassSong(req.user.id);            // 'pass' | 'none'
      if (mode === "none") mode = await accounts.claimSong(req.user.id, fingerprint); // 'paid' | 'free' | 'none'
    } catch (e) {
      console.error("claim song:", e.message);
      return res.status(500).json({ error: "Could not check your song balance. Try again." });
    }
    if (mode === "none") {
      return res.status(402).json({ error: "no_songs_left", message: "You've used your free songs — grab a Single, an Album, or a Studio Pass to keep making music." });
    }
  }

  try {
    // Write the words first (locks the name into every chorus). Falls back to
    // Suno's own lyrics if LYRICS_PROVIDER is off or the call fails.
    let finalLyrics = lyrics;
    if (!finalLyrics && LYRICS_PROVIDER !== "off") finalLyrics = await writeLyrics({ names, about, genre: lyricGenre, category, vibe, pronounce, mustHave });

    let out;
    if (PROVIDER === "apiframe")        out = await viaApiframe({ title, tags, prompt: fullPrompt, lyrics: finalLyrics });
    else if (PROVIDER === "selfhost")   out = await viaSelfHost({ title, tags, prompt: fullPrompt, lyrics: finalLyrics });
    else if (PROVIDER === "thirdparty") out = await viaThirdParty({ title, tags, prompt: fullPrompt, lyrics: finalLyrics });
    else                                out = await viaDemo();

    if (!out || !out.audioUrl) throw new Error("No audio returned");

    // success: pull a PERMANENT copy into our own storage (so the track can
    // never vanish when Suno's temporary link expires), then return the
    // permanent urls + the user's fresh balance.
    let status = null, savedId = null;
    if (accounts.accountsEnabled() && req.user) {
      const saved = await accounts.recordSong(req.user.id, {
        title, genre: mood || genre, names,
        audioUrl: out.audioUrl, imageUrl: out.imageUrl, isFree: mode === "free",
      });
      if (saved) {
        savedId = saved.id;
        // hand the app our permanent links, not Suno's expiring ones
        if (saved.audio_url) out.audioUrl = saved.audio_url;
        if (saved.image_url) out.imageUrl = saved.image_url;
      }
      status = await accounts.statusFor(req.user.id, fingerprint);
    }
    res.json({ ...out, savedId, provider: PROVIDER, status });
  } catch (err) {
    // our failure, not theirs: give the song back
    if (accounts.accountsEnabled() && req.user) {
      if (mode === "pass") await accounts.releasePassSong(req.user.id);
      else if (mode === "paid" || mode === "free") await accounts.releaseSong(req.user.id, fingerprint, mode);
    }
    console.error("generate failed:", err.message);
    res.status(502).json({ error: "Generation failed", detail: err.message });
  }
});

/* The app reads this after sign-in (and after a payment) to know the
   user's real, server-side balance + free songs left. */
app.get("/api/me", accounts.requireAuth, async (req, res) => {
  if (!accounts.accountsEnabled() || !req.user) return res.json({ accounts: false });
  try {
    const status = await accounts.statusFor(req.user.id, req.query.fingerprint);
    res.json({ accounts: true, email: req.user.email || null, ...status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* The user's permanent library (My Tracks). Songs live in our own
   storage, so this works across devices and never returns dead links. */
app.get("/api/songs", accounts.requireAuth, async (req, res) => {
  if (!accounts.accountsEnabled() || !req.user) return res.json({ accounts: false, songs: [] });
  try {
    const songs = await accounts.listSongs(req.user.id);
    res.json({ accounts: true, songs });
  } catch (e) {
    console.error("/api/songs:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/* Delete one of the signed-in user's songs (DB row + stored files). */
app.delete("/api/songs/:id", accounts.requireAuth, async (req, res) => {
  if (!accounts.accountsEnabled() || !req.user) return res.status(401).json({ error: "sign_in" });
  try {
    const ok = await accounts.deleteSong(req.user.id, req.params.id);
    if (!ok) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    console.error("/api/songs delete:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================
   CHARTS — social/bragging only. Dark until CHARTS_ENABLED=true.
   ============================================================ */
function chartsOff(res) { return res.status(404).json({ error: "charts_disabled" }); }

/* Public chart listing. type: top | new | played. */
app.get("/api/charts", async (req, res) => {
  if (!accounts.CHARTS_ENABLED) return chartsOff(res);
  try {
    const songs = await accounts.listCharts(req.query.type || "top");
    res.json({ enabled: true, type: req.query.type || "top", songs });
  } catch (e) { console.error("/api/charts:", e.message); res.status(500).json({ error: e.message }); }
});

/* One public song (shareable page). Counts a play. */
app.get("/api/song/:id", async (req, res) => {
  if (!accounts.CHARTS_ENABLED) return chartsOff(res);
  try {
    const song = await accounts.getPublicSong(req.params.id);
    if (!song) return res.status(404).json({ error: "not_found" });
    accounts.addPlay(req.params.id);
    res.json({ song });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Creator opts a song in/out of the charts. */
app.post("/api/songs/:id/publish", accounts.requireAuth, async (req, res) => {
  if (!accounts.CHARTS_ENABLED) return chartsOff(res);
  if (!req.user) return res.status(401).json({ error: "sign in" });
  try {
    const out = await accounts.publishSong(req.user.id, req.params.id, { isPublic: !!(req.body && req.body.public), chartTitle: req.body && req.body.title });
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* Heart a song (toggle). */
app.post("/api/songs/:id/heart", accounts.requireAuth, async (req, res) => {
  if (!accounts.CHARTS_ENABLED) return chartsOff(res);
  if (!req.user) return res.status(401).json({ error: "sign in" });
  try { res.json({ hearts: await accounts.toggleHeart(req.user.id, req.params.id) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* Report a song for review. */
app.post("/api/songs/:id/report", accounts.requireAuth, async (req, res) => {
  if (!accounts.CHARTS_ENABLED) return chartsOff(res);
  try { await accounts.reportSong(req.params.id, req.user && req.user.id, req.body && req.body.reason); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------- DEMO ---------- */
async function viaDemo() {
  await wait(4000);
  return { audioUrl: DEMO_TRACK };
}

/* ---------- APIFRAME (recommended Suno provider) ----------
   Free tier to start (~27 songs/mo, no card). Docs: https://docs.apiframe.ai
   Submit a song, poll /fetch, return the first finished song's audio +
   its cover art + lyrics. Set APIFRAME_KEY in .env and PROVIDER=apiframe.
*/
async function viaApiframe({ title, tags, prompt, lyrics }) {
  const key = process.env.APIFRAME_KEY;
  if (!key) throw new Error("Set APIFRAME_KEY in .env");
  const headers = { "Content-Type": "application/json", "X-API-Key": key };

  // Apiframe v2: in custom mode the prompt IS the lyrics; otherwise it's a short
  // description (Suno caps the description at 500 chars). Style/title go in sunoParams.
  const custom = !!(lyrics && lyrics.trim());
  const body = {
    model: "suno",
    prompt: custom ? lyrics.slice(0, 4900) : (prompt || "").slice(0, 490),
    sunoParams: {
      custom_mode: custom,
      title: (title || "Song Stars").slice(0, 80),
      style: (tags || "").slice(0, 990),
      model_version: "V4_5PLUS",
      instrumental: false,
    },
  };

  const submit = await fetch("https://api.apiframe.ai/v2/music/generate", {
    method: "POST", headers, body: JSON.stringify(body),
  });
  if (!submit.ok) {
    const errText = await submit.text().catch(() => "");
    throw new Error("Apiframe submit failed: " + submit.status + " " + errText.slice(0, 300));
  }
  const { jobId } = await submit.json();
  if (!jobId) throw new Error("No jobId from Apiframe");

  // Poll the job until Suno finishes (~30-60s). v2 returns 2 tracks.
  return pollUntil(async () => {
    const r = await fetch("https://api.apiframe.ai/v2/jobs/" + jobId, { headers });
    const d = await r.json();
    if (d.status === "FAILED") throw new Error("Suno failed: " + JSON.stringify(d.error || d).slice(0, 200));
    const tracks = d.result && d.result.tracks;
    if (d.status === "COMPLETED" && Array.isArray(tracks) && tracks[0] && tracks[0].audioUrl) {
      const a = tracks[0], b = tracks[1];
      return {
        audioUrl: a.audioUrl, imageUrl: a.imageUrl, lyrics: lyrics || null,
        alt: b && b.audioUrl ? { audioUrl: b.audioUrl, imageUrl: b.imageUrl, lyrics: lyrics || null } : null,
      };
    }
    return null;
  }, { tries: 60, every: 3000 });
}

/* ---------- SELF-HOSTED (gcui-art/suno-api) ----------
   Run that project separately (see README). It exposes:
     POST /api/custom_generate  -> starts a song, returns [{id}, ...]
     GET  /api/get?ids=<id>     -> poll; item.audio_url fills in when ready
   Set SUNO_SELFHOST_URL to where it runs, e.g. http://localhost:3000
*/
async function viaSelfHost({ prompt, tags, lyrics }) {
  const base = process.env.SUNO_SELFHOST_URL;
  if (!base) throw new Error("Set SUNO_SELFHOST_URL in .env");

  const start = await fetch(`${base}/api/custom_generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: lyrics || prompt,        // lyrics if provided, else let Suno write them
      tags,                            // genre/style preset
      title: undefined,
      make_instrumental: false,
      wait_audio: false,
    }),
  });
  if (!start.ok) throw new Error("self-host start failed: " + start.status);
  const jobs = await start.json();
  const id = Array.isArray(jobs) ? jobs[0]?.id : jobs?.id;
  if (!id) throw new Error("No job id from self-host");

  const audioUrl = await pollUntil(async () => {
    const r = await fetch(`${base}/api/get?ids=${id}`);
    const items = await r.json();
    const item = Array.isArray(items) ? items[0] : items;
    return item && item.audio_url ? item.audio_url : null;
  });
  return { audioUrl };
}

/* ---------- THIRD-PARTY PROVIDER ----------
   Shapes differ per provider — adjust the 3 marked lines to match
   the docs of whichever you pick (APIPASS / Sunor / EvoLink / Apiframe).
   Set THIRDPARTY_BASE and THIRDPARTY_KEY in .env
*/
async function viaThirdParty({ prompt, tags, lyrics, title }) {
  const base = process.env.THIRDPARTY_BASE;
  const key = process.env.THIRDPARTY_KEY;
  if (!base || !key) throw new Error("Set THIRDPARTY_BASE and THIRDPARTY_KEY in .env");

  // (1) start the job — check your provider's request body
  const start = await fetch(`${base}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      prompt,
      style: tags,
      customLyrics: lyrics || undefined,
      title,
      instrumental: false,
    }),
  });
  if (!start.ok) throw new Error("third-party start failed: " + start.status);
  const startData = await start.json();

  // (2) get the job id — field name varies (taskId / id / data.id …)
  const jobId = startData.taskId || startData.id || startData.data?.id;
  if (jobId === undefined) {
    // some providers return the audio URL immediately
    const direct = startData.audioUrl || startData.audio_url || startData.data?.audioUrl;
    if (direct) return { audioUrl: direct };
    throw new Error("No job id / audio from third-party");
  }

  // (3) poll for completion — check your provider's status route + field
  const audioUrl = await pollUntil(async () => {
    const r = await fetch(`${base}/status/${jobId}`, { headers: { Authorization: `Bearer ${key}` } });
    const d = await r.json();
    return d.audioUrl || d.audio_url || d.data?.audioUrl || null;
  });
  return { audioUrl };
}

function stripEmoji(s = "") { return s.replace(/[^\w &/-]/g, "").trim(); }

/* ============================================================
   PAYMENTS  (Singles & Albums)
   ------------------------------------------------------------
   Provider-agnostic, switched by PAY_PROVIDER in .env:
     yoco     = best margin (no fixed per-transaction fee)
     payfast  = you already have it (3.5% + R2 per transaction)
     demo     = no real charge; grants instantly (default, for testing)

   Flow when live:
     1. App calls POST /api/pay/create -> we ask the provider for a
        hosted checkout and return { redirectUrl }.
     2. App sends the buyer to redirectUrl to pay.
     3. Provider calls POST /api/pay/webhook on success -> we verify
        and credit the buyer's account (the SOURCE OF TRUTH for what
        they own must live server-side, never trust the browser).
   ============================================================ */
// Switched by Render env PAY_PROVIDER. Defaults to "demo" (instant, no real charge) so
// nothing breaks if the env is unset. Set PAY_PROVIDER=payfast + PAYFAST_* to take real/sandbox payments.
const PAY_PROVIDER = (process.env.PAY_PROVIDER || "demo");

/* PayFast requires an md5 signature of the fields (in order) + your passphrase. */
function payfastSignature(fields, passphrase) {
  let str = Object.keys(fields)
    .filter((k) => fields[k] !== "" && fields[k] !== undefined && fields[k] !== null)
    .map((k) => `${k}=${encodeURIComponent(String(fields[k]).trim()).replace(/%20/g, "+")}`)
    .join("&");
  if (passphrase) str += `&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, "+")}`;
  return crypto.createHash("md5").update(str).digest("hex");
}

app.post("/api/pay/create", accounts.requireAuth, async (req, res) => {
  const { packId, amount, qty, email, kind } = req.body || {};
  const isPass = kind === "pass" || packId === "studiopass";
  const useQty = isPass ? 0 : qty;
  if (!amount || (!isPass && !useQty)) return res.status(400).json({ error: "Missing amount/qty" });
  const itemName = isPass ? "Band in Your Hand - Studio Pass (1 month)" : `Band in Your Hand - ${qty} track${qty > 1 ? "s" : ""}`;

  // Record the order server-side FIRST (pending). Credits/pass are only granted
  // once payment is confirmed (webhook or /api/pay/confirm) — never from the browser.
  let orderId = null;
  if (accounts.accountsEnabled() && req.user) {
    try {
      orderId = await accounts.createOrder({ userId: req.user.id, packId: isPass ? "studiopass" : packId, qty: useQty, amountCents: Math.round(amount * 100) });
    } catch (e) {
      console.error("createOrder:", e.message);
      return res.status(500).json({ error: "Could not start your order. Try again." });
    }
  }

  try {
    if (PAY_PROVIDER === "yoco") {
      // Yoco Checkout API — amount in cents (ZAR). Docs: https://developer.yoco.com
      const r = await fetch("https://payments.yoco.com/api/checkouts", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.YOCO_SECRET_KEY}` },
        body: JSON.stringify({
          amount: Math.round(amount * 100),
          currency: "ZAR",
          metadata: { orderId: orderId || "", packId, qty, email },
          successUrl: `${process.env.APP_URL || ""}/?order=${orderId || ""}`,
          cancelUrl: `${process.env.APP_URL || ""}/`,
        }),
      });
      if (!r.ok) throw new Error("Yoco checkout failed: " + r.status + " " + (await r.text().catch(() => "")).slice(0, 200));
      const d = await r.json();
      if (orderId) await accounts.attachCheckout(orderId, d.id);
      return res.json({ provider: "yoco", redirectUrl: d.redirectUrl, id: d.id, orderId });
    }

    if (PAY_PROVIDER === "payfast") {
      // PayFast redirects to a hosted page built from signed form fields.
      // Build params, sign with your passphrase, return the redirect URL.
      // Docs: https://developers.payfast.co.za  (set PAYFAST_* in .env)
      const base = process.env.PAYFAST_SANDBOX === "true"
        ? "https://sandbox.payfast.co.za/eng/process"
        : "https://www.payfast.co.za/eng/process";
      const fields = {
        merchant_id: process.env.PAYFAST_MERCHANT_ID,
        merchant_key: process.env.PAYFAST_MERCHANT_KEY,
        return_url: `${process.env.APP_URL || ""}/?order=${orderId || ""}`,
        cancel_url: `${process.env.APP_URL || ""}/`,
        // ITN (server-to-server) must hit the BACKEND, not the frontend.
        notify_url: `${process.env.BACKEND_URL || "https://song-stars-backend.onrender.com"}/api/pay/webhook`,
        // PayFast canonical order: buyer details (email) BEFORE transaction details (m_payment_id, amount...).
        // In SANDBOX, never send the merchant's own email — PayFast blocks "paying yourself".
        // Use a neutral test buyer so the sandbox Test Merchant page (and full ITN loop) is reachable.
        email_address: process.env.PAYFAST_SANDBOX === "true" ? "theo@melonmobile.co.za" : (email || ""),
        m_payment_id: orderId || "",
        amount: Number(amount).toFixed(2),
        item_name: itemName,
        custom_int1: String(useQty),
        custom_str1: orderId || "",
      };
      // PayFast is strict: the string we SIGN must be byte-identical to the string we SUBMIT.
      // So drop empty fields from BOTH, in the SAME order, with the SAME encoding.
      const pfEncode = (v) => encodeURIComponent(String(v).trim()).replace(/%20/g, "+");
      const entries = Object.entries(fields).filter(([, v]) => v !== "" && v !== undefined && v !== null);
      const paramStr = entries.map(([k, v]) => `${k}=${pfEncode(v)}`).join("&");
      const pass = process.env.PAYFAST_PASSPHRASE;
      const sigBase = paramStr + (pass ? `&passphrase=${pfEncode(pass)}` : "");
      const signature = crypto.createHash("md5").update(sigBase).digest("hex");
      const redirectUrl = `${base}?${paramStr}&signature=${signature}`;
      console.log("payfast paramStr:", paramStr, "| sig:", signature);
      return res.json({ provider: "payfast", redirectUrl, orderId });
    }

    // demo: no real charge — credit instantly so the flow is testable end-to-end.
    if (accounts.accountsEnabled() && req.user && orderId) {
      await accounts.markOrderPaidAndCredit({ orderId });
    }
    return res.json({ provider: "demo", status: "granted", qty, orderId });
  } catch (err) {
    console.error("pay/create failed:", err.message);
    res.status(502).json({ error: "Payment init failed", detail: err.message });
  }
});

/* After returning from Yoco, the app calls this with its orderId. We ask Yoco
   whether the checkout actually completed, then credit — so the browser can
   never grant itself songs. Idempotent. */
app.post("/api/pay/confirm", accounts.requireAuth, async (req, res) => {
  if (!accounts.accountsEnabled() || !req.user) return res.json({ accounts: false });
  const { orderId } = req.body || {};
  if (!orderId) return res.status(400).json({ error: "Missing orderId" });
  try {
    if (PAY_PROVIDER === "yoco") {
      // look up the order's checkout id and verify status with Yoco
      const order = await accounts.findOrder({ orderId, userId: req.user.id });
      if (!order) return res.status(404).json({ error: "Order not found" });
      if (order.status !== "paid" && order.yoco_checkout_id) {
        const r = await fetch(`https://payments.yoco.com/api/checkouts/${order.yoco_checkout_id}`, {
          headers: { Authorization: `Bearer ${process.env.YOCO_SECRET_KEY}` },
        });
        if (r.ok) {
          const d = await r.json();
          if ((d.status || "").toLowerCase() === "completed") {
            await accounts.markOrderPaidAndCredit({ checkoutId: order.yoco_checkout_id });
          }
        }
      }
    } else if (PAY_PROVIDER === "payfast") {
      // PayFast credits via ITN (server-to-server), which can land a second
      // after the browser returns. Give it a few tries before reporting balance.
      for (let i = 0; i < 6; i++) {
        const order = await accounts.findOrder({ orderId, userId: req.user.id });
        if (order && order.status === "paid") break;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    const status = await accounts.statusFor(req.user.id, req.body.fingerprint);
    res.json({ accounts: true, ...status });
  } catch (e) {
    console.error("pay/confirm:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/* APPLE IAP: the iOS app sends the StoreKit 2 signed transaction (JWS)
   after a successful purchase. We verify + grant server-side (credits or
   Studio Pass), then return the user's fresh balance/pass. Idempotent. */
app.post("/api/pay/apple/verify", accounts.requireAuth, async (req, res) => {
  if (!accounts.accountsEnabled() || !req.user) return res.json({ accounts: false });
  const { signedTransaction, fingerprint } = req.body || {};
  if (!signedTransaction) return res.status(400).json({ error: "Missing signedTransaction" });
  try {
    const result = await accounts.grantApplePurchase(req.user.id, signedTransaction);
    const status = await accounts.statusFor(req.user.id, fingerprint);
    res.json({ accounts: true, granted: result, ...status });
  } catch (e) {
    console.error("apple/verify:", e.message);
    res.status(400).json({ error: "Could not verify that purchase.", detail: e.message });
  }
});

/* Yoco calls this on payment events. Credits the order (idempotent). */
app.post("/api/pay/webhook", async (req, res) => {
  try {
    const body = req.body || {};
    let checkoutId, orderId, succeeded;
    if (body.payment_status || body.m_payment_id) {
      // PayFast ITN (form-encoded). payment_status === "COMPLETE" on success.
      orderId = body.m_payment_id || body.custom_str1;
      succeeded = /complete/i.test(String(body.payment_status || ""));
    } else {
      // Yoco webhook (JSON).
      const payload = body.payload || body.data || body;
      checkoutId = payload.id || payload.checkoutId || (payload.metadata && payload.metadata.checkoutId);
      orderId = payload.metadata && payload.metadata.orderId;
      succeeded = /succeed|complete|paid|success/i.test(String(body.type || payload.status || ""));
    }
    if (accounts.accountsEnabled() && succeeded && (checkoutId || orderId)) {
      await accounts.markOrderPaidAndCredit({ checkoutId, orderId });
    }
    console.log("payment webhook:", PAY_PROVIDER, succeeded ? "ok" : "ignored", checkoutId || orderId || "");
  } catch (e) {
    console.error("webhook:", e.message);
  }
  res.sendStatus(200); // always 200 so the provider doesn't retry-storm
});

app.get("/", (_req, res) => res.send(`Song Stars backend · songs:${PROVIDER} · pay:${PAY_PROVIDER}`));
app.listen(PORT, () => console.log(`🎵 Song Stars backend on :${PORT} (songs:${PROVIDER}, pay:${PAY_PROVIDER})`));
