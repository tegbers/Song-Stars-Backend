/* ============================================================
   SONG STARS, backend (the part users never see)
   ------------------------------------------------------------
   Your app calls THIS server. THIS server talks to Suno and
   returns just an audio URL. Your Suno credentials stay here,
   on the server, never in the browser.

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
   A speed bump that stops runaway drain, incl. the private-browser trick, since
   those share one IP, until proper per-account server-side limits exist. */
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
   STUDIO RECIPES (the MUSIC channel), see SONGWRITING-ENGINE.md.
   Sound, instruments, tempo, arrangement, production. A genre's
   INTRINSIC character is allowed (disco grooves, lullabies soothe),
   but the MOOD is set by the Vibe and the STORY by the lyrics, so
   two songs in the same genre still feel different. The Vibe can
   override a recipe's default tone (Emotional + Disco leans emotional).
   ============================================================ */
const STYLES = {
  pop: "Timeless pop around 112 BPM. Bright electric guitars, polished synth layers, piano accents, warm bass, crisp drums, vocal front and centre. Verses build into a big memorable chorus. Polished, radio-ready, hook-driven production.",
  rock: "Stadium pop-rock around 128 BPM. Powerful rhythm guitars, melodic lead-guitar hooks, punchy live drums, driving bass, occasional piano. Verses build into massive choruses with gang vocals and soaring melodies. Polished, warm, powerful.",
  country: "Modern country around 90 BPM. Acoustic guitar lead with banjo, fiddle, pedal steel, warm bass, light drums, tasteful piano. Intimate conversational verses into warm choruses with rich harmonies. Authentic, organic, polished.",
  "hip hop": "Commercial hip hop around 95 BPM. Deep 808 bass, crisp drums, punchy kick, sharp hi-hats, melodic piano or synth motifs. Natural flow into chantable melodic choruses. Clean, modern, vocal-forward production.",
  rb: "Contemporary R&B around 75 BPM. Warm electric piano, mellow guitar, deep bass, soft drums, finger snaps, lush pads. Expressive lead vocal with stacked harmonies and tasteful runs. Luxurious, spacious, balanced production.",
  dance: "Dance-pop around 126 BPM. Four-on-the-floor kick, driving bass, bright synths, plucks, crisp percussion, uplifting builds into a euphoric chorus. Confident singalong vocals with stacked harmonies. Bright, glossy production with satisfying drops.",
  kpop: "World-class K-pop around 120 BPM. Bright synths, punchy drums, polished guitars, deep bass, vocal chops, colourful electronics and exciting transitions. Youthful confident vocals, layered harmonies, chant backing, huge choruses. Premium, globally appealing.",
  afrobeats: "Afrobeats around 105 BPM. Rich percussion, syncopated shakers, guitar plucks, marimba, warm bass, airy pads, subtle log-drum. Relaxed but irresistible groove. Melodic rhythmic vocals with chant harmonies and call-and-response hooks. Spacious, vibrant, clean low end.",
  amapiano: "Authentic amapiano around 112 BPM. Log-drum basslines under airy piano chords, spacious percussion, shakers, rim clicks, vocal chops. Everything breathes. Effortless conversational vocals with chant harmonies. Warm, deep, luxurious low end.",
  classical: "Cinematic orchestral around 80 BPM. Piano, soaring strings, French horns, woodwinds, harp, subtle percussion, building to sweeping moments then back to intimate passages. Elegant sincere vocals with lush harmonies and subtle choir. Timeless, cinematic.",
  lullaby: "Lullaby around 60 BPM. Felt piano, music box, nylon guitar, celeste, soft strings, warm pads. Simple comforting singable melody. Warm reassuring intimate vocal. Delicate, spacious, little or no percussion.",
  indie: "Indie-pop around 105 BPM. Jangly electric guitars, warm bass, live drums, subtle synths, piano, handclaps. Effortlessly cool, melodic; choruses never over-produced. Natural, slightly imperfect vocals with understated harmonies. Intimate yet polished.",
  house: "Vocal house around 124 BPM. Four-on-the-floor kick, deep bassline, piano stabs, warm synth chords, percussion, filtered builds. Patient build into vocal choruses. Soulful uplifting vocals with layered hooks. Warm, clean, timeless.",
  lofi: "Lo-fi around 80 BPM. Dusty drums, mellow electric piano, muted guitar, vinyl texture, warm bass, tape ambience. Spacious and understated, melody and vocal front. Gentle conversational vocals with subtle harmonies. Warm, textured, clear.",
  reggae: "Reggae around 75 BPM. Off-beat skank guitar, organ bubble, deep bass, one-drop drums, percussion, warm keys. Easy-going melodic vocals with natural harmonies and call-and-response. Warm, spacious, organic.",
  latin: "Latin pop around 100 BPM. Spanish guitar, piano, congas, bongos, timbales, claps, warm bass, brass and accordion accents. Singable choruses, rhythmic verses. Passionate confident vocals with layered harmonies. Colourful, polished, international.",
  folk: "Acoustic folk around 85 BPM. Fingerpicked guitar lead with mandolin, upright bass, soft percussion, light strings, occasional banjo. Intimate, honest, memorable; verses into singable choruses. Natural sincere vocals with subtle harmonies. Organic, handcrafted.",
  gospel: "Modern gospel around 100 BPM. Gospel piano, Hammond organ, live drums, warm bass, tambourine, brass, handclaps. Passionate vocals with a full choir, call-and-response and ad-libs, building to a powerful finale with optional key change. Rich, vibrant, polished.",
  jazz: "Vocal jazz around 90 BPM. Upright bass, brushed drums, warm piano, soft brass, clean guitar, tasteful sax. Relaxed expressive conversational vocals with elegant phrasing and subtle improvisation serving the melody. Intimate, warm, club-quality.",
  blues: "Blues around 80 BPM. Warm electric blues guitar, Hammond organ, piano, deep bass, shuffle drums, occasional harmonica. Authentic full-character vocals with tasteful harmonies and expressive guitar responses. Warm, organic, spacious.",
  funk: "Funk around 110 BPM. Tight slap bass, syncopated rhythm guitar, punchy drums, clavinet, brass stabs, wah guitar, percussion, handclaps. Playful confident rhythmic vocals with group shouts and call-and-response. Tight, vibrant, locked-in groove.",
  disco: "Disco around 120 BPM. Four-on-the-floor kick, funky bass, shimmering strings, brass stabs, rhythm guitar, handclaps, sparkling hi-hats, building to huge singalong choruses. Confident glamorous vocals with rich layered harmonies. Warm, polished, alive.",
  trance: "Vocal trance around 138 BPM. Rolling kicks, offbeat bass, lush pads, soaring supersaw synths, sparkling arpeggios, cinematic risers, building through breakdowns into uplifting drops. Melodic airy vocal hooks. Massive, immersive, dynamic.",
  drill: "Melodic drill around 140 BPM. Sliding 808 bass, sharp hi-hats, crisp snares, dark piano motifs, orchestral textures, atmospheric layers. Rhythmic flow balanced with melodic hooks, accessible without losing drill energy. Clean, punchy, controlled.",
  kwaito: "South African kwaito around 100 BPM. House-inspired basslines, synth stabs, rhythmic percussion, spacious claps, subtle log-drum, hypnotic keys. Relaxed rhythmic conversational vocals with chant backing and repeated hooks. Warm, spacious, proudly South African.",
  "80s cartoon": "80s Saturday-morning cartoon theme around 130 BPM. Bold synth brass, sparkling arpeggiators, slap bass, gated-reverb drums, electric-guitar stabs, playful keys. A huge title-theme chorus. Animated confident vocals with enthusiastic gang vocals and call-and-response. Punchy, colourful, unapologetically 80s.",
  telenovela: "Telenovela theme around 100 BPM. Sweeping strings, grand piano, Spanish nylon guitar, accordion, bandoneon, warm bass, Latin percussion. Dramatic builds into soaring choruses. Passionate theatrical vocals with lush harmonies. Rich, luxurious, cinematic.",
  "action movie": "Blockbuster action score around 120 BPM. Massive orchestral percussion, taiko, powerful brass, soaring strings, distorted synth bass, electric guitar, cinematic impacts and constant momentum into explosive choruses. Bold inspiring vocals with dramatic backing and orchestral swells. Enormous, modern, cinematic.",
  "80s movie theme": "80s movie anthem around 118 BPM. Bright synths, gated-reverb drums, electric guitar, driving bass, shimmering pads, expressive sax solos, building into massive choruses. Powerful heartfelt memorable vocals with rich harmonies. Polished, cinematic, uplifting.",
  "video game": "Video-game soundtrack around 140 BPM. Chiptune synths, square-wave melodies, energetic electronic drums, driving bass, orchestral hits, bright arpeggios, heroic synth leads, building to a triumphant final chorus. Energetic playful memorable vocals with layered hooks. Bold, polished, full of wonder.",
  "national anthem": "Ceremonial anthem around 80 BPM. Full symphony orchestra, soaring strings, French horns, powerful trumpets, timpani rolls, majestic choir. Strong uplifting phrases. Noble confident vocals with choir harmonies on the chorus. Timeless, cinematic, moving.",
  "musical theatre": "Broadway-style musical theatre around 100 BPM. Rich piano, live drums, upright bass, sweeping strings, brass, orchestral flourishes. Expressive verses into show-stopping choruses. Charismatic crystal-clear vocals with ensemble harmonies and theatrical call-and-response. Polished, dynamic, larger than life.",
  "pirate adventure": "Swashbuckling pirate adventure around 110 BPM. Accordion, fiddle, tin whistle, orchestral strings, booming drums, stomps, claps, brass. Adventurous momentum into huge crew-style choruses. Bold charismatic vocals with rowdy crew chants and rich harmonies. Cinematic, energetic, sea-shanty spirit.",
  "space adventure": "Epic space adventure around 115 BPM. Cinematic synthesizers, wide orchestral strings, French horns, pulsing arpeggios, electronic drums, deep sub bass, atmospheric pads, building to soaring triumphant choruses. Confident inspiring vocals with celestial harmonies. Vast, immersive, cinematic.",
  "80s rock anthem": "80s stadium rock anthem around 128 BPM. Big chugging and chiming electric guitars, soaring guitar-solo licks, punchy gated-reverb live drums, driving bass, anthemic synth pads. Powerful lead vocal with huge stacked gang-vocal choruses and fist-pump energy. Wide, polished, arena-sized 80s production.",
  "hard rock": "Hard rock around 132 BPM. Heavy distorted power-chord guitars, screaming lead-guitar solos, pounding live drums, driving bass. Strong gritty lead vocal with gang-vocal shouts on the chorus. Loud, punchy, powerful production.",
  "metal": "Metal around 140 BPM. Heavy palm-muted down-tuned guitars, fast double-kick drums, aggressive riffs, deep driving bass, shredding solos. Powerful intense lead vocal with a big anthemic chorus. Massive, tight, modern metal production.",
  "punk": "Punk rock around 165 BPM. Fast buzzy distorted guitars, simple driving power chords, breakneck drums, punchy bass, shouted gang vocals. Raw, energetic, snappy lead vocal. Loud, fast, garage-energy production.",
};
function normStyle(s) { return (s || "").replace(/[^a-z0-9 ]/gi, "").trim().toLowerCase(); }
function styleFor(s) { return STYLES[normStyle(s)] || normStyle(s) || "pop"; }

/* The Vibe is the ONLY mood we add, a short tag matching exactly what
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
   LYRICS (optional but recommended), write the WORDS with a
   separate AI (ChatGPT or Claude), then Suno sings them. This
   guarantees the person's name lands in every chorus and makes
   the lyrics genuinely good instead of generic.
   LYRICS_PROVIDER in .env:  openai | anthropic | off (default)
   ============================================================ */
const LYRICS_PROVIDER = (process.env.LYRICS_PROVIDER || "off").toLowerCase();

/* ============================================================
   LYRIC WRITER ENGINE (the WORDS channel), see SONGWRITING-ENGINE.md.
   Per song we randomly pick ONE direction from each of six dimensions
   (shape, chorus, verse, bridge, rhyme, writer's voice). ~300k+ combos,
   so two songs of the same genre+vibe still feel like different writers.
   Picks are lightly GUARDED by vibe so we never roll comedy/loud
   directions onto a soft (bedtime/emotional) song. Directions are
   seasoning, the story, genre and vibe always win. Never shown to user.
   ============================================================ */
const LYRIC_CORE_RULES = "Write like a professional songwriter, not a greeting card. Use the details as real material, not a checklist, turn them into moments, images, jokes, memories and hooks, specific enough the song could only be about this person. Natural, singable language; shorter lines beat long crowded ones. Avoid generic filler ('you light up the room', 'one of a kind', 'so special') unless the story earns it. Don't sound corporate or like a school poem. If funny, the humour comes from the details; if heartfelt, no melodrama; if for a child, imaginative not babyish; if romantic, sincere and specific.";
const VARIANCE_RULE = "Treat the creative directions below as seasoning, not rigid rules. If any conflicts with the story, genre or vibe, ignore it and follow the story. Vary structure, rhyme and chorus style between songs, two songs with the same genre and vibe should still feel written by different songwriters.";
const LINE_FLOW = "Keep lines short enough to sing; natural stress; never twist grammar just to rhyme. Important words land on strong beats. Don't cram too many details into one line. Repetition should feel like a hook, not filler, the chorus easier to remember than the verses.";

const LYRIC_SHAPES = [
  {name:'Classic',prompt:'Familiar structure: detail-rich verses, a strong chorus, optional bridge; the last chorus can lift or add a small twist.'},
  {name:'Story First',prompt:'Unfold like a short story; each verse reveals a new moment; the chorus is the emotional summary.'},
  {name:'Chorus First',prompt:'Open at or near the hook so the heart lands early; verses add personality and detail after.'},
  {name:'Slow Build',prompt:'Start small and intimate; let meaning build; save the biggest payoff for later.'},
  {name:'Playful List',prompt:'A rhythmic, clever list of colourful details (only if the story has them), musical, never a plain inventory.'},
  {name:'Anthem',prompt:'Build around a big chantable idea; a chorus a group could sing together; bold, simple, memorable.'},
  {name:'Lullaby',prompt:'Gentle, simple, reassuring; soft imagery and repeated comforting phrases; few details.'},
  {name:'Comedy',prompt:'Set up funny observations in the verses; the chorus lands a simple repeatable comic idea; humour from truth.'},
  {name:'Mini Movie',prompt:'Write like a tiny film, scenes, movement, visual detail you can picture happening.'},
  {name:'One Big Thought',prompt:'Build the whole song around one strong idea; verses explore different angles of it.'},
];
const CHORUS_TYPES = [
  {name:'Name Hook',prompt:'Use the name in the hook only if it sings naturally, the emotional centre, not forced.'},
  {name:'Phrase Hook',prompt:'Build the chorus on a memorable phrase from the story, or a simple original line that sums it up.'},
  {name:'Call And Response',prompt:'A simple call-and-response chorus if the genre supports it, easy to sing back.'},
  {name:'Big Statement',prompt:'A bold emotional statement; simple words, strong rhythm, no over-explaining.'},
  {name:'Tiny Detail Hook',prompt:'Build the chorus on one specific detail, made to feel surprisingly important.'},
  {name:'Singalong Hook',prompt:'Short repeated lines a family or group can sing together.'},
  {name:'Quiet Hook',prompt:'Understated and intimate; memorable because it is honest, not loud.'},
  {name:'Question Hook',prompt:'A simple emotional, funny or memorable question as the hook, if it fits.'},
  {name:'Catchphrase Hook',prompt:'If the user gave a phrase, joke, nickname or saying, consider making it the hook, only if singable.'},
];
const VERSE_TYPES = [
  {name:'Snapshot',prompt:'Each verse is a small scene, show the person doing something, not just described.'},
  {name:'Memory',prompt:'Build memory-like verses from the details; lived-in and specific.'},
  {name:'Character',prompt:'Focus on personality, habits, quirks, favourite things, little behaviours.'},
  {name:'Journey',prompt:'Move through time, from where they began toward who they are now.'},
  {name:'Funny Truth',prompt:'Gentle recognisable truths that make people laugh because they ring true.'},
  {name:'Imaginary World',prompt:'For kids, pets, fantasy or adventure, turn details into a small imaginative world.'},
  {name:'Everyday Magic',prompt:'Make ordinary details feel meaningful; small moments carry the weight.'},
  {name:'Direct Address',prompt:"Write straight to the person, using 'you' naturally."},
];
const BRIDGE_TYPES = [
  {name:'Emotional Turn',prompt:'Reveal a deeper feeling not yet said; sincere and concise.'},
  {name:'Funny Twist',prompt:'A playful surprise or comic twist, only if the song supports it.'},
  {name:'Quiet Moment',prompt:'Strip back; fewer words, more space.'},
  {name:'Final Lift',prompt:'Build into the last chorus with new energy or meaning.'},
  {name:'Perspective Shift',prompt:'Briefly change view, e.g. from describing the person to what they mean to others.'},
  {name:'No Bridge',prompt:'Skip the bridge; keep the structure simpler if that is stronger.'},
];
const RHYME_STYLES = [
  {name:'Simple Natural',prompt:'Clean natural rhymes; use a near-rhyme rather than anything forced.'},
  {name:'Conversational',prompt:"Don't over-rhyme; natural speech shaped into melody."},
  {name:'Playful',prompt:'Fun internal rhymes and wordplay for silly, funny or upbeat songs.'},
  {name:'Poetic',prompt:'Soft near-rhymes, imagery, elegant phrasing; avoid greeting-card rhymes.'},
  {name:'Minimal',prompt:'Rhyme sparingly; let honesty and melody carry it.'},
  {name:'Chant',prompt:'Short rhythmic repeated phrases for chant-style hooks, if the genre supports it.'},
];
const LYRIC_PERSONALITIES = [
  {name:'The Warm Human',prompt:'Warmth, simplicity, emotional honesty, like someone who genuinely cares wrote it.'},
  {name:'The Witty Friend',prompt:'Charm, humour, clever little observations; affectionate, never mean.'},
  {name:'The Big Chorus Writer',prompt:'Find the most singable central idea and build around it; instantly memorable.'},
  {name:'The Detail Collector',prompt:'Use small specific details; make ordinary things feel meaningful.'},
  {name:'The Story Weaver',prompt:'Connect details into a flowing story with a beginning, middle and landing.'},
  {name:'The Childlike Dreamer',prompt:'Imagination, wonder and play, great for kids, pets and adventures.'},
  {name:'The Quiet Poet',prompt:'Gentle imagery, simple beautiful lines; avoid over-explaining.'},
  {name:'The Crowd Pleaser',prompt:'Instantly enjoyable; phrases people can sing, remember and share.'},
  {name:'The Family Comedian',prompt:'Find the funny truth; charming and amusing, not silly by accident.'},
  {name:'The Memory Keeper',prompt:'Write to preserve a moment for years; details that mean more on replay.'},
  {name:'The Tiny Epic Writer',prompt:'Make a small everyday story feel grand without losing its humanity.'},
  {name:'The Straight Talker',prompt:'Plain, direct, emotionally clear; let simple truth do the work.'},
];
const SOFT_VIBES = ['bedtime','emotional','heartfelt','romantic','chill'];
const PLAYFUL_NAMES = ['Comedy','Playful List','Funny Twist','Playful','The Family Comedian','The Witty Friend','Funny Truth'];
const LOUD_NAMES = ['Anthem','Big Statement','Singalong Hook','Call And Response','The Crowd Pleaser'];
function pickFor(arr, vibe) {
  const v = (vibe || "").toLowerCase();
  let pool = arr;
  if (SOFT_VIBES.includes(v)) pool = pool.filter((x) => !PLAYFUL_NAMES.includes(x.name));
  if (v === "bedtime" || v === "emotional") pool = pool.filter((x) => !LOUD_NAMES.includes(x.name));
  if (!pool.length) pool = arr;
  return pool[Math.floor(Math.random() * pool.length)];
}
function buildLyricDirection(vibe) {
  return {
    shape: pickFor(LYRIC_SHAPES, vibe), chorus: pickFor(CHORUS_TYPES, vibe),
    verse: pickFor(VERSE_TYPES, vibe), bridge: pickFor(BRIDGE_TYPES, vibe),
    rhyme: pickFor(RHYME_STYLES, vibe), personality: pickFor(LYRIC_PERSONALITIES, vibe),
  };
}

function lyricBrief({ names, about, genre, category, vibe, pronounce, mustHave }) {
  const first = (names || "").split(/[,&]| and /i)[0].trim() || (names || "them");
  const feel = vibeFeel(vibe);
  const d = buildLyricDirection(vibe);
  const mix = /with a touch of/i.test(genre || "")
    ? `This blends two styles: about 70% the primary with subtle influence from the second, cohesive, never switching styles between sections. `
    : "";
  const must = (mustHave && String(mustHave).trim())
    ? `- MUST include these exact words / phrases / ideas, woven in naturally: ${String(mustHave).trim()}.\n`
    : "";
  const pron = pronounce
    ? `The name is pronounced "${pronounce}", make sure it is sung exactly that way.`
    : `The name may be a regional or non-English name (e.g. South African, African, Indian or other origins). Make sure it is sung and pronounced correctly; if an English-singing voice would likely mispronounce it, spell it phonetically in the lyrics so it sounds right when sung, while keeping it clearly their name.`;
  return `Write original ${genre || "pop"} song lyrics about ${names || "someone special"}.
About them: ${about || "a wonderful person"}. ${feel}${mix}

HOW TO WRITE:
${LYRIC_CORE_RULES}
${VARIANCE_RULE}

CREATIVE DIRECTION for this song (do not mention it; seasoning, not rules):
- Shape: ${d.shape.prompt}
- Chorus: ${d.chorus.prompt}
- Verse: ${d.verse.prompt}
- Bridge: ${d.bridge.prompt}
- Rhyme: ${d.rhyme.prompt}
- Writer's voice: ${d.personality.prompt}
- Line flow: ${LINE_FLOW}

RULES:
- The mood is set by the genre and vibe above, let them lead; match the feeling to this story, not a default.
- The song must clearly be about and feature "${first}", work the name in naturally, not necessarily in every line. ${pron}
- Use the name exactly as spelled; never a nickname; one consistent pronunciation throughout; adjust the melody before distorting the name; don't over-stress it or force awkward rhymes.
${must}- Use section tags on their own lines (e.g. [Verse 1], [Chorus], [Bridge]); let the chosen shape decide the structure.
- Keep it clean, no explicit content. Concise, roughly 16 to 26 lines.
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
      messages: [ { role: "system", content: "You are a world-class songwriter. Follow the brief's writer voice, mood and style exactly, and make every song feel different. Write original, singable, clean lyrics." },
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
      system: "You are a world-class songwriter. Follow the brief's writer voice, mood and style exactly, and make every song feel different. Write original, singable, clean lyrics.",
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
  if (!rateOk(ip)) return res.status(429).json({ error: "Too many songs from this connection, please slow down a bit." });

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
      return res.status(402).json({ error: "no_songs_left", message: "You've used your free songs, grab a Single, an Album, or a Studio Pass to keep making music." });
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

/* Permanently delete the signed-in user's account and all their data
   (App Store Guideline 5.1.1(v) — in-app account deletion). */
app.delete("/api/account", accounts.requireAuth, async (req, res) => {
  if (!accounts.accountsEnabled() || !req.user) return res.status(401).json({ error: "sign_in" });
  try {
    await accounts.deleteAccount(req.user.id);
    res.json({ ok: true });
  } catch (e) {
    console.error("/api/account delete:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================
   CHARTS, social/bragging only. Dark until CHARTS_ENABLED=true.
   ============================================================ */
function chartsOff(res) { return res.status(404).json({ error: "charts_disabled" }); }

/* The Top 40. kind: single | album. */
app.get("/api/charts", async (req, res) => {
  if (!accounts.CHARTS_ENABLED) return chartsOff(res);
  try {
    const kind = req.query.kind === "album" ? "album" : "single";
    const songs = await accounts.listCharts(kind);
    res.json({ enabled: true, kind, songs });
  } catch (e) { console.error("/api/charts:", e.message); res.status(500).json({ error: e.message }); }
});

/* The weekly Hit Parade story. */
app.get("/api/charts/hit-parade", async (req, res) => {
  if (!accounts.CHARTS_ENABLED) return chartsOff(res);
  try { res.json({ enabled: true, parade: await accounts.hitParade() }); }
  catch (e) { console.error("/api/hit-parade:", e.message); res.status(500).json({ error: e.message }); }
});

/* The signed-in creator's House Band + their released songs with positions. */
app.get("/api/charts/me", accounts.requireAuth, async (req, res) => {
  if (!accounts.CHARTS_ENABLED) return chartsOff(res);
  if (!req.user) return res.status(401).json({ error: "sign_in" });
  try {
    const [band, releases] = await Promise.all([accounts.getHouseBand(req.user.id), accounts.myReleases(req.user.id)]);
    res.json({ band, releases });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Name / rename the House Band. */
app.post("/api/charts/band", accounts.requireAuth, async (req, res) => {
  if (!accounts.CHARTS_ENABLED) return chartsOff(res);
  if (!req.user) return res.status(401).json({ error: "sign_in" });
  try { res.json({ band: await accounts.setHouseBand(req.user.id, req.body && req.body.name) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* Release My Song -> debuts on the chart. */
app.post("/api/songs/:id/release", accounts.requireAuth, async (req, res) => {
  if (!accounts.CHARTS_ENABLED) return chartsOff(res);
  if (!req.user) return res.status(401).json({ error: "sign_in" });
  try {
    const b = req.body || {};
    const out = await accounts.releaseToCharts(req.user.id, req.params.id, { releaseTitle: b.title, category: b.category, kind: b.kind });
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* Count a share (the climb lever). */
app.post("/api/songs/:id/share", async (req, res) => {
  if (!accounts.CHARTS_ENABLED) return chartsOff(res);
  try { await accounts.recordShare(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* Public landing card for a shared link (NO audio). Counts as reach. */
app.get("/api/song/:id", async (req, res) => {
  if (!accounts.CHARTS_ENABLED) return chartsOff(res);
  try {
    const song = await accounts.getPublicSong(req.params.id);
    if (!song) return res.status(404).json({ error: "not_found" });
    res.json({ song });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
   Shapes differ per provider, adjust the 3 marked lines to match
   the docs of whichever you pick (APIPASS / Sunor / EvoLink / Apiframe).
   Set THIRDPARTY_BASE and THIRDPARTY_KEY in .env
*/
async function viaThirdParty({ prompt, tags, lyrics, title }) {
  const base = process.env.THIRDPARTY_BASE;
  const key = process.env.THIRDPARTY_KEY;
  if (!base || !key) throw new Error("Set THIRDPARTY_BASE and THIRDPARTY_KEY in .env");

  // (1) start the job, check your provider's request body
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

  // (2) get the job id, field name varies (taskId / id / data.id …)
  const jobId = startData.taskId || startData.id || startData.data?.id;
  if (jobId === undefined) {
    // some providers return the audio URL immediately
    const direct = startData.audioUrl || startData.audio_url || startData.data?.audioUrl;
    if (direct) return { audioUrl: direct };
    throw new Error("No job id / audio from third-party");
  }

  // (3) poll for completion, check your provider's status route + field
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
  // once payment is confirmed (webhook or /api/pay/confirm), never from the browser.
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
      // Yoco Checkout API, amount in cents (ZAR). Docs: https://developer.yoco.com
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
        // In SANDBOX, never send the merchant's own email, PayFast blocks "paying yourself".
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

    // demo: no real charge, credit instantly so the flow is testable end-to-end.
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
   whether the checkout actually completed, then credit, so the browser can
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
