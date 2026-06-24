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
require("dotenv").config();

const app = express();
app.use(cors());                 // lock this to your app's domain before launch
app.use(express.json());

const PROVIDER = (process.env.PROVIDER || "demo").toLowerCase();
const PORT = process.env.PORT || 8787;
const DEMO_TRACK = "https://cdn.pixabay.com/audio/2022/03/15/audio_8cb749d484.mp3";

/* ============================================================
   STYLE PRESETS  — the secret to good songs.
   Edit these to tune how each vibe sounds. Rich tags = great
   songs; one-word tags = bland songs. Keyed by the vibe/genre
   the user picks in the app.
   ============================================================ */
const STYLES = {
  // ---- moods ----
  funny: "Upbeat comedic children's pop, playful and cheeky, bright major key, bouncy tempo around 120 BPM. Plucky ukulele and acoustic guitar, glockenspiel and xylophone, kazoo, parping tuba, hand claps and finger snaps, jaunty walking bassline, cartoonish brass stabs, the odd silly boing or pop sound effect. Clear, warm, friendly lead vocal with cheerful gang backing vocals doing call-and-response. Big singalong chorus, comedic timing and playful little pauses, light and wholesome, family-friendly, joyful and a touch mischievous. Clean, modern, polished production with loads of energy.",
  party: "High-energy feel-good dance-pop party anthem, euphoric and celebratory, major key, around 124 BPM, four-on-the-floor kick, punchy claps and snare, bright plucky synths, warm sidechained pads, funky bass, rising risers and build-ups into a huge, joyful chorus. Confident, bright lead vocal with big stacked gang-vocal hooks and crowd 'hey!' chants. Massive singalong chorus, balloons-and-confetti energy, fun and inclusive, wholesome and family-friendly. Crisp, glossy, radio-ready modern production with sparkle and bounce.",
  emotional: "Heartfelt, tender acoustic ballad, warm and sentimental, gentle and intimate, slow tempo around 70 BPM. Soft felt piano, warm fingerpicked acoustic guitar, swelling cinematic strings, subtle warm pads, light brushed drums arriving in the second half, delicate glockenspiel touches. Close, emotive lead vocal, sincere and gentle, with soft harmonies. Dynamic build from quiet, intimate verses to a soaring, goosebumps chorus, then a tender stripped-back ending. Loving, nostalgic, uplifting, family-friendly. Organic, spacious, high-quality production.",
  epic: "Cinematic epic anthem, triumphant and powerful, inspiring and heroic, building from intimate to enormous, around 90 BPM. Grand orchestral strings and soaring brass, pounding taiko and big cinematic drums, deep booming hits, choir 'ahhs', anthemic piano, subtle modern hybrid-trailer synths and risers. Strong, confident, uplifting lead vocal with a huge stacked choir on the chorus. Dramatic dynamic build, a lift near the end, goosebumps climax. Adventurous, victorious, larger-than-life yet warm and family-friendly. Polished, wide, blockbuster production.",
  catchy: "Bright, feel-good radio pop, irresistibly catchy and upbeat, major key, around 110 BPM. Sparkly plucked synths, clean electric guitar, warm bass, snappy programmed drums with claps and tambourine, bouncy piano, cheerful whistling and 'oh-oh-oh' hooks. Friendly, bright lead vocal with layered singalong backing vocals. Strong pre-chorus lift into an instantly memorable, hooky chorus that's easy for kids to sing. Sunny, optimistic, wholesome, family-friendly. Clean, modern, polished commercial production.",
  bedtime: "Gentle, soothing lullaby, soft and dreamy, calming and warm, very slow tempo around 60 BPM. Delicate music box and soft felt piano, warm pads, gentle fingerpicked nylon guitar, subtle harp glissandos, twinkling celeste, slow soft strings, light shimmering ambience. Quiet, tender, breathy lead vocal, almost a whisper, with airy 'la-la' harmonies and the faintest hum. Minimal, spacious arrangement, no percussion or only the softest heartbeat pulse. Peaceful, safe, loving, sleepy, family-friendly. Warm, intimate, high-quality production.",
  cool: "Laid-back modern pop with a smooth, confident groove, effortlessly cool and stylish, mid tempo around 95 BPM. Mellow electric piano, muted funky guitar, warm round bassline, crisp drums with rim-clicks and soft claps, tasteful synth touches, subtle vinyl warmth. Relaxed, charismatic lead vocal with smooth backing harmonies. Chilled but catchy, head-nodding, feel-good and breezy, wholesome and family-friendly. Clean, warm, contemporary production with plenty of space and vibe.",
  "sports anthem": "Stadium sports anthem, triumphant and rowdy in a fun way, chant-along and unstoppable, around 130 BPM, strong stomping four-on-the-floor. Big stomp-stomp-clap drums, distorted power-chord electric guitars, anthemic synth brass, driving bass, crowd chants and 'hey! hey!' gang vocals, whistle and air-horn stabs. Bold, powerful lead vocal with a massive crowd-sized chorus built for chanting. Energetic, victorious, unifying, pump-up energy, wholesome and family-friendly. Punchy, huge, arena-sized production.",
  // ---- genres ----
  pop: "Bright, upbeat modern pop, around 112 BPM. Clean electric guitars, warm synths, snappy drums with claps, bouncy piano, a big friendly singalong chorus. Friendly, bright lead vocal with layered backing vocals. Sunny, optimistic, wholesome and family-friendly. Clean, polished, radio-ready production.",
  rock: "Energetic feel-good pop-rock, anthemic and driving, around 130 BPM. Crunchy power-chord electric guitars, melodic lead-guitar licks, punchy live drums, driving bass, big tom fills. Strong, confident lead vocal with gang-vocal backing shouts. Huge fist-pumping singalong chorus, uplifting and wholesome, family-friendly. Polished modern rock production with warmth and punch.",
  gospel: "Uplifting modern gospel, joyful and soulful, praise-filled, around 100 BPM. Rich Hammond organ, gospel piano, warm bass, live drums with tambourine, soaring brass. Powerful lead vocal with a big harmonised choir doing call-and-response and warm ad-libs. Building arrangement into a euphoric, hands-in-the-air chorus with a key-change lift near the end. Hopeful, heartfelt, communal, family-friendly. Warm, live, full production.",
  rb: "Smooth contemporary R&B, warm and soulful, mid-slow tempo around 75 BPM. Lush electric piano, mellow guitar, deep round bass, crisp finger-snaps and soft drums, silky pads, subtle vocal chops. Smooth, expressive lead vocal with rich stacked harmonies and gentle runs. Groovy, intimate, heartfelt and tasteful, wholesome and family-friendly. Clean, warm, modern production with space and vibe.",
  soul: "Classic feel-good soul, warm and heartfelt, vintage Motown/Stax flavour, around 100 BPM. Punchy horn section, warm electric piano and organ, clean rhythm guitar, melodic bass, live drums with tambourine. Rich, emotive lead vocal with soulful backing singers and call-and-response. Groovy, joyful, uplifting, timeless and wholesome, family-friendly. Warm, analog, live-band production.",
  "hip hop": "Upbeat, family-friendly hip hop, fun, clean and positive, around 95 BPM. Booming 808 bass, crisp trap hi-hats and snappy snare, a bright melodic synth or piano loop, light vocal chops. Confident, clear, rhythmic flow with catchy chanted hooks and kid-friendly call-and-response. Bouncy, feel-good, encouraging, no explicit content. Clean, modern, polished hip-hop production.",
  dance: "Electronic dance pop, euphoric festival energy, around 126 BPM, four-on-the-floor kick, punchy claps, bright plucky and saw synths, big risers into a euphoric drop-style chorus. Bright lead vocal with stacked gang-vocal hooks. Joyful, sparkly, hands-in-the-air, wholesome and family-friendly. Crisp, glossy, festival-ready production.",
  trance: "Uplifting euphoric trance, dreamy and emotional, around 138 BPM. Rolling four-on-the-floor kick, driving offbeat bass, shimmering supersaw leads, lush pads, sparkling arpeggios, a big emotional breakdown then a soaring energetic drop. Airy, ethereal vocal with reverb-soaked hooks. Hopeful, euphoric, cinematic, wholesome and family-friendly. Wide, polished, festival production.",
  kwaito: "Laid-back South African kwaito, slow grooving house tempo around 100 BPM, deep and bouncy. Warm deep-house bassline, mellow synth stabs, log-drum and percussive shakers, spacious claps, hypnotic loop. Relaxed, chanted call-and-response vocals with cool local swagger. Groovy, feel-good, street-cool yet wholesome and family-friendly. Warm, spacious, authentically South African production.",
  amapiano: "Smooth South African amapiano, deep and soulful, around 112 BPM. Signature log-drum bassline, airy piano chords, soft shakers, rim-clicks, spacious percussion, gentle vocal chops and atmospheric pads. Relaxed, soulful lead vocal with breezy harmonies and chanted hooks. Groovy, classy, hypnotic, feel-good, wholesome and family-friendly. Warm, spacious, authentic amapiano production with deep low-end.",
  afrobeats: "Sunny modern afrobeats, smooth and feel-good, around 105 BPM. Bouncy log-drum and percussion, bright marimba and guitar plucks, warm bass, airy pads, light vocal chops. Smooth, melodic lead vocal with breezy gang harmonies and catchy chanted hooks. Groovy, warm, joyful, danceable, wholesome and family-friendly. Clean, spacious, modern Afropop production.",
  reggae: "Sunny, laid-back reggae, warm and positive, around 75 BPM. Off-beat 'skank' guitar and organ bubble, deep round bass, relaxed one-drop drums, light percussion. Warm, friendly lead vocal with easy harmonies and chanted hooks. Chilled, joyful, feel-good island vibe, wholesome and family-friendly. Warm, organic, spacious production.",
  disco: "Feel-good 70s disco, glittery and joyful, around 120 BPM. Four-on-the-floor kick, syncopated funky bass, wah rhythm guitar, lush strings, bright brass stabs, shimmering hi-hats, handclaps. Bright, happy lead vocal with stacked disco harmonies. Danceable, retro, euphoric, wholesome and family-friendly. Warm, lively, classic disco production.",
  country: "Warm, heartfelt acoustic country, homely and storytelling, around 90 BPM. Acoustic guitar, banjo, gentle slide and pedal-steel guitar, fiddle, warm bass, soft brushed drums. Friendly, sincere lead vocal with cosy harmonies. Wholesome, nostalgic, feel-good, family-friendly. Warm, organic, polished country production.",
  lullaby: "Gentle, soothing lullaby, soft and dreamy, very slow tempo around 60 BPM. Delicate music box and soft felt piano, warm pads, gentle nylon guitar, twinkling celeste, slow soft strings. Quiet, tender, breathy lead vocal almost a whisper, with airy 'la-la' harmonies. Minimal, spacious, no percussion or the softest pulse. Peaceful, safe, loving, sleepy, family-friendly. Warm, intimate production.",
};
function normStyle(s) { return (s || "").replace(/[^a-z ]/gi, "").trim().toLowerCase(); }
function styleFor(s) { return STYLES[normStyle(s)] || (normStyle(s) + " song").trim() || "feel-good pop"; }

/* optional Vibe modifier, layered onto the genre style */
const VIBE_MOD = {
  funny: "playful, funny and cheeky", sweet: "sweet, warm and tender", epic: "epic, big and triumphant",
  chilled: "laid-back and chilled", bedtime: "gentle, soft and sleepy", sporty: "high-energy, chant-along, pumped up",
};
function vibeTag(v) { const k = normStyle(v); return VIBE_MOD[k] ? (", " + VIBE_MOD[k]) : ""; }

/* Turn the user's inputs into a vivid, personal Suno prompt. */
function buildSongPrompt({ names, about, category, mood, fallback }) {
  if (!names && !about) return fallback || "";
  const who = names || category || "someone special";
  const first = (names || "").split(/[,&]| and /i)[0].trim() || who;
  const occasion = /birthday/i.test(category || "") ? "It's their birthday. " : "";
  const story = about ? about.replace(/^who\s+/i, "") + ". " : "";
  return `An original, family-friendly ${mood || "happy"} song about ${who}. ${occasion}${story}` +
         `Make it personal and joyful, and sing ${first}'s name in the chorus.`;
}

/* ============================================================
   LYRICS (optional but recommended) — write the WORDS with a
   separate AI (ChatGPT or Claude), then Suno sings them. This
   guarantees the person's name lands in every chorus and makes
   the lyrics genuinely good instead of generic.
   LYRICS_PROVIDER in .env:  openai | anthropic | off (default)
   ============================================================ */
const LYRICS_PROVIDER = (process.env.LYRICS_PROVIDER || "off").toLowerCase();

function lyricBrief({ names, about, genre, category, vibe, pronounce }) {
  const first = (names || "").split(/[,&]| and /i)[0].trim() || (names || "them");
  const cat = (category || "").toLowerCase();
  let occ = "";
  if (/birthday/.test(cat)) occ = "It's their birthday, make it a celebration. ";
  else if (/pet/.test(cat)) occ = "It's a fun, loving song about their pet. ";
  else if (/fam/.test(cat)) occ = "It's about their whole family. ";
  const feel = vibe ? `Overall feel: ${vibe}. ` : "";
  const pron = pronounce
    ? `The name is pronounced "${pronounce}" — make sure it is sung exactly that way.`
    : `The name may be a regional or non-English name (e.g. South African, African, Indian or other origins). Make sure it is sung and pronounced correctly; if an English-singing voice would likely mispronounce it, spell it phonetically in the lyrics so it sounds right when sung, while keeping it clearly their name.`;
  return `Write original ${genre || "pop"} song lyrics about ${names || "someone special"}.
About them: ${about || "a wonderful person"}. ${occ}${feel}
Rules:
- Sing the name "${first}" clearly in EVERY chorus, and at least once in a verse. ${pron}
- Use these section tags on their own lines: [Verse 1], [Chorus], [Verse 2], [Chorus], [Bridge], [Chorus].
- Catchy, singable chorus. Warm, fun and 100% family-friendly. No explicit content.
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
app.post("/api/generate", async (req, res) => {
  const { title, genre, prompt, lyrics, names, about, category, mood, vibe, pronounce } = req.body || {};
  const tags = styleFor(mood || genre) + vibeTag(vibe);
  const fullPrompt = buildSongPrompt({ names, about, category, mood: mood || genre, fallback: prompt });
  if (!fullPrompt) return res.status(400).json({ error: "Missing prompt" });

  try {
    // Write the words first (locks the name into every chorus). Falls back to
    // Suno's own lyrics if LYRICS_PROVIDER is off or the call fails.
    let finalLyrics = lyrics;
    if (!finalLyrics && LYRICS_PROVIDER !== "off") finalLyrics = await writeLyrics({ names, about, genre: mood || genre, category, vibe, pronounce });

    let out;
    if (PROVIDER === "apiframe")        out = await viaApiframe({ title, tags, prompt: fullPrompt, lyrics: finalLyrics });
    else if (PROVIDER === "selfhost")   out = await viaSelfHost({ title, tags, prompt: fullPrompt, lyrics: finalLyrics });
    else if (PROVIDER === "thirdparty") out = await viaThirdParty({ title, tags, prompt: fullPrompt, lyrics: finalLyrics });
    else                                out = await viaDemo();

    if (!out || !out.audioUrl) throw new Error("No audio returned");
    res.json({ ...out, provider: PROVIDER });
  } catch (err) {
    console.error("generate failed:", err.message);
    res.status(502).json({ error: "Generation failed", detail: err.message });
  }
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

  const submit = await fetch("https://api.apiframe.pro/suno-imagine", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: key },
    body: JSON.stringify({
      prompt,
      lyrics: lyrics || undefined,   // if blank, Suno writes the lyrics
      tags,                          // rich style preset, e.g. "gentle lullaby, soft piano…"
      title,
      model: "V4_5",
      make_instrumental: false,
    }),
  });
  if (!submit.ok) throw new Error("Apiframe submit failed: " + submit.status);
  const { task_id } = await submit.json();
  if (!task_id) throw new Error("No task_id from Apiframe");

  return pollUntil(async () => {
    const r = await fetch("https://api.apiframe.pro/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({ task_id }),
    });
    const d = await r.json();
    const ready = d && d.status === "finished" && Array.isArray(d.songs) && d.songs[0] && d.songs[0].audio_url;
    if (!ready) return null;
    const a = d.songs[0], b = d.songs[1];
    return {
      audioUrl: a.audio_url, imageUrl: a.image_url, lyrics: a.lyrics,
      // version B — used as the instant, free "remake" (already generated & paid for)
      alt: b && b.audio_url ? { audioUrl: b.audio_url, imageUrl: b.image_url, lyrics: b.lyrics } : null,
    };
  });
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
const PAY_PROVIDER = (process.env.PAY_PROVIDER || "demo").toLowerCase();

app.post("/api/pay/create", async (req, res) => {
  const { packId, amount, qty, email } = req.body || {};
  if (!amount || !qty) return res.status(400).json({ error: "Missing amount/qty" });
  try {
    if (PAY_PROVIDER === "yoco") {
      // Yoco Checkout API — amount in cents (ZAR). Docs: https://developer.yoco.com
      const r = await fetch("https://payments.yoco.com/api/checkouts", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.YOCO_SECRET_KEY}` },
        body: JSON.stringify({
          amount: Math.round(amount * 100),
          currency: "ZAR",
          metadata: { packId, qty, email },
          successUrl: `${process.env.APP_URL || ""}/song-stars.html?paid=${qty}`,
          cancelUrl: `${process.env.APP_URL || ""}/song-stars.html`,
        }),
      });
      if (!r.ok) throw new Error("Yoco checkout failed: " + r.status);
      const d = await r.json();
      return res.json({ provider: "yoco", redirectUrl: d.redirectUrl, id: d.id });
    }

    if (PAY_PROVIDER === "payfast") {
      // PayFast redirects to a hosted page built from signed form fields.
      // Build params, sign with your passphrase, return the redirect URL.
      // Docs: https://developers.payfast.co.za  (set PAYFAST_* in .env)
      const base = process.env.PAYFAST_SANDBOX === "true"
        ? "https://sandbox.payfast.co.za/eng/process"
        : "https://www.payfast.co.za/eng/process";
      const params = {
        merchant_id: process.env.PAYFAST_MERCHANT_ID,
        merchant_key: process.env.PAYFAST_MERCHANT_KEY,
        amount: Number(amount).toFixed(2),
        item_name: `Song Stars - ${packId}`,
        custom_int1: qty,
        email_address: email || "",
        return_url: `${process.env.APP_URL || ""}/song-stars.html?paid=${qty}`,
        cancel_url: `${process.env.APP_URL || ""}/song-stars.html`,
        notify_url: `${process.env.APP_URL || ""}/api/pay/webhook`,
      };
      const redirectUrl = base + "?" + new URLSearchParams(params).toString();
      // NOTE: add the PayFast signature (md5 of params + passphrase) before going live.
      return res.json({ provider: "payfast", redirectUrl });
    }

    // demo
    return res.json({ provider: "demo", status: "granted", qty });
  } catch (err) {
    console.error("pay/create failed:", err.message);
    res.status(502).json({ error: "Payment init failed", detail: err.message });
  }
});

/* Provider calls this on a successful payment. VERIFY before crediting. */
app.post("/api/pay/webhook", (req, res) => {
  // TODO: verify the signature/ITN with the provider, look up the order,
  // then credit qty songs to the buyer's account in your database.
  console.log("payment webhook:", PAY_PROVIDER, JSON.stringify(req.body).slice(0, 300));
  res.sendStatus(200);
});

app.get("/", (_req, res) => res.send(`Song Stars backend · songs:${PROVIDER} · pay:${PAY_PROVIDER}`));
app.listen(PORT, () => console.log(`🎵 Song Stars backend on :${PORT} (songs:${PROVIDER}, pay:${PAY_PROVIDER})`));
