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
const helmet = require("helmet");
const crypto = require("crypto");
require("dotenv").config();
const accounts = require("./accounts");

const app = express();
// Lock CORS to our own web origins. Non-browser clients (native app, server-to-server) send no
// Origin and are allowed; other websites are blocked from calling the API in a browser.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  "https://bandinyourhand.store,https://www.bandinyourhand.store,https://ubiquitous-dieffenbachia-c96feb.netlify.app")
  .split(",").map((s) => s.trim());
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.includes(origin)),
  credentials: false,
}));
app.use(helmet({ contentSecurityPolicy: false })); // security headers (frontend CSP lives on Netlify)
// Keep the raw request body so we can verify webhook signatures (Yoco HMAC, PayFast ITN).
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true, verify: (req, _res, buf) => { req.rawBody = buf; } }));  // PayFast ITN posts form-encoded data

const PROVIDER = (process.env.PROVIDER || "demo").toLowerCase();
const PORT = process.env.PORT || 8787;

/* ============================================================
   CANONICAL PACKS, the SERVER's source of truth for price + qty.
   The client may ask for a packId, but it NEVER sets the amount or
   quantity: both are derived here, so a tampered request can't buy
   more than it pays for. Keep in sync with web PACKS + Apple tiers.
   Prices in cents (ZAR).  WEB ladder: single R18.99 · five R69.99 · ten R119.99
   iOS/legacy: three R49.99 · album R99.99 · pass R199
   ============================================================ */
const PACKS = {
  single:     { qty: 1, cents: 1899, name: "1 song" },
  five:       { qty: 5, cents: 6999, name: "5 songs" },
  ten:        { qty: 10, cents: 11999, name: "10 songs" },
  three:      { qty: 3, cents: 4999, name: "3 tracks" },
  album:      { qty: 7, cents: 9999, name: "7 tracks (album)" },
  studiopass: { qty: 0, cents: 19900, name: "Studio Pass (1 month)", pass: true },
};

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
  "musical theatre": "Modern musical theatre with big Broadway energy. Catchy, story-driven, playful and theatrical. Bright piano, full orchestra, punchy drums, soaring strings, brass stabs and ensemble vocals. Dynamic verses that build into huge singalong choruses, with witty spoken moments, call-and-response sections and memorable hooks. Think joyful stage production meets contemporary pop musical. Funny, heartfelt, expressive and full of personality. Every song should feel like it's performed by a cast telling a story, with clear character voices, dramatic builds, emotional payoff and an uplifting finale. Polished, cinematic, family-friendly, energetic and unforgettable.",
  "pirate adventure": "Swashbuckling pirate adventure around 110 BPM. Accordion, fiddle, tin whistle, orchestral strings, booming drums, stomps, claps, brass. Adventurous momentum into huge crew-style choruses. Bold charismatic vocals with rowdy crew chants and rich harmonies. Cinematic, energetic, sea-shanty spirit.",
  "space adventure": "Epic space adventure around 115 BPM. Cinematic synthesizers, wide orchestral strings, French horns, pulsing arpeggios, electronic drums, deep sub bass, atmospheric pads, building to soaring triumphant choruses. Confident inspiring vocals with celestial harmonies. Vast, immersive, cinematic.",
  "80s rock anthem": "80s stadium rock anthem around 128 BPM. Big chugging and chiming electric guitars, soaring guitar-solo licks, punchy gated-reverb live drums, driving bass, anthemic synth pads. Powerful lead vocal with huge stacked gang-vocal choruses and fist-pump energy. Wide, polished, arena-sized 80s production.",
  "hard rock": "Hard rock around 132 BPM. Heavy distorted power-chord guitars, screaming lead-guitar solos, pounding live drums, driving bass. Strong gritty lead vocal with gang-vocal shouts on the chorus. Loud, punchy, powerful production.",
  "metal": "Metal around 140 BPM. Heavy palm-muted down-tuned guitars, fast double-kick drums, aggressive riffs, deep driving bass, shredding solos. Powerful intense lead vocal with a big anthemic chorus. Massive, tight, modern metal production.",
  "punk": "Punk rock around 165 BPM. Fast buzzy distorted guitars, simple driving power chords, breakneck drums, punchy bass, shouted gang vocals. Raw, energetic, snappy lead vocal. Loud, fast, garage-energy production.",
  "kids tv theme": "Kids' TV show theme around 128 BPM. Bright bouncy synths, cheerful ukulele and piano, playful percussion, hand-claps, glockenspiel sparkles, upbeat bass. A big, simple, sing-along title-theme chorus with a hook kids repeat instantly. Warm friendly lead vocal with excited children's gang vocals and call-and-response. Cheerful, colourful, wholesome, impossibly catchy.",
  "youtube kids": "Modern kids YouTube singalong around 120 BPM. Bubbly nursery-pop synths, plucky marimba, bright piano, claps, playful sound-effects, gentle four-on-the-floor beat. An ultra-catchy repetitive hook built for singing along. Sweet cheerful lead vocal with layered kids' backing vocals. Squeaky-clean, joyful, playful-learning energy.",
  "kids anthem": "Big, uplifting kids' anthem around 120 BPM. Punchy piano and bright guitars, a driving four-on-the-floor beat, hand-claps and foot-stomps, soaring strings lifting into the chorus. A huge arms-in-the-air, chant-along chorus a whole class or family can shout together. Confident warm lead vocal with a massive group children's gang-vocal chorus and call-and-response. Empowering, triumphant, feel-good and joyful.",
};
function normStyle(s) { return (s || "").replace(/[^a-z0-9 ]/gi, "").trim().toLowerCase(); }
function styleFor(s) { return STYLES[normStyle(s)] || normStyle(s) || "pop"; }

/* ------------------------------------------------------------
   VOICE CHARACTER, make the lead vocal distinct PER GENRE so songs
   don't all land on Suno's default voice. Sound-only descriptors (no
   mood words). A rotating texture is added so even two songs in the
   same genre don't sound identical.
   ------------------------------------------------------------ */
const VOICE_BY_GENRE = {
  "pop":"clear, polished, contemporary",
  "rock":"gritty and powerful with edge",
  "country":"warm with a country twang",
  "hip hop":"rhythmic rap delivery with confident flow",
  "rb":"smooth and soulful with runs and melisma",
  "dance":"bright dance-pop tone with light vocal processing",
  "kpop":"crisp, bright and precise",
  "afrobeats":"laid-back and melodic with a West-African lilt",
  "amapiano":"smooth, relaxed and conversational",
  "classical":"trained operatic tone with vibrato",
  "lullaby":"soft, gentle, breathy and intimate",
  "indie":"understated, characterful, slightly lo-fi",
  "house":"airy hook vocal with processing",
  "lofi":"soft, mellow and close-miked",
  "reggae":"relaxed with a gentle patois lilt",
  "latin":"passionate and rhythmic",
  "folk":"natural, intimate and unpolished",
  "gospel":"powerful belt with rich harmonies",
  "jazz":"smoky and expressive with loose phrasing",
  "blues":"raw and soulful with grit",
  "funk":"tight and funky with attitude",
  "disco":"bright, energetic and joyful",
  "trance":"ethereal, processed and soaring",
  "drill":"dark, deadpan rap flow",
  "kwaito":"laid-back, half-sung township flow",
  "metal":"aggressive, with screamed or growled moments where they fit",
  "punk":"snotty, energetic and shouted",
  "hard rock":"raspy and powerful",
  "80s rock anthem":"big, soaring, arena-sized",
  "musical theatre":"theatrical, projected and expressive",
  "national anthem":"grand and proud, choir-backed",
  "pirate adventure":"rowdy, sing-along sea-shanty",
  "space adventure":"epic and cinematic with reverb",
  "80s cartoon":"bright, energetic, retro",
};
const VOICE_TEXTURES = ["warm","raspy","bright","smoky","airy","rich","youthful","mellow","powerful","gravelly","soft","soaring","husky","velvety","clear","breathy"];
function pickRand(arr){ return arr[Math.floor(Math.random() * arr.length)]; }
/* A varied, genre-appropriate lead-vocal description. */
function voiceFor(genreKey, voice) {
  const g = VOICE_BY_GENRE[normStyle(genreKey)];
  const gender = voice === "female" ? "female" : voice === "male" ? "male" : (Math.random() < 0.5 ? "female" : "male");
  const texture = pickRand(VOICE_TEXTURES);
  return g ? `, ${texture} ${gender} lead vocal, ${g}` : `, ${texture} ${gender} lead vocal`;
}

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

/* Light, optional local flavour based on the user's locale (from the browser).
   Seasoning only, kept subtle so it never turns into forced/cringe slang. */
function localeFlavour(locale) {
  const l = (locale || "").toLowerCase();
  if (/(^|[-_])za$/.test(l) || l.startsWith("af")) return "Lightly season with natural South African English where it genuinely fits the story (a little local warmth, the occasional word like 'lekker' or 'just now'), subtle seasoning, never forced, never a whole line of slang.";
  if (/(^|[-_])(gb|ie)$/.test(l)) return "Lightly season with natural British/Irish English turns of phrase where they fit, subtle, never forced.";
  if (/(^|[-_])(au|nz)$/.test(l)) return "Lightly season with natural Australian/New Zealand English where it fits, subtle, never forced.";
  return "";
}
/* ============================================================
   SURPRISE ME, CONCEPT ENGINE
   When the vibe is "Surprise Me" we hand the lyric writer a fun,
   unexpected ANGLE to frame the song around, on top of the usual
   structure variance. Angles are modern, relatable and shareable,
   wrapped lovingly around the REAL person (they stay the hero).
   Pure data, add/remove freely as new fads land.
   SAFETY IS BUILT IN: pop-culture only as light everyday seasoning
   (idioms & formats), never a trademarked world, real celebrities,
   or real song lyrics; always family-safe (no politics, religion,
   tragedy, illness, or anything at the person's expense).
   ============================================================ */
const SURPRISE_ANGLES_UNIVERSAL = [
  "the undefeated champion of the family WhatsApp group (147 unread, mostly from them)",
  "someone whose secret superpower is Jedi mind tricks at bedtime",
  "the household's self-appointed head of security",
  "the one who refuses to ask for directions while the GPS quietly gives up",
  "a thrifty legend on a heroic quest to the cheaper petrol station, running on fumes",
  "the auntie or uncle who caters for thirty when three are coming",
  "the keeper of sacred braai rules that may never be broken",
  "the family member with unmistakable main-character energy",
  "narrated like an over-dramatic nature documentary about their daily habits",
  "framed as an epic movie-trailer voiceover about a very ordinary hero",
  "a telenovela-style saga over something tiny, like the missing TV remote",
  "the reigning final boss of every board-game night",
  "their glow-up story, from back-in-the-day to the legend they are now",
  "the one who 'isn't hungry' and then eats everyone's chips",
  "a tiny lawyer negotiating a later bedtime, clause by clause",
  "the voice-note sender who could have just typed it",
  "the video-call hero whose whole personality is 'you're on mute'",
  "the romantic who gave their partner a full tank of petrol as a birthday gift, and meant it with all their heart",
  "star of an unexpected plot twist that turned out to be the best thing",
  "the household DJ whose road-trip playlist nobody agreed to",
  "the thermostat-war general defending the house from a single degree",
  "the banana-bread champion of the stay-at-home era",
  "the dog or cat who is genuinely convinced they run this household",
];
const SURPRISE_ANGLES_ZA = [
  "the amapiano-loving heart of every family gathering",
  "the one who turns a load-shedding candlelit dinner into pure romance",
  "a braai-master whose tongs are a symbol of high office",
  "the family member who says 'just now' and means sometime this decade",
];
const SURPRISE_ANGLES_SEASONAL = {
  0:  ["the New Year's-resolution hero whose plan lasted a proud three days"],
  8:  ["the Heritage-Day braai commander in full glory"],
  10: ["the one already planning the festive-season family logistics like a general"],
  11: ["the unstoppable force behind the family's festive-season chaos"],
};
const POP_CULTURE_SEASONING = "You MAY sprinkle light, everyday pop-culture seasoning that has entered common speech (e.g. 'Jedi mind trick', 'main-character energy', 'plot twist', 'final boss', 'glow-up', 'speedrun', or telenovela / movie-trailer / nature-documentary styling). Keep it a wink, never the whole song. Do NOT build the song around a trademarked franchise or its characters, do NOT name or impersonate real people or celebrities, and never reproduce real song lyrics.";
const SURPRISE_SAFETY = "Keep it affectionate and firmly WITH the person, celebrating them, never at their expense, never embarrassing. Family-safe: no politics, religion, tragedy, illness, or real public figures. Any cost-of-living or stay-at-home references stay light and playfully nostalgic (thrifty-hero energy, the banana-bread era, the confused dog when everyone stayed home), never money stress, sickness or loss. ALL-AGES IS THE BAR: it must make an 8-year-old AND their mum laugh together, squeaky clean, no innuendo, no crude, edgy or adult humour, nothing you couldn't sing at a kid's birthday party. The funny comes from warmth, silliness and relatable truth, never from edge.";
function pickSurpriseAngle(locale) {
  let pool = SURPRISE_ANGLES_UNIVERSAL.slice();
  const l = (locale || "").toLowerCase();
  if (/(^|[-_])za$/.test(l) || l.startsWith("af")) pool = pool.concat(SURPRISE_ANGLES_ZA);
  const seasonal = SURPRISE_ANGLES_SEASONAL[new Date().getMonth()];
  if (seasonal) pool = pool.concat(seasonal);
  return pool[Math.floor(Math.random() * pool.length)];
}

/* ============================================================
   SURPRISE ME (one tap, NO person), TOPIC ENGINE
   The home "Surprise me" button makes a random, standalone, laugh-out-loud
   song about a fun TOPIC (no name needed). Pure hook: contemporary, clever,
   a bit corny, endlessly shareable. Data only, add fads freely. Same safety
   + pop-culture tiering as the angle engine.
   ============================================================ */
/* HUMAN TRUTHS, the gold. Tiny universal behaviours everyone secretly does.
   The engine favours these over pop culture: the bullseye is a listener pointing
   across the room going "THAT'S YOU!" Add freely. */
const HUMAN_TRUTHS = [
  "hitting snooze with sniper accuracy while completely unconscious, then missing every other alarm",
  "solving every life problem in the shower, then forgetting all of it before the towel",
  "being physically unable to speak before the first coffee",
  "a password needing an uppercase, a number, a symbol and a childhood fear, then forgetting it instantly",
  "everyone secretly pretending they know how to fold a fitted sheet",
  "going in for milk and leaving with candles, chips, batteries and a kayak, but no milk",
  "hunting for your phone using the flashlight on your phone",
  "searching the whole couch, then accusing the kids, who were holding the remote",
  "'I know a quicker way', arriving forty-two minutes late",
  "owning seventeen charging cables and not one of them fits",
  "hitting 2% battery and suddenly becoming the fastest texter alive",
  "opening the fridge, closing it, opening it again hoping food has appeared",
  "'I'll just have something small' becoming a three-course meal at 11:47pm",
  "347 unread messages: read exactly one, mark all as read",
  "screenshotting everything and never once looking at it again",
  "saying 'what?' and then understanding halfway through the repeat",
  "turning the TV volume down so you can taste the food better",
  "car keys vanishing inside your own house, then reappearing in your hand",
  "the one sock that disappears in the wash and is never seen again",
  "packing for rain, snow, safari and dinner with royalty, for a two-day trip",
  "washing the car so it starts raining immediately",
  "always, somehow, choosing the slowest queue",
  "never trusting the microwave, stopping it at one second, every single time",
  "spending forty-five minutes choosing on Netflix, then falling asleep in the intro",
  "'I'm only having one spoon' and the whole tub is gone",
  "driving eighteen kilometres to save four rand on petrol",
  "getting genuinely thrilled about a new vacuum, socks on special, or working Wi-Fi",
  "'I'll remember that', never, ever remembering",
  "procrastination: proudly making it tomorrow's problem",
  "impossible to wake at 5am for work, wide awake at 4:58am for a holiday",
  "picking up the phone, forgetting why, putting it down, instantly remembering",
  "'I don't want fries', then eating half of yours",
  "the thermostat war: one person freezing, one boiling, neither ever compromising",
  "the meeting ends and immediately the real meeting begins in the car park",
  "turning your phone face-down so nobody knows you're ignoring them, while ignoring them",
  "reading a message, replying to it perfectly in your head, never actually replying",
  "unlocking your phone to do one thing, forgetting it, checking Instagram instead",
  "taking twenty photos to keep exactly one",
  "declaring 19% battery 'basically dead' and rushing to charge",
  "saying 'I'll Google it' before anyone has finished the question",
  "burning your mouth because you could not wait five seconds",
  "cutting the pizza into tiny slices to pretend you ate less",
  "buying healthy groceries and immediately ordering takeaway",
  "deciding dessert doesn't count if you eat it standing up",
  "lying awake calculating exactly how tired you'll be tomorrow",
  "waking two minutes before the alarm and feeling personally cheated",
  "a 'quick nap' that somehow ends tomorrow",
  "buying it because it was on sale, not because you needed it",
  "carrying seventeen shopping bags in one trip to avoid a second one",
  "walking into a room and completely forgetting why",
  "going upstairs for one thing and coming back with a different thing",
  "leaving the lights on in rooms you left an hour ago",
  "talking to yourself because nobody else grasps the situation",
  "cleaning the house before the cleaner arrives",
  "turning the music down so you can park properly",
  "talking to your car like it can hear you",
  "shouting 'watch out!' from the passenger seat two seconds too late",
  "thanking a driver who let you merge, who absolutely cannot hear you",
  "jiggling the mouse so the computer doesn't look idle",
  "starting every task by first making a coffee",
  "answering three emails and calling it a busy day",
  "buying the gym clothes instead of going to the gym",
  "rewarding a 200-calorie workout with pizza",
  "moving clutter from one room to another and calling it tidying",
  "vacuuming around the thing instead of moving the thing",
  "the one chair that exists purely to hold clothes",
  "nodding along even though you didn't hear a single word",
  "thinking of the perfect comeback three hours too late",
  "feeling personally attacked by an autocorrect suggestion",
  "looking everywhere for the glasses you are currently wearing",
  "saying 'ouch' to the furniture that hurt you",
  "the dog greeting you like you've been gone ten years after a five-minute trip",
  "the cat looking deeply offended that you exist",
  "pressing the remote harder as if that adds power",
  "restarting it, because that's the only IT advice anyone knows",
  "47 browser tabs open because 'I'll read that later'",
  "the child ignoring the gift to play with the cardboard box",
  "suddenly needing the toilet the exact moment you leave the house",
];
/* LEVEL 2, GENERATIONAL TRUTHS (recognisable to a generation). */
const GENERATIONAL_TRUTHS = [
  "the screech of dial-up internet and the patience it demanded",
  "MSN Messenger nudges and cryptic away-message feelings",
  "Friday night at the video store choosing the wrong film",
  "waiting all night for one song to download (and getting a virus)",
  "keeping a Tamagotchi alive, and the guilt when you didn't",
  "making someone a cassette mixtape to say what you couldn't",
  "the DVD menu music looping into infinity",
  "Snake on an old Nokia and a ringtone you chose with pride",
  "rewinding the tape before returning it, purely out of honour",
  "blowing into a game cartridge to make it work",
];
/* LEVEL 3, CULTURAL TRUTHS (locale-flavoured; only surfaced when it fits). */
const CULTURAL_TRUTHS = [
  "braai etiquette and the sacred question of who holds the tongs",
  "the family WhatsApp group and its 274 unread messages",
  "planning the whole evening around the load-shedding schedule",
  "a Sunday lunch cooked to feed a small village",
  "the great road-trip snack negotiation",
  "petrol-price panic and the detour to save four rand",
  "'just now' versus 'now-now', a national timing mystery",
  "rationing the last of the biltong like buried treasure",
  "amapiano quietly taking over every family gathering",
  "waiting at the robot that everyone else calls a traffic light",
];
/* Combined pool the Comedy Engine samples for 'write in this spirit' examples. */
const ALL_TRUTHS = HUMAN_TRUTHS.concat(GENERATIONAL_TRUTHS, CULTURAL_TRUTHS);

const SURPRISE_TOPICS_UNIVERSAL = [
  "dad jokes so bad they loop back to funny",
  "the family group chat at 2am",
  "'you're on mute', the eternal video-call anthem",
  "running out of data at the worst possible moment",
  "Monday morning versus the snooze button",
  "the office coffee machine and its secret power over us all",
  "the GPS that confidently drives you into a field",
  "the fridge you open fourteen times hoping for new snacks",
  "a house cat quietly plotting world domination",
  "the Wi-Fi router: the most powerful being in the home",
  "the never-ending search for the TV remote",
  "the printer that can smell your fear",
  "trying (and failing) to fold a fitted sheet",
  "autocorrect and its greatest betrayals",
  "the friend who says 'I'm 5 minutes away' (they are not)",
  "Sunday naps: a great romance",
  "parallel parking while everyone watches",
  "a Wookiee's well-earned day off",
  "the group project where one person did everything",
  "gym membership guilt in musical form",
  "the family WhatsApp group with 274 unread messages",
  "the relative who forwards absolutely everything",
  "the uncle who knows a secret shortcut for everything",
  "the cousin who still hasn't left after Christmas",
  "voice notes longer than a feature film",
  "accidentally hitting reply-all to the whole company",
  "low-battery anxiety at 2 percent",
  "the meeting that could have been an email",
  "the video-call camera strategically left off",
  "negotiating bedtime with a four-year-old lawyer",
  "the snack demanded three minutes after dinner",
  "a goldfish with completely unexplained confidence",
  "the reverse-park that became an Olympic event",
  "missing the turn because everyone was singing",
  "the mixtape made to say what you couldn't out loud",
  "dial-up internet and the patience of saints",
  "the DVD menu music stuck on infinite loop",
  "frosted tips and other crimes of the early 2000s",
  "the Tamagotchi you let down and never forgot",
  "leftovers claimed with the passion of a blood feud",
];
const SURPRISE_TOPICS_ZA = [
  "braai tongs and the men sworn to guard them",
  "'just now', a great South African mystery",
  "the heroic saga of surviving load-shedding",
  "amapiano quietly taking over every family gathering",
];
function pickSurpriseTopic(locale) {
  const l = (locale || "").toLowerCase();
  const za = /(^|[-_])za$/.test(l) || l.startsWith("af");
  // Level 1 universal truths lead (x2), then generational + the wider topic bank;
  // Level 3 cultural truths only surface when the locale fits.
  let pool = HUMAN_TRUTHS.concat(HUMAN_TRUTHS, GENERATIONAL_TRUTHS, SURPRISE_TOPICS_UNIVERSAL);
  if (za) pool = pool.concat(CULTURAL_TRUTHS, SURPRISE_TOPICS_ZA);
  return pool[Math.floor(Math.random() * pool.length)];
}

/* ============================================================
   THE COMEDY ENGINE (shared by both Surprise modes)
   Comedy is the #1 job. We rotate a narrator voice + a few comic
   techniques + light pop-culture seasoning, and end with a silent
   quality-control pass, so no two surprises feel like cousins.
   Pure data, extend the banks freely.
   ============================================================ */
function pickN(arr, n) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); }
const COMEDY_TECHNIQUES = [
  "Escalation: start small and reasonable, then push the idea further every verse until it's gloriously out of hand.",
  "Rule of three: build a little list where the third item is the unexpected, funnier one.",
  "Fake seriousness: treat something tiny and silly with the gravity of a national emergency.",
  "Absurd comparison: measure the everyday thing against something epic and ridiculous.",
  "Understatement: react to something enormous with total, deadpan calm.",
  "Hyperbole: blow the small thing up to legendary, mythic scale.",
  "Running gag: plant a silly phrase early, then bring it back bigger in the chorus and the outro.",
  "Unexpected turn: set up an ordinary line, then swerve somewhere ridiculous.",
  "Deadpan: deliver the most ridiculous lines like they're simply obvious facts.",
  "Specific detail: invent tiny, oddly-specific details that feel weirdly true.",
];
const COMEDY_NARRATORS = [
  "an overdramatic nature documentarian",
  "a booming movie-trailer voice",
  "a reality-TV confessional to camera",
  "a sports commentator calling it live",
  "a wise elder passing down a legend",
  "an infomercial host who believes far too much",
  "a superhero origin-story narrator",
  "a courtroom lawyer making an impassioned case",
];
const POP_CULTURE_REFS = [
  "Jedi mind trick", "main-character energy", "final boss", "plot twist", "glow-up",
  "side quest", "NPC energy", "speedrun", "canon event", "origin story",
  "movie-trailer voice", "boss battle", "nature-documentary narration", "reality-TV confessional",
];
// Internal creative DNA (never shown, never in output): borrow the ENERGY of the
// greats, understand WHY they land, never copy, name, imitate a specific song,
// or reproduce anyone's lyrics.
const COMEDY_DNA = "Channel the fearless spirit of the great comedy songwriters, the ridiculous imagination and commitment of Weird Al, the absurd escalation of The Lonely Island, the deadpan brilliance of Flight of the Conchords, the clever observation of Bo Burnham, the wit of Tim Minchin, the theatrical over-commitment of Tenacious D, and the warm everyday eye of Trevor Noah. Understand WHY they land, total commitment to a silly idea, unexpected turns, tiny relatable truths, and zero embarrassment. Do NOT copy them, imitate a specific song, name any of them anywhere, or reproduce anyone's lyrics; only borrow that fearless energy. IMPORTANT: several of these acts are edgy or adult, take ONLY their craft, commitment and cleverness, never their content. Every song must stay 100% all-ages clean.";
function comedyBrief() {
  const techniques = pickN(COMEDY_TECHNIQUES, 3);
  const narrator = pickRand(COMEDY_NARRATORS);
  const refs = pickN(POP_CULTURE_REFS, 3);
  const spirit = pickN(ALL_TRUTHS, 6);
  return `COMEDY IS THE #1 JOB (the music must still be great, still rhyme, still make sense, but above all, be genuinely, laugh-out-loud funny, not "AI funny").
CORE RULE, prioritise HUMAN TRUTHS over pop culture: the tiny, universal, everyday behaviours everyone secretly does. Pop culture makes people RECOGNISE the joke; human truths make people BECOME the joke. Aim for the moment a listener points across the room and yells "THAT'S YOU!" Pile in oddly-specific, painfully-relatable little details.
DUAL-LAYER, ALL-AGES: it must be humour a KID instantly gets AND that adults genuinely find funny, a shared laugh, layered so both crack up. Squeaky clean, warm and silly, never edgy or adult.
${COMEDY_DNA}
HUMAN-TRUTH SPIRIT, these show the flavour and calibrate your comedic eye: ${spirit.join("; ")}. Mine your subject for oddly-specific, painfully-relatable detail, and invent fresh observations we haven't listed.
Write it in the voice of ${narrator}.
Lean on at least two of these comic techniques (never name them):
${techniques.map((t) => "- " + t).join("\n")}
You MAY sprinkle a couple of these as light seasoning, never the whole joke: ${refs.join(", ")}.
Never stop at the first funny idea, push it, then push it again, then once more.
CHORUS, this is the money moment: one big, addictive, shout-along hook built around a single killer line (ideally a phrase people could quote back). It should be the FUNNIEST, most repeatable part of the whole song, and land a grin before it finishes. Repeat that hook line; don't rewrite the chorus every time.
BRIDGE, the bridge must TURN, not just repeat: a fresh angle, a sudden reveal, a confession, or one more escalation that makes the last chorus hit harder ("oh no, it's even worse than we thought"). Never use the bridge as filler.
WORDPLAY, earn the "clever": lean on puns, double meanings, unexpected internal rhymes and a setup-then-swerve. Rhymes should feel surprising and effortless, never forced or nursery-rhyme obvious.
BUTTON, end on a strong closing line that lands the joke one final time (a punchline, a callback, or a tiny twist), so the song finishes on a laugh, not a fade.
NO FILLER, every single line must carry a joke, a vivid image, or an escalation. Cut any line that's just there to rhyme.
Before you finish, silently check: would a kid laugh AND would an adult? is it surprising and original (not a joke we've all heard)? is the chorus addictive and quotable? does the bridge actually turn? is the wordplay genuinely clever? is there a strong closing button? is it squeaky clean? does it avoid sounding AI-generated? would someone screenshot and share it? If any answer is "no", rewrite until it's "yes".`;
}

function topicLyricBrief({ topic, genre, locale }) {
  const flavour = localeFlavour(locale);
  const d = buildLyricDirection("funny");
  // Rotate the song's shape: sometimes ONE theme committed + escalated, sometimes
  // a "we all do this" slice-of-life montage of several truths under one chorus.
  const medley = Math.random() < 0.4;
  const extra = medley ? pickN(ALL_TRUTHS.filter((t) => t !== topic), 4) : [];
  const premise = medley
    ? `SLICE-OF-LIFE MODE: a funny "we all secretly do this" song about everyday life. Weave these true little moments together under ONE unifying, shout-along chorus about how gloriously relatable we all are:\n- ${topic}\n${extra.map((t) => "- " + t).join("\n")}\nLet the verses hop between them; the chorus is the glue that ties it into one song.`
    : `SINGLE-THEME MODE: the whole song is about ONE thing, ${topic}, and nothing else. Build a little story that ESCALATES across the verses (funnier and more out of hand each time), and make the CHORUS one repeatable, shout-along hook all about this exact thing. Don't wander.`;
  return `You are the funniest songwriter alive. Write a STANDALONE, laugh-out-loud comedy song, original ${genre || "pop"}. No specific real person; everyday life is the star, so go wild celebrating and gently roasting it.
${premise}${flavour ? "\n" + flavour : ""}

${comedyBrief()}

CRAFT:
${LYRIC_CORE_RULES}
${LINE_FLOW}
- Structure/shape for this one: ${d.shape.prompt}
${POP_CULTURE_SEASONING}
${SURPRISE_SAFETY}

FORMAT: section tags on their own lines (e.g. [Verse 1], [Chorus], [Bridge]); roughly 16 to 26 lines; clean, no explicit content. Output ONLY the lyrics with the section tags. Nothing else.`;
}

function lyricBrief({ names, about, genre, category, vibe, pronounce, mustHave, locale }) {
  const first = (names || "").split(/[,&]| and /i)[0].trim() || (names || "them");
  const feel = vibeFeel(vibe);
  const flavour = localeFlavour(locale);
  const d = buildLyricDirection(vibe);
  const surprise = (normStyle(vibe) === "surprise me")
    ? `\n\nSURPRISE ME, a funny, shareable song that revolves around THIS person; their tiny habits become mythology. Frame it around this comic angle, adapting it to the real details about them (they're the loved hero, never the punchline): ${pickSurpriseAngle(locale)}.\n\n${comedyBrief()}\n${POP_CULTURE_SEASONING}\n${SURPRISE_SAFETY}`
    : "";
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
About them: ${about || "a wonderful person"}. ${feel}${mix}${flavour ? "\n" + flavour : ""}${surprise}

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
- Match the register of what the writer gave you. Never add strong language of your own, but if their details, must-have words or their own lyrics use it, keep it in and let it land naturally rather than softening or censoring it. If the song is about a child, keep it clean regardless. Concise, roughly 16 to 26 lines.
Output ONLY the lyrics with the section tags. Nothing else.`;
}

const LYRICS_SYSTEM = "You are a world-class comedy songwriter. Follow the brief's writer voice, mood and style exactly, and make every song feel different. Write original, singable, laugh-out-loud lyrics with clever wordplay, an addictive chorus and a bridge that turns. Match the writer's register: never introduce strong language yourself, but never censor theirs either.";

async function writeLyrics(input) {
  try {
    const isSurprise = !!input.surpriseTopic || normStyle(input.vibe) === "surprise me";
    const brief = input.surpriseTopic ? topicLyricBrief(input) : lyricBrief(input);
    // Surprise Me = comedy is the whole point, so run a two-model bake-off and keep
    // the funnier result. Everything else stays on the fast, cheap path.
    if (isSurprise) {
      const best = await lyricsBestOf(brief);
      if (best) return best;
    }
    if (LYRICS_PROVIDER === "openai") return await lyricsOpenAI(brief);
    if (LYRICS_PROVIDER === "anthropic") return await lyricsAnthropic(brief);
  } catch (e) { console.error("lyrics failed (Suno will write them instead):", e.message); }
  return null;
}

// Two-model bake-off for Surprise Me: write with Claude Sonnet AND GPT-4o in
// parallel, then judge which is funnier/most singable and return the winner.
// Degrades gracefully, if only one model responds, we use it; if the judge
// fails, we keep the first good candidate.
async function lyricsBestOf(brief) {
  const results = await Promise.allSettled([
    lyricsAnthropic(brief, { model: "claude-sonnet-4-6", maxTokens: 900 }),
    lyricsOpenAI(brief, { model: "gpt-4o", maxTokens: 900 }),
  ]);
  const cands = [];
  if (results[0].status === "fulfilled" && results[0].value) cands.push({ src: "sonnet", text: results[0].value });
  if (results[1].status === "fulfilled" && results[1].value) cands.push({ src: "gpt-4o", text: results[1].value });
  results.forEach((r) => { if (r.status === "rejected") console.warn("bake-off candidate failed:", r.reason && r.reason.message); });
  if (cands.length === 0) return null;
  if (cands.length === 1) return cands[0].text;
  try {
    const winner = await judgeLyrics(cands.map((c) => c.text));
    if (winner >= 0 && cands[winner]) return cands[winner].text;
  } catch (e) { console.warn("lyric judge failed, using first candidate:", e.message); }
  return cands[0].text;
}

// Cheap, fast judge, picks the funniest, most singable option. Returns index.
async function judgeLyrics(options) {
  const key = process.env.OPENAI_API_KEY; if (!key) return 0;
  const labelled = options.map((o, i) => `OPTION ${i + 1}:\n${o}`).join("\n\n---\n\n");
  const prompt = `You are a ruthless comedy-song editor. Two versions of the SAME song brief are below. Pick the ONE that is genuinely funnier and more shareable, judged on: laugh-out-loud jokes, clever wordplay, an addictive quotable chorus, a bridge that actually turns, a strong closing button, and singability. It must be squeaky-clean all-ages. Reply with ONLY the number of the best option (e.g. "1" or "2"), nothing else.\n\n${labelled}`;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0, max_tokens: 3,
      messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error("judge " + r.status);
  const d = await r.json();
  const txt = (d.choices && d.choices[0] && d.choices[0].message.content || "").trim();
  const n = parseInt((txt.match(/\d+/) || ["1"])[0], 10);
  return isNaN(n) ? 0 : Math.max(0, Math.min(options.length - 1, n - 1));
}

async function lyricsOpenAI(brief, opts = {}) {
  const key = process.env.OPENAI_API_KEY; if (!key) throw new Error("Set OPENAI_API_KEY");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: opts.model || "gpt-4o-mini", temperature: 0.9, max_tokens: opts.maxTokens || 500,
      messages: [ { role: "system", content: LYRICS_SYSTEM },
                  { role: "user", content: brief } ] }),
  });
  if (!r.ok) throw new Error("OpenAI " + r.status);
  const d = await r.json(); return (d.choices && d.choices[0] && d.choices[0].message.content || "").trim() || null;
}
async function lyricsAnthropic(brief, opts = {}) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) throw new Error("Set ANTHROPIC_API_KEY");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: opts.model || "claude-3-5-haiku-latest", max_tokens: opts.maxTokens || 600,
      system: LYRICS_SYSTEM,
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
/* In-memory idempotency for song generation. A single create tap can reach us
   more than once (mobile networks are flaky and a real song takes 30-90s, so the
   app may decide the request failed and retry). Generating is NOT free, it claims
   a credit and burns Suno time, so a naive retry made the SAME song several times
   and charged for each. Keyed by the client's requestId, we run the work once and
   hand every duplicate the exact same result, no extra charge. Single-instance
   store; the 5-min TTL is just cleanup, well past any realistic retry window. */
const genIdem = new Map(); // requestId -> Promise<payload>

/* Soft daily generation ceiling. A runaway/viral day, or an abuse burst, can
   otherwise quietly drain the Suno balance in a few hours. GEN_DAILY_CAP is the
   max songs generated per day (0 or unset = no cap). Reserves a slot only when
   we're actually about to generate, so failed/blocked requests don't waste it. */
let genDay = "", genCount = 0;
function genDailyOk() {
  const CAP = parseInt(process.env.GEN_DAILY_CAP || "0", 10);
  if (!CAP || CAP <= 0) return true;
  const today = new Date().toISOString().slice(0, 10);
  if (today !== genDay) { genDay = today; genCount = 0; }
  if (genCount >= CAP) return false;
  genCount++; return true;
}

app.post("/api/generate", accounts.requireAuth, async (req, res) => {
  const requestId = req.body && req.body.requestId;
  if (requestId && genIdem.has(requestId)) {
    // Duplicate of an in-flight or just-finished request: return the same
    // outcome instead of making (and charging for) another song.
    try { return res.json(await genIdem.get(requestId)); }
    catch (e) { return res.status(e.httpStatus || 502).json(e.payload || { error: "Generation failed", detail: e.message }); }
  }
  const work = runGenerate(req);
  if (requestId) { genIdem.set(requestId, work); setTimeout(() => genIdem.delete(requestId), 5 * 60 * 1000); }
  try { res.json(await work); }
  catch (e) { res.status(e.httpStatus || 502).json(e.payload || { error: "Generation failed", detail: e.message }); }
});

// Typed error so the idempotency wrapper can reproduce the exact HTTP response
// for the first caller and every duplicate alike.
function genErr(httpStatus, payload) { const e = new Error(payload.error || "generate"); e.httpStatus = httpStatus; e.payload = payload; return e; }

async function runGenerate(req) {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
  if (!rateOk(ip)) throw genErr(429, { error: "Too many songs from this connection, please slow down a bit." });

  const { title, genre, genre2, bandChoice, voice, prompt, lyrics, mustHave, names, about, category, mood, vibe, pronounce, fingerprint, locale, surpriseTopic } = req.body || {};
  const primary = mood || genre;
  const isBandChoice = !!bandChoice || normStyle(primary) === "bands choice";
  const influenceName = (genre2 && !isBandChoice) ? genre2 : "";
  const primaryStyle = isBandChoice
    ? "the band chooses the most fitting musical style for this song"
    : styleFor(primary);
  const influence = influenceName ? `, with noticeable ${influenceName} influences (keep it primarily ${primary}, not a 50/50 blend)` : "";
  const voiceTag = voiceFor(genre, voice);
  // Approximate Suno's "follow style" high + a touch of "weirdness": stay true
  // to the genre but allow a few distinctive, unexpected production touches.
  const styleNudge = ", true to the style with a few tasteful, unexpected production touches";
  const tags = primaryStyle + influence + vibeTag(vibe) + voiceTag + styleNudge;
  const lyricGenre = isBandChoice ? "" : (influenceName ? `${primary} with a touch of ${influenceName}` : primary);
  // Surprise Me (one tap, no person): the band writes a standalone, hilarious
  // song about a random fun topic. Otherwise build the usual person/story prompt.
  const topic = surpriseTopic ? pickSurpriseTopic(locale) : "";
  const songTitle = surpriseTopic ? topic : title;
  const fullPrompt = surpriseTopic
    ? `A hilarious, clever, slightly corny standalone song all about: ${topic}. Have a blast with the topic itself; there is no specific person.`
    : buildSongPrompt({ names, about, category, mood: isBandChoice ? "" : primary, fallback: prompt, bandChoice: isBandChoice, genre2: influenceName });
  if (!fullPrompt) throw genErr(400, { error: "Missing prompt" });

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
      throw genErr(500, { error: "Could not check your song balance. Try again." });
    }
    if (mode === "none") {
      throw genErr(402, { error: "no_songs_left", message: "You've used your free songs, grab a Single, an Album, or a Studio Pass to keep making music." });
    }
  }

  // Daily cost ceiling: if the studio's maxed out for today, hand the just-claimed
  // song back (so nothing is spent) and gently ask them to come back tomorrow.
  if (!genDailyOk()) {
    if (accounts.accountsEnabled() && req.user) {
      if (mode === "pass") await accounts.releasePassSong(req.user.id);
      else if (mode === "paid" || mode === "free") await accounts.releaseSong(req.user.id, fingerprint, mode);
    }
    throw genErr(503, { error: "studio_busy", message: "Our little studio is at capacity for today, even the band needs a rest! Nothing was used. Try again tomorrow and your song will be waiting 💛" });
  }

  try {
    // Write the words first (locks the name into every chorus). Falls back to
    // Suno's own lyrics if LYRICS_PROVIDER is off or the call fails.
    let finalLyrics = lyrics;
    if (!finalLyrics && LYRICS_PROVIDER !== "off") finalLyrics = await writeLyrics({ names, about, genre: lyricGenre, category, vibe, pronounce, mustHave, locale, surpriseTopic, topic });

    let out;
    if (PROVIDER === "apiframe")        out = await viaApiframe({ title: songTitle, tags, prompt: fullPrompt, lyrics: finalLyrics });
    else if (PROVIDER === "selfhost")   out = await viaSelfHost({ title: songTitle, tags, prompt: fullPrompt, lyrics: finalLyrics });
    else if (PROVIDER === "thirdparty") out = await viaThirdParty({ title: songTitle, tags, prompt: fullPrompt, lyrics: finalLyrics });
    else                                out = await viaDemo();

    if (!out || !out.audioUrl) throw new Error("No audio returned");

    // success: pull a PERMANENT copy into our own storage (so the track can
    // never vanish when Suno's temporary link expires), then return the
    // permanent urls + the user's fresh balance.
    let status = null, savedId = null;
    if (accounts.accountsEnabled() && req.user) {
      const saved = await accounts.recordSong(req.user.id, {
        title: songTitle, genre: mood || genre, names,
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
    return { ...out, savedId, provider: PROVIDER, status, title: songTitle };
  } catch (err) {
    // our failure, not theirs: give the song back
    if (accounts.accountsEnabled() && req.user) {
      if (mode === "pass") await accounts.releasePassSong(req.user.id);
      else if (mode === "paid" || mode === "free") await accounts.releaseSong(req.user.id, fingerprint, mode);
    }
    console.error("generate failed:", err.message);
    throw genErr(502, { error: "song_failed", message: "The band hit a snag and couldn’t finish that one, nothing was used, so your song is still yours to make. Give it another go in a moment 🎸", detail: err.message });
  }
}

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
   (App Store Guideline 5.1.1(v), in-app account deletion). */
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
      prompt: lyrics || prompt, // lyrics if provided, else let Suno write them
      tags, // genre/style preset
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

/* PayFast/PHP-compatible urlencode. Like encodeURIComponent but ALSO encodes ()!*'~
   and spaces as "+", so our signature byte-matches PayFast's PHP urlencode. Without
   this, any value with brackets (e.g. "Studio Pass (1 month)") fails signature checks. */
function pfUrlEncode(v) {
  return encodeURIComponent(String(v).trim()).replace(/%20/g, "+")
    .replace(/[!'()*~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
/* PayFast requires an md5 signature of the fields (in order) + your passphrase. */
function payfastSignature(fields, passphrase) {
  let str = Object.keys(fields)
    .filter((k) => fields[k] !== "" && fields[k] !== undefined && fields[k] !== null)
    .map((k) => `${k}=${pfUrlEncode(fields[k])}`)
    .join("&");
  if (passphrase) str += `&passphrase=${pfUrlEncode(passphrase)}`;
  return crypto.createHash("md5").update(str).digest("hex");
}

/* ---- Webhook authenticity (both providers). Fail CLOSED: if we can't prove a
   webhook is genuine, we do NOT credit. Legit Yoco payments are still credited by
   /api/pay/confirm, which verifies with Yoco's API directly. ---- */

/* Verify a Yoco webhook signature (Svix-style HMAC over id.timestamp.rawBody). */
function verifyYocoSignature(req) {
  try {
    const secret = process.env.YOCO_WEBHOOK_SECRET;      // 'whsec_...' from the Yoco dashboard
    if (!secret) return false;
    const id = req.headers["webhook-id"];
    const ts = req.headers["webhook-timestamp"];
    const sigHeader = req.headers["webhook-signature"] || "";
    if (!id || !ts || !sigHeader || !req.rawBody) return false;
    const signedContent = `${id}.${ts}.${req.rawBody.toString("utf8")}`;
    const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    const expected = crypto.createHmac("sha256", key).update(signedContent).digest("base64");
    // header can hold several space-separated "v1,<sig>" values, match any, in constant time.
    return sigHeader.split(" ").map((p) => p.split(",")[1]).filter(Boolean).some((p) => {
      try { return crypto.timingSafeEqual(Buffer.from(p), Buffer.from(expected)); } catch { return false; }
    });
  } catch (e) { console.error("verifyYocoSignature:", e.message); return false; }
}

/* Verify a PayFast ITN: (1) recompute + match the md5 signature, (2) confirm the
   POST really came from PayFast via their server-to-server validate endpoint. */
async function verifyPayfastItn(body, req) {
  try {
    const passphrase = process.env.PAYFAST_PASSPHRASE || "";
    const entries = Object.entries(body).filter(([k]) => k !== "signature");
    const pfEncode = pfUrlEncode;
    let str = entries.map(([k, v]) => `${k}=${pfEncode(v)}`).join("&");
    if (passphrase) str += `&passphrase=${pfEncode(passphrase)}`;
    const expected = crypto.createHash("md5").update(str).digest("hex");
    if (!body.signature || body.signature !== expected) { console.warn("payfast sig mismatch"); return false; }
    const host = process.env.PAYFAST_SANDBOX === "true" ? "https://sandbox.payfast.co.za" : "https://www.payfast.co.za";
    const postback = req.rawBody ? req.rawBody.toString("utf8")
      : entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v).trim())}`).join("&");
    const r = await fetch(`${host}/eng/query/validate`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: postback,
    });
    const txt = (await r.text()).trim();
    if (!/^VALID/i.test(txt)) { console.warn("payfast validate not VALID:", txt.slice(0, 40)); return false; }
    return true;
  } catch (e) { console.error("verifyPayfastItn:", e.message); return false; }
}

app.post("/api/pay/create", accounts.requireAuth, async (req, res) => {
  const { packId, email, kind } = req.body || {};
  const isPass = kind === "pass" || packId === "studiopass";
  // SERVER decides price + quantity from the canonical PACKS table. Any client-sent
  // amount/qty is ignored, this is what stops "buy 100 credits for 1 cent".
  const pack = PACKS[isPass ? "studiopass" : packId];
  if (!pack) return res.status(400).json({ error: "Unknown pack" });
  const amount = pack.cents / 100;   // ZAR, used by the provider calls below
  const useQty = pack.qty;
  const itemName = `Band in Your Hand - ${pack.name}`;

  // Record the order server-side FIRST (pending). Credits/pass are only granted
  // once payment is confirmed (webhook or /api/pay/confirm), never from the browser.
  let orderId = null;
  if (accounts.accountsEnabled() && req.user) {
    try {
      orderId = await accounts.createOrder({ userId: req.user.id, packId: isPass ? "studiopass" : packId, qty: useQty, amountCents: pack.cents });
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
          metadata: { orderId: orderId || "", packId, qty: useQty, email },
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
      const pfEncode = pfUrlEncode;
      const entries = Object.entries(fields).filter(([, v]) => v !== "" && v !== undefined && v !== null);
      const paramStr = entries.map(([k, v]) => `${k}=${pfEncode(v)}`).join("&");
      const pass = process.env.PAYFAST_PASSPHRASE;
      const sigBase = paramStr + (pass ? `&passphrase=${pfEncode(pass)}` : "");
      const signature = crypto.createHash("md5").update(sigBase).digest("hex");
      const redirectUrl = `${base}?${paramStr}&signature=${signature}`;
      return res.json({ provider: "payfast", redirectUrl, orderId });
    }

    // demo: no real charge, credit instantly so the flow is testable end-to-end.
    if (accounts.accountsEnabled() && req.user && orderId) {
      await accounts.markOrderPaidAndCredit({ orderId });
    }
    return res.json({ provider: "demo", status: "granted", qty: useQty, orderId });
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

/* Android: the native Google Play Billing flow calls this with the productId +
   purchaseToken from a completed purchase. We verify it against the Google Play
   Developer API and grant (credits or Studio Pass) server-side. Idempotent. */
app.post("/api/pay/google/verify", accounts.requireAuth, async (req, res) => {
  if (!accounts.accountsEnabled() || !req.user) return res.json({ accounts: false });
  const { productId, purchaseToken, type, fingerprint } = req.body || {};
  if (!productId || !purchaseToken) return res.status(400).json({ error: "Missing productId or purchaseToken" });
  try {
    const result = await accounts.grantGooglePurchase(req.user.id, { productId, purchaseToken, type });
    const status = await accounts.statusFor(req.user.id, fingerprint);
    res.json({ accounts: true, granted: result, ...status });
  } catch (e) {
    console.error("google/verify:", e.message);
    res.status(400).json({ error: "Could not verify that purchase.", detail: e.message });
  }
});

/* Yoco calls this on payment events. Credits the order (idempotent). */
app.post("/api/pay/webhook", async (req, res) => {
  try {
    const body = req.body || {};
    let checkoutId, orderId, succeeded, paidCents = null;

    if (body.payment_status || body.m_payment_id) {
      // ---- PayFast ITN (form-encoded), must pass signature + server-to-server validate.
      if (!(await verifyPayfastItn(body, req))) { console.warn("payfast ITN rejected"); return res.sendStatus(200); }
      orderId = body.m_payment_id || body.custom_str1;
      succeeded = /complete/i.test(String(body.payment_status || ""));
      if (body.amount_gross != null) paidCents = Math.round(Number(body.amount_gross) * 100);
    } else {
      // ---- Yoco webhook (JSON), must pass HMAC signature.
      if (!verifyYocoSignature(req)) { console.warn("yoco webhook rejected"); return res.sendStatus(200); }
      const payload = body.payload || body.data || body;
      checkoutId = payload.id || payload.checkoutId || (payload.metadata && payload.metadata.checkoutId);
      orderId = payload.metadata && payload.metadata.orderId;
      succeeded = /succeed|complete|paid|success/i.test(String(body.type || payload.status || ""));
      if (payload.amount != null) paidCents = Number(payload.amount);
    }

    if (accounts.accountsEnabled() && succeeded && (checkoutId || orderId)) {
      // Match the amount actually paid against the server-side order before crediting.
      const order = await accounts.findOrder({ orderId: orderId || null, checkoutId: checkoutId || null });
      if (!order) { console.warn("webhook: order not found", orderId || checkoutId); return res.sendStatus(200); }
      if (paidCents != null && Number(order.amount_cents) !== Number(paidCents)) {
        console.warn("webhook amount mismatch", order.amount_cents, paidCents); return res.sendStatus(200);
      }
      await accounts.markOrderPaidAndCredit({ checkoutId, orderId });
      console.log("payment webhook: credited", PAY_PROVIDER, order.id);
    } else {
      console.log("payment webhook:", PAY_PROVIDER, "ignored");
    }
  } catch (e) {
    console.error("webhook:", e.message);
  }
  res.sendStatus(200); // always 200 so the provider doesn't retry-storm
});

/* ============================================================
   SHARE PAGE (server-rendered), /s?a=<audio>&t=<title>&n=<name>&i=<cover>
   Emits per-song Open Graph / Twitter tags so a link pasted into WhatsApp,
   iMessage, Facebook, X, etc. shows a rich card (cover art + name) instead of
   a bare grey link. Humans get the same lovely spinning-vinyl player as s.html.
   Reached in production via the branded proxy bandinyourhand.store/song.
   ============================================================ */
const SHARE_SITE = "https://bandinyourhand.store";
function shHtml(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c])); }
function shUrl(u){ u = String(u == null ? "" : u).trim(); return /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : ""; }
const SHARE_STYLE = `<style>
  :root{--cream:#FFF7EC;--butter:#FFE7A6;--coral:#FF5C6E;--navy:#1D1B2E;--card:#FFFFFF;--muted:#6B6780;--line:#EFE7D8;}
  *{box-sizing:border-box} html,body{margin:0;height:100%}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--navy);
    background:radial-gradient(1200px 600px at 50% -10%,#FFEFC9 0%,transparent 60%),linear-gradient(180deg,var(--cream),#FDEFD8);
    min-height:100%;display:flex;align-items:center;justify-content:center;padding:24px 18px calc(24px + env(safe-area-inset-bottom));}
  .wrap{width:100%;max-width:420px;text-align:center}
  .kicker{font-size:13px;font-weight:700;letter-spacing:.04em;color:var(--coral);text-transform:uppercase;margin:0 0 6px}
  h1{font-size:26px;line-height:1.15;margin:0 0 4px} .who{color:var(--muted);font-size:15px;margin:0 0 22px}
  .stage{position:relative;width:230px;height:230px;margin:0 auto 22px}
  .vinyl{position:absolute;inset:0;border-radius:50%;background:repeating-radial-gradient(circle at 50% 50%,#23202f 0 3px,#191723 3px 6px);
    box-shadow:0 18px 40px rgba(29,27,46,.28);animation:spin 6s linear infinite;animation-play-state:paused;display:flex;align-items:center;justify-content:center;}
  .vinyl.spinning{animation-play-state:running}
  .label{width:120px;height:120px;border-radius:50%;background:var(--butter);border:6px solid #fff;background-size:cover;background-position:center;
    display:flex;align-items:center;justify-content:center;font-size:44px;box-shadow:inset 0 0 0 2px rgba(0,0,0,.05);}
  .hole{position:absolute;width:14px;height:14px;border-radius:50%;background:var(--cream);box-shadow:inset 0 0 0 2px rgba(0,0,0,.1)}
  @keyframes spin{to{transform:rotate(360deg)}}
  .play{-webkit-appearance:none;appearance:none;border:none;cursor:pointer;width:74px;height:74px;border-radius:50%;background:var(--coral);color:#fff;
    font-size:30px;line-height:1;box-shadow:0 10px 24px rgba(255,92,110,.45);margin:0 auto 8px;display:flex;align-items:center;justify-content:center;transition:transform .1s ease;}
  .play:active{transform:scale(.94)} .time{font-size:12px;color:var(--muted);margin:0 0 22px;min-height:16px}
  .cta{display:block;text-decoration:none;font-weight:800;font-size:16px;background:var(--navy);color:#fff;border-radius:16px;padding:16px 18px;box-shadow:0 8px 20px rgba(29,27,46,.22);}
  .cta small{display:block;font-weight:600;font-size:12px;opacity:.8;margin-top:2px}
  .foot{margin-top:16px;font-size:12px;color:var(--muted)} .foot b{color:var(--navy)}
  .scene{font-size:15px;color:var(--muted);min-height:20px;margin:0 0 14px}
</style>`;
function sharePage(req, res){
  const audio = shUrl(req.query.a), image = shUrl(req.query.i);
  const title = String(req.query.t || "").slice(0, 120);
  const name  = String(req.query.n || "").slice(0, 80);
  const ogTitle = title ? ("🎵 “" + title + "”") : (name ? ("🎵 A song for " + name) : "🎵 A Band in Your Hand song");
  const ogDesc  = name ? ("Someone turned " + name + " into a song. Tap to listen, then make your own, free 💛") : "Someone turned a person they love into a song. Tap to listen, then make your own, free 💛";
  const ogImage = image || (SHARE_SITE + "/icon-512.png");
  const shareUrl = SHARE_SITE + "/song?" + new URLSearchParams({ ...(audio?{a:audio}:{}), ...(title?{t:title}:{}), ...(name?{n:name}:{}), ...(image?{i:image}:{}) }).toString();
  const html = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"/>"
    + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\"/>"
    + "<title>" + shHtml(ogTitle) + "</title>"
    + "<meta property=\"og:type\" content=\"music.song\"/>"
    + "<meta property=\"og:site_name\" content=\"Band in Your Hand\"/>"
    + "<meta property=\"og:title\" content=\"" + shHtml(ogTitle) + "\"/>"
    + "<meta property=\"og:description\" content=\"" + shHtml(ogDesc) + "\"/>"
    + "<meta property=\"og:image\" content=\"" + shHtml(ogImage) + "\"/>"
    + "<meta property=\"og:url\" content=\"" + shHtml(shareUrl) + "\"/>"
    + (audio ? ("<meta property=\"og:audio\" content=\"" + shHtml(audio) + "\"/>") : "")
    + "<meta name=\"twitter:card\" content=\"summary_large_image\"/>"
    + "<meta name=\"twitter:title\" content=\"" + shHtml(ogTitle) + "\"/>"
    + "<meta name=\"twitter:description\" content=\"" + shHtml(ogDesc) + "\"/>"
    + "<meta name=\"twitter:image\" content=\"" + shHtml(ogImage) + "\"/>"
    + "<meta name=\"theme-color\" content=\"#FFF7EC\"/>"
    + SHARE_STYLE
    + "</head><body><div class=\"wrap\">"
    + "<p class=\"kicker\">🎵 A Band in Your Hand song</p>"
    + "<h1 id=\"title\">" + shHtml(title ? ("“" + title + "”") : "Their song") + "</h1>"
    + "<p class=\"who\" id=\"who\">" + shHtml(name ? ("A song for " + name) : "") + "</p>"
    + "<div class=\"stage\"><div class=\"vinyl\" id=\"vinyl\"><div class=\"label\" id=\"label\"" + (image ? (" style=\"background-image:url(&quot;" + shHtml(image) + "&quot;)\"") : "") + ">" + (image ? "" : "🎶") + "</div></div><div class=\"hole\"></div></div>"
    + "<button class=\"play\" id=\"play\" aria-label=\"Play\">▶</button>"
    + "<p class=\"time\" id=\"time\">" + (audio ? "tap to play" : "") + "</p>"
    + "<p class=\"scene\" id=\"scene\"></p>"
    + "<a class=\"cta\" href=\"" + SHARE_SITE + "\">Make your own 🎶<small>Turn someone you love into a song</small></a>"
    + "<p class=\"foot\">Made with <b>Band in Your Hand</b> · your first song's free 💛</p>"
    + "</div>"
    + (audio ? ("<audio id=\"audio\" preload=\"none\" playsinline src=\"" + shHtml(audio) + "\"></audio>") : "")
    + "<script>(function(){var a=" + JSON.stringify(audio || "") + ";"
    + "var play=document.getElementById('play'),time=document.getElementById('time'),vinyl=document.getElementById('vinyl'),scene=document.getElementById('scene'),audio=document.getElementById('audio');"
    + "var scenes=['📻 turn it up','💿 spinning just for you','🎧 press play, thank us later','🥁 Boom laid down the beat','🎤 Lola gave it everything','✍️ Penny wrote the words'];"
    + "var si=Math.floor(Math.random()*scenes.length);scene.textContent=scenes[si];setInterval(function(){si=(si+1)%scenes.length;scene.textContent=scenes[si];},3200);"
    + "function fmt(s){s=Math.floor(s||0);return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');}"
    + "if(!a&&play){play.style.display='none';}"
    + "if(play&&audio){play.addEventListener('click',function(){if(audio.paused){audio.play();}else{audio.pause();}});"
    + "audio.addEventListener('play',function(){play.textContent='⏸';vinyl.classList.add('spinning');});"
    + "audio.addEventListener('pause',function(){play.textContent='▶';vinyl.classList.remove('spinning');});"
    + "audio.addEventListener('ended',function(){play.textContent='▶';vinyl.classList.remove('spinning');time.textContent='play it again? 🔁';});"
    + "audio.addEventListener('timeupdate',function(){if(audio.duration)time.textContent=fmt(audio.currentTime)+' / '+fmt(audio.duration);});"
    + "audio.addEventListener('loadedmetadata',function(){time.textContent='0:00 / '+fmt(audio.duration);});}"
    + "})();</script></body></html>";
  res.set("Content-Type", "text/html; charset=utf-8");
  res.set("Cache-Control", "public, max-age=300");
  res.send(html);
}
app.get("/s", sharePage);
app.get("/song", sharePage);

app.get("/", (_req, res) => res.send(`Song Stars backend · songs:${PROVIDER} · pay:${PAY_PROVIDER}`));
app.listen(PORT, () => console.log(`🎵 Song Stars backend on :${PORT} (songs:${PROVIDER}, pay:${PAY_PROVIDER})`));
