"use strict";

// --video: video.mp4 is the video's picture, packet for packet, with the
// fitted track under it, at the loudness asked for; the video's own sound
// is kept, dipped under or left out as asked; and a video that cannot take
// the fit is refused before any work.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { decode, measureFile } = require("../skills/musicfit/scripts/lib/audio");
const { voice, writeWav } = require("./synth");
const { fixture, dir } = require("./helpers");

const CLI = path.resolve(__dirname, "../skills/musicfit/scripts/musicfit.js");
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const RATE = 48000;
// The option that keeps the frames a filter leaves at their own times, as
// the test's own ffmpeg takes it: -fps_mode on ffmpeg 5.1 and newer, as
// ffmpeg 9 no longer takes -vsync, and -vsync on ffmpeg 4.4, which has no
// -fps_mode. Its help lists the options it takes.
const FPS_MODE = /^-fps_mode\b/m.test(spawnSync(FFMPEG, ["-hide_banner", "-h", "long"], { encoding: "utf8" }).stdout) ? "-fps_mode" : "-vsync";

const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
const at = (name) => path.join(dir, name);

function ffmpeg(args) {
  const run = spawnSync(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-y", ...args], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run;
}

function wav(name, seconds, fill) {
  const file = at(`${name}.wav`);
  if (!fs.existsSync(file)) {
    const L = new Float32Array(Math.round(seconds * RATE));
    fill(L);
    writeWav(file, { rate: RATE, L, R: L });
  }
  return file;
}

// Noise bursts, the way a film's sound effects come and go, in silence.
const effects = () =>
  wav("effects", 12, (x) => {
    let seed = 7;
    for (const [from, to] of [[2, 2.3], [8, 8.6]]) {
      for (let i = from * RATE; i < to * RATE; i++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        x[i] = (seed / 2147483648 - 0.5) * 0.6 * Math.min(1, (to * RATE - i) / (0.2 * RATE));
      }
    }
  });
// A tone all the way through, as a film with music of its own.
const bed = () => wav("bed", 12, (x) => x.forEach((_, i) => (x[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / RATE))));
const speech = () => {
  const file = at("speech.wav");
  if (!fs.existsSync(file)) writeWav(file, voice(12, [[2, 6.5], [7.2, 11]]));
  return file;
};

// A small test picture, 12 s by default, with `sound` (a file) as its AAC.
function film(name, { fps = 25, seconds = 12, sound = null, codec = ["-c:v", "mpeg4", "-q:v", "6"], ext = "mp4", filter = null } = {}) {
  const file = at(`${name}.${ext}`);
  if (fs.existsSync(file)) return file;
  const args = ["-f", "lavfi", "-i", `testsrc2=s=160x96:r=${fps}:d=${seconds}`];
  if (sound) args.push("-i", sound);
  args.push("-map", "0:v:0");
  if (filter) args.push(...filter);
  if (sound) args.push("-map", "1:a:0", "-c:a", "aac", "-b:a", "128k", "-t", String(seconds));
  ffmpeg([...args, ...codec, file]);
  return file;
}

const mono = (x) => {
  const out = new Float32Array(x.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = (x[2 * i] + x[2 * i + 1]) / 2;
  return out;
};

function db(x, from, to) {
  let sum = 0;
  const a = Math.round(from * RATE);
  const b = Math.round(to * RATE);
  for (let i = a; i < b; i++) sum += x[i] * x[i];
  return 10 * Math.log10(sum / (b - a) + 1e-12);
}

// The lag (in samples) at which `y` best matches `x` over [from, to] s.
function lag(x, y, from, to, most = 960) {
  const a = Math.round(from * RATE);
  const b = Math.round(to * RATE);
  let best = -Infinity;
  let arg = 0;
  for (let d = -most; d <= most; d += 4) {
    let xy = 0;
    let yy = 0;
    for (let i = a; i < b; i += 3) {
      xy += x[i] * (y[i + d] || 0);
      yy += (y[i + d] || 0) ** 2;
    }
    const c = xy / Math.sqrt(yy + 1e-12);
    if (c > best) {
      best = c;
      arg = d;
    }
  }
  return arg;
}

// The picture's packets as framecrc lists them: size and checksum, in order.
function packets(file) {
  const run = ffmpeg(["-i", file, "-map", "0:V:0", "-c", "copy", "-f", "framecrc", "pipe:1"]);
  return run.stdout
    .split("\n")
    .filter((l) => /^\d/.test(l))
    .map((l) => l.split(",").slice(4, 6).join(",").trim());
}

const said = (file) => spawnSync(FFMPEG, ["-hide_banner", "-nostdin", "-i", file], { encoding: "utf8" }).stderr;
const cuesOf = (out) => JSON.parse(fs.readFileSync(path.join(out, "cues.json"), "utf8"));

// The plain fit every --video fit below is held against.
let plainFit = null;
function plain() {
  if (plainFit) return plainFit;
  const out = at("plain");
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  plainFit = { out, wav: fs.readFileSync(path.join(out, "fitted.wav")) };
  return plainFit;
}

test("--video writes video.mp4: the picture packet for packet, the fitted track lined up with it, its own sound kept 3 dB louder than the music in each place it plays, the music dipping under a place only as far as their peaks need and untouched elsewhere, at --lufs with the true peak at or under -1 dBTP", async () => {
  const video = film("film25", { sound: effects() });
  const out = at("film25-fit");
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", video, "--video-sound", "keep", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(fs.readdirSync(out).sort(), ["FIT.md", "cues.json", "fitted.wav", "seams.png", "video.mp4"]);
  assert.match(run.stdout, /\n {2}Video {3}video\.mp4 is film25\.mp4 with the music and its own sound, that sound about 3 dB or more louder than the music where it plays \(2 places\)(?:, the music dipping [\d.]+(?: to [\d.]+)? dB under (?:both|one of them))?; -1[34](?:\.\d)? LUFS, true peak -[\d.]+ dBTP\n/);

  const c = cuesOf(out);
  // Without --fps the frames count at the video's rate.
  assert.equal(c.fps, 25);
  assert.equal(c.frames, 300);
  assert.equal(c.drop.frame, 200);
  assert.deepEqual({ ...c.video, spans: c.video.spans.length, loudness: null }, { file: "video.mp4", source: "film25.mp4", length: 12, fps: 25, frames: 300, steady: true, picture: "mpeg4", sound: "keep", same: null, duck: null, over: 3, spans: 2, loudness: null });

  assert.deepEqual(packets(path.join(out, "video.mp4")), packets(video));
  const loudness = await measureFile(path.join(out, "video.mp4"));
  assert.ok(Math.abs(loudness.integrated + 14) <= 0.5, `${loudness.integrated} LUFS`);
  assert.ok(loudness.truePeak <= -1, `true peak ${loudness.truePeak} dBTP`);
  // The mark names no file: the track's and the video's names stay the user's.
  assert.match(said(path.join(out, "video.mp4")), /comment\s*: musicfit \S+: a fitted track laid under this picture\n/);
  // AAC at 256 kb/s, where its noise lifts a true peak by a few tenths at most.
  const rate = /Audio: aac \(LC\).*, (\d+) kb\/s/.exec(said(path.join(out, "video.mp4")));
  assert.ok(rate && Number(rate[1]) >= 230, rate && rate[0]);

  // fitted.wav is a plain fit's. In video.mp4 the music is lined up with
  // the picture, and each effect is about 3 dB louder than it where it
  // plays, the one on the hit too, as cues.json says of each: the music
  // dips under one only by as much as their peaks leave no room for, and
  // elsewhere the limiter takes nothing off it.
  assert.ok(fs.readFileSync(path.join(out, "fitted.wav")).equals(plain().wav), "fitted.wav dips under the effects");
  const music = mono(await decode(path.join(out, "fitted.wav")));
  const under = mono(await decode(path.join(out, "video.mp4")));
  assert.ok(Math.abs(lag(music, under, 4, 6)) <= 96, `video.mp4's sound is ${lag(music, under, 4, 6)} samples off`);
  const places = await placesOver(under, music, video, c.video.spans);
  places.forEach((p, i) => {
    assert.ok(c.video.spans[i].over >= 2.9, JSON.stringify(c.video.spans[i]));
    assert.ok(Math.abs(p.over - c.video.spans[i].over) <= AAC_NOISE, `the effect at ${c.video.spans[i].from} s is ${p.over.toFixed(1)} LU over the music, and cues.json says ${c.video.spans[i].over}`);
  });
  const gains = musicGains(under, music, mono(await decode(video)), c.video.spans);
  assert.ok(gains.spread <= 0.25, `the music away from the effects moves ${gains.spread.toFixed(2)} dB`);
  c.video.spans.forEach((span, i) => {
    assert.ok(span.dip >= 0 && span.dip <= 10, JSON.stringify(span));
    assert.ok(Math.abs(gains.under[i] + span.dip) <= 1, `the music is ${gains.under[i].toFixed(1)} dB down under the effect at ${span.from} s, and cues.json says it dips ${span.dip} dB`);
  });
  assert.deepEqual(c.warnings, []);
});

// The music's gain in video.mp4 against fitted.wav, by least squares
// against it and the video's own sound together: in windows of 0.2 s away
// from every place and its dip, how far those move from the first (a
// limiter taking the music down would move them), and under each place,
// how far it is down from them, in dB.
function musicGains(heard, music, own, spans) {
  const busy = (t) => spans.some((s) => t > s.from - 0.2 && t < s.to + 0.6);
  const away = [];
  for (let t = 0; t + 0.2 <= heard.length / RATE; t += 0.2) {
    const [a, b] = [Math.round(t * RATE), Math.round((t + 0.2) * RATE)];
    let mm = 0;
    for (let i = a; i < b; i++) mm += music[i] * music[i];
    if (busy(t) || busy(t + 0.2) || mm < 1e-3) continue;
    away.push(20 * Math.log10(parts(heard, music, own, a, b).music));
  }
  const level = away.reduce((sum, g) => sum + g, 0) / away.length;
  return {
    spread: Math.max(...away) - Math.min(...away),
    under: spans.map((s) => 20 * Math.log10(parts(heard, music, own, Math.round(s.from * RATE), Math.round(s.to * RATE)).music) - level),
  };
}

test("--video-sound voice dips the music about --duck dB under the video's own sound, and drop leaves that sound out", async () => {
  const talk = film("talk", { sound: speech() });
  const out = at("talk-voice");
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", talk, "--video-sound", "voice", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  const c = cuesOf(out);
  assert.equal(c.video.sound, "voice");
  assert.equal(c.video.duck, 10);
  assert.equal(c.video.spans.length, 2);
  assert.ok(Math.abs(c.video.spans[0].from - 2) < 0.1 && Math.abs(c.video.spans[1].to - 11) < 0.1, JSON.stringify(c.video.spans));
  const dipped = mono(await decode(path.join(out, "fitted.wav")));
  const music = mono(await decode(path.join(plain().out, "fitted.wav")));
  const dip = db(dipped, 3, 6) - db(music, 3, 6);
  assert.ok(Math.abs(dip + 10) < 1.5, `dipped ${dip.toFixed(1)} dB`);
  assert.match(fs.readFileSync(path.join(out, "FIT.md"), "utf8"), /The music dips 10 dB wherever talk\.mp4's own sound plays \(2 stretches\)/);

  const tone = film("bed25", { sound: bed() });
  const dropped = at("bed-drop");
  const left = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", tone, "--video-sound", "drop", "--out", dropped]);
  assert.equal(left.status, 0, left.stderr);
  assert.equal(cuesOf(dropped).video.sound, "drop");
  assert.ok(fs.readFileSync(path.join(dropped, "fitted.wav")).equals(plain().wav), "fitted.wav is not a plain fit's");
  // The tone is gone: what plays is the music, at its own shape.
  const heard = mono(await decode(path.join(dropped, "video.mp4")));
  let xy = 0;
  let xx = 0;
  let yy = 0;
  for (let i = 2 * RATE; i < 10 * RATE; i++) {
    xy += music[i] * heard[i];
    xx += music[i] ** 2;
    yy += heard[i] ** 2;
  }
  assert.ok(xy / Math.sqrt(xx * yy) > 0.95, `video.mp4's sound is not the music alone (${(xy / Math.sqrt(xx * yy)).toFixed(3)})`);
});

test("a video with sound of its own is refused until --video-sound says what becomes of it, however little of it plays", () => {
  const cases = [
    ["bed25", film("bed25", { sound: bed() }), /1[12]\.\d/],
    ["film25", film("film25", { sound: effects() }), /\d\.\d/],
    ["talk", film("talk", { sound: speech() }), /\d+\.\d/],
  ];
  for (const [name, video, plays] of cases) {
    const out = at(`${name}-ask`);
    const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", video, "--out", out]);
    assert.equal(run.status, 1, `${name}: ${run.stderr}`);
    assert.match(run.stderr, new RegExp(`musicfit: ${name}\\.mp4 has sound of its own for ${plays.source} of its 12\\.0 s, so say what becomes of it with --video-sound: keep for sound effects \\(they stay, 3 dB louder than the music where they play, and where their peaks leave no room for that the music dips under them, 10 dB at most\\), voice for speech \\(set to -14 LUFS where it plays, and the music dips 10 dB under it\\), or drop for music of its own \\(left out\\)\\n$`));
    assert.doesNotMatch(run.stderr, /Reading house\.wav/);
    assert.ok(!fs.existsSync(out), `${name} made ${out}`);
  }
  const kept = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", film("bed25", { sound: bed() }), "--video-sound", "keep", "--out", at("bed-keep")]);
  assert.equal(kept.status, 0, kept.stderr);
  assert.match(kept.stdout, /Note {4}bed25\.mp4's own sound plays for 1[12]\.\d of its 12\.0 s, along with the music\. If that sound is music of its own, --video-sound drop leaves it out\./);
});

// A sound as a loudness meter hears it: K-weighted, as ITU-R BS.1770 has it
// at 48 kHz, a shelf that lifts the highs and a high-pass under the bass.
function weighted(x) {
  const stages = [
    [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585],
    [1, -2, 1, -1.99004745483398, 0.99007225036621],
  ];
  let y = x;
  for (const [b0, b1, b2, a1, a2] of stages) {
    const z = new Float32Array(y.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const v = b0 * y[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = y[i];
      y2 = y1;
      y1 = v;
      z[i] = v;
    }
    y = z;
  }
  return y;
}

// How far a sound effect in video.mp4 can read from what cues.json says of
// it, in LU: the AAC encoding adds its own noise to a noise burst, which a
// meter reads as part of it, by up to a dB, more with ffmpeg 4.4's encoder
// than with 8's.
const AAC_NOISE = 1.2;

// How far the video's own sound is over the music in video.mp4 in each place
// it plays, in LU, and how loud it is there in LUFS, as a meter hears them:
// K-weighted, by their energy. The music's gain in video.mp4 over the place
// is found by least squares, against fitted.wav and the video's own sound
// together, as the two can move alike there (a thump on a kick drum); what
// is left of video.mp4 there once that music is taken out is the video's
// own sound, by its energy and not its waveform, as ffmpeg's fast AAC
// coder builds a noise-like sound effect anew rather than copying its
// waveform, which a meter reads the same. gain is how far each part was
// moved from fitted.wav and from the video.
async function placesOver(heard, music, video, spans) {
  const own = mono(await decode(video));
  const [h, m, o] = [weighted(heard), weighted(music), weighted(own)];
  return spans.map(({ from, to }) => {
    const a = Math.round(from * RATE);
    const b = Math.min(h.length, m.length, o.length, Math.round(to * RATE));
    const g = parts(heard, music, own, a, b).music;
    let mm = 0;
    let hh = 0;
    let oo = 0;
    for (let i = a; i < b; i++) {
      mm += m[i] * m[i];
      hh += h[i] * h[i];
      oo += o[i] * o[i];
    }
    const pm = g * g * mm;
    const po = Math.max(hh - pm, 1e-12 * hh);
    return { over: pm > 0 ? 10 * Math.log10(po / pm) : Infinity, level: -0.691 + 10 * Math.log10((2 * po) / (b - a)), gain: { music: g, own: Math.sqrt(po / oo) } };
  });
}

// video.mp4's sound split by least squares into the music (fitted.wav) and
// the video's own sound as it was in the video, over [a, b) or the whole:
// the gain each has in it. Where no music plays, all of it is the video's.
function parts(heard, music, own, a = 0, b = Math.min(heard.length, music.length, own.length)) {
  let mm = 0;
  let oo = 0;
  let mo = 0;
  let hm = 0;
  let ho = 0;
  for (let i = a; i < b; i++) {
    mm += music[i] * music[i];
    oo += own[i] * own[i];
    mo += music[i] * own[i];
    hm += heard[i] * music[i];
    ho += heard[i] * own[i];
  }
  const det = mm * oo - mo * mo;
  // Where the video's own sound is silent, all of it is the music's.
  if (mm > 0 && !(oo > 1e-9 * mm)) return { music: hm / mm, own: 0 };
  if (!(mm > 0) || !(det > 1e-9 * mm * oo)) return { music: 0, own: oo > 0 ? ho / oo : 0 };
  return { music: (hm * oo - ho * mo) / det, own: (ho * mm - hm * mo) / det };
}

test("--video-sound keep raises quiet sound effects, so each is about 3 dB louder than the music where it plays, and fitted.wav stays as a plain fit's", async () => {
  // Noise bursts 30 dB quieter than effects() makes them.
  const quiet = wav("quiet-effects", 12, (x) => {
    let seed = 11;
    for (const [from, to] of [[2, 2.3], [8, 8.6]]) {
      for (let i = from * RATE; i < to * RATE; i++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        x[i] = (seed / 2147483648 - 0.5) * 0.02;
      }
    }
  });
  const video = film("quietfx", { sound: quiet });
  const out = at("quietfx-keep");
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", video, "--video-sound", "keep", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  const c = cuesOf(out);
  assert.equal(c.video.spans.length, 2);
  assert.ok(fs.readFileSync(path.join(out, "fitted.wav")).equals(plain().wav), "fitted.wav dips under the effects");
  const heard = mono(await decode(path.join(out, "video.mp4")));
  const music = mono(await decode(path.join(out, "fitted.wav")));
  for (const [i, p] of (await placesOver(heard, music, video, c.video.spans)).entries()) {
    assert.ok(Math.abs(p.over - 3) <= AAC_NOISE, `the effect at ${c.video.spans[i].from} s is ${p.over.toFixed(1)} LU over the music`);
    // In the video it was 30 dB under it.
    assert.ok(20 * Math.log10(Math.abs(p.gain.own / p.gain.music)) > 20, `the effect at ${c.video.spans[i].from} s was not raised`);
  }
});

test("equal sound effects before the drop, on the hit and over the ring-out each stand over the music where it plays, set by the music there, and the one it could not set 3 dB over is named", async () => {
  // A 20 s fit of house.wav with the hit at 8 s ends on the track's last
  // hit at 15.7 s, which rings out to 19.9 s: equal bursts at 3 s, 8 s and
  // 17.5 s, where the music reads about -14, -12 and -28 LUFS.
  const bursts = wav("bursts3", 20, (x) => {
    let seed = 5;
    for (const from of [3, 8, 17.5]) {
      for (let i = Math.round(from * RATE); i < Math.round((from + 0.4) * RATE); i++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        x[i] = (seed / 2147483648 - 0.5) * 0.1;
      }
    }
  });
  const video = film("bursts3", { seconds: 20, sound: bursts });
  const out = at("bursts3-keep");
  const run = cli([fixture("house").file, "--length", "20", "--hit", "8", "--video", video, "--video-sound", "keep", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  const c = cuesOf(out);
  assert.equal(c.end.kind, "natural");
  assert.deepEqual(c.video.spans.map((s) => Math.round(s.from)), [3, 8, 18]);
  const heard = mono(await decode(path.join(out, "video.mp4")));
  const music = mono(await decode(path.join(out, "fitted.wav")));
  const places = await placesOver(heard, music, video, c.video.spans);
  // Each place as cues.json says it came out, checked on its own span.
  places.forEach((p, i) => assert.ok(Math.abs(p.over - c.video.spans[i].over) <= AAC_NOISE, `${c.video.spans[i].from} s: ${p.over.toFixed(1)} LU over the music, and cues.json says ${c.video.spans[i].over}`));
  // Before the drop and on the hit about 3 dB over the music; over the
  // quiet ring-out far over it, at the target: never under the music.
  assert.ok(places[0].over >= 2.3 && places[1].over >= 0, places.map((p) => p.over.toFixed(1)).join(", "));
  assert.ok(places[2].over > 9, `over the ring-out ${places[2].over.toFixed(1)} LU over the music`);
  assert.ok(Math.abs(places[2].level + 14) <= 1.5, `over the ring-out at ${places[2].level.toFixed(1)} LUFS`);
  // Equal effects come out within the 6 dB a place may move between the
  // target and its most, not 10 dB apart.
  const levels = places.map((p) => p.level);
  assert.ok(Math.max(...levels) - Math.min(...levels) <= 6.5, levels.map((l) => l.toFixed(1)).join(", "));
  // A place set less than 3 dB over the music is named in a note, with how it came out.
  const held = c.video.spans.filter((s) => s.over < 2.5);
  for (const s of held) assert.match(run.stdout, new RegExp(`Note {4}bursts3\\.mp4's own sound is less than 3 dB louder than the music in ${held.length} of the 3 places it plays, at [^\\n]*${s.from.toFixed(2)} s \\(`));
  if (!held.length) assert.doesNotMatch(run.stdout, /less than 3 dB louder/);
  const alone = cli([fixture("house").file, "--length", "20", "--hit", "8", "--out", at("bursts3-plain")]);
  assert.equal(alone.status, 0, alone.stderr);
  assert.ok(fs.readFileSync(path.join(out, "fitted.wav")).equals(fs.readFileSync(path.join(at("bursts3-plain"), "fitted.wav"))), "the music dips under the effects");
});

test("an impact on the drop, whose peaks stand 11 dB over its loudness, comes out 3 dB over the music there, the music dipping under it alone by as much as is missing, --duck at most, and the limiter takes nothing off the music", async () => {
  // A 70 Hz thump and a crack, both dying away over 0.6 s, on the hit: the
  // loudest stretch of the fit.
  const boom = wav("boom", 12, (x) => {
    let seed = 23;
    for (let i = 0; i < 0.6 * RATE; i++) {
      const t = i / RATE;
      seed = (seed * 1103515245 + 12345) % 2147483648;
      x[8 * RATE + i] = 0.3 * Math.exp(-t / 0.12) * Math.sin(2 * Math.PI * 70 * t) + 0.08 * Math.exp(-t / 0.05) * (seed / 2147483648 - 0.5);
    }
  });
  const video = film("boom", { sound: boom });
  const out = at("boom-keep");
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", video, "--video-sound", "keep", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  const c = cuesOf(out);
  assert.equal(c.video.spans.length, 1);
  const heard = mono(await decode(path.join(out, "video.mp4")));
  const music = mono(await decode(path.join(out, "fitted.wav")));
  const [place] = await placesOver(heard, music, video, c.video.spans);
  // Held to its peak at -1 dBFS it stayed 1.4 LU under the music; left to
  // the limiter, the music around it went 4 dB down and more.
  const [span] = c.video.spans;
  assert.ok(span.over >= 2.9 && span.dip > 0 && span.dip <= 10, JSON.stringify(span));
  assert.ok(place.over >= 3 - AAC_NOISE, `the impact is ${place.over.toFixed(1)} LU over the music`);
  const gains = musicGains(heard, music, mono(await decode(video)), c.video.spans);
  assert.ok(gains.spread <= 0.25, `the music away from the impact moves ${gains.spread.toFixed(2)} dB`);
  assert.ok(Math.abs(gains.under[0] + span.dip) <= 1, `the music is ${gains.under[0].toFixed(1)} dB down under the impact, and cues.json says it dips ${span.dip} dB`);
  assert.deepEqual(c.warnings, []);
  // With --duck 2 the music dips 2 dB at most, which leaves the impact
  // short of 3 dB over it, and a note says so.
  const short = at("boom-keep-duck2");
  const run2 = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", video, "--video-sound", "keep", "--duck", "2", "--out", short]);
  assert.equal(run2.status, 0, run2.stderr);
  const [held] = cuesOf(short).video.spans;
  assert.ok(held.dip === 2 && held.over < 2.5, JSON.stringify(held));
  assert.match(run2.stdout, new RegExp(`Note {4}boom\\.mp4's own sound is less than 3 dB louder than the music where it plays, at 8\\.00 s \\([^)]*\\): a place is set no louder than -8 LUFS, 6 dB over the target, nor than keeps its true peaks, with the music's, under -1 dBTP, and the music dips under it by 2 dB at most, as --duck says\\. A larger --duck lets the music dip further there\\.\\n`));
});

// The level of [from, to] s of a K-weighted sound, in LUFS, and its energy
// on that scale.
function windowEnergy(x, from, to) {
  const a = Math.round(from * RATE);
  const b = Math.min(x.length, Math.round(to * RATE));
  let sum = 0;
  for (let i = a; i < b; i++) sum += x[i] * x[i];
  return (2 * sum) / (b - a);
}
const lufsOf = (energy) => -0.691 + 10 * Math.log10(energy + 1e-12);

test("--video-sound keep with a voice keeps every place, where the voice speaks over it too: measured in video.mp4 against a drop run each is there at about the target, and the music dips for none of them under the voice", async () => {
  // The first burst before the voice starts, the other two while it speaks.
  const fx = wav("fxvoice", 12, (x) => {
    let seed = 17;
    for (const [from, to] of [[0.6, 0.9], [3, 3.3], [8, 8.6]]) {
      for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        x[i] = (seed / 2147483648 - 0.5) * 0.6;
      }
    }
  });
  const video = film("fxvoice", { sound: fx });
  const fit = (how) => {
    const out = at(`fxvoice-${how}`);
    const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--voice", speech(), "--video", video, "--video-sound", how, "--out", out]);
    assert.equal(run.status, 0, run.stderr);
    return { out, run };
  };
  const kept = fit("keep");
  const dropped = fit("drop");
  const c = cuesOf(kept.out);
  assert.deepEqual(c.video.spans.map((s) => Math.round(s.from)), [1, 3, 8]);
  const voiced = c.voice.spans;
  const fitmd = fs.readFileSync(path.join(kept.out, "FIT.md"), "utf8");
  for (const said of [kept.run.stdout, fitmd]) assert.doesNotMatch(said, /Infinity|NaN/);
  assert.doesNotMatch(kept.run.stdout, /less than 3 dB louder/);
  const k = weighted(mono(await decode(path.join(kept.out, "video.mp4"))));
  const d = weighted(mono(await decode(path.join(dropped.out, "video.mp4"))));
  for (const s of c.video.spans) {
    const label = `the place at ${s.from} s: ${JSON.stringify(s)}`;
    // Every figure is a number, and the place is over the music there.
    assert.ok(Number.isFinite(s.over) && Number.isFinite(s.dip), label);
    assert.ok(s.over >= 2.5, label);
    // Where the voice speaks the music has dipped under it already.
    if (voiced.some((v) => v.from <= s.from && s.to <= v.to)) assert.equal(s.dip, 0, label);
    const [ek, ed] = [windowEnergy(k, s.from, s.to), windowEnergy(d, s.from, s.to)];
    assert.ok(lufsOf(ek) >= lufsOf(ed) + 1, `${label}: ${lufsOf(ek).toFixed(1)} LUFS with keep and ${lufsOf(ed).toFixed(1)} with drop`);
    // What keep adds to that stretch is the place, as a meter reads it.
    const alone = lufsOf(ek - ed);
    assert.ok(alone >= -19 && alone <= -9, `${label}: the place alone reads ${alone.toFixed(1)} LUFS`);
  }
  // Away from the places the music and the voice play as with drop.
  for (const [from, to] of [[1.6, 2.6], [4.3, 6.4], [9.4, 11]]) {
    const [lk, ld] = [lufsOf(windowEnergy(k, from, to)), lufsOf(windowEnergy(d, from, to))];
    assert.ok(Math.abs(lk - ld) <= 1, `${from} to ${to} s: ${lk.toFixed(1)} LUFS with keep and ${ld.toFixed(1)} with drop`);
  }
  // The whole is at the target, its true peak held, by the limiter.
  const whole = await measureFile(path.join(kept.out, "video.mp4"));
  assert.ok(Math.abs(whole.integrated + 14) <= 0.5, `${whole.integrated} LUFS`);
  assert.ok(whole.truePeak <= -1, `true peak ${whole.truePeak} dBTP`);
  assert.deepEqual(c.warnings, []);
});

test("a place keep leaves short with a voice given is named without the advice of a larger --duck, which would deepen the dip under the voice too", () => {
  const boom = wav("boom-voice", 12, (x) => {
    for (let i = 0; i < 0.6 * RATE; i++) {
      const t = i / RATE;
      x[8 * RATE + i] = 0.3 * Math.exp(-t / 0.12) * Math.sin(2 * Math.PI * 70 * t);
    }
  });
  const video = film("boom-voice", { sound: boom });
  // A voice that has ended before the impact, so the music is at its full level there.
  const early = at("early-speech.wav");
  if (!fs.existsSync(early)) writeWav(early, voice(12, [[2, 5]]));
  const out = at("boom-voice-keep");
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--voice", early, "--video", video, "--video-sound", "keep", "--duck", "2", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  const [span] = cuesOf(out).video.spans;
  assert.ok(span.dip === 2 && span.over < 2.5, JSON.stringify(span));
  assert.match(run.stdout, /Note {4}boom-voice\.mp4's own sound is less than 3 dB louder than the music where it plays, at 8\.00 s \([^)]*\): a place is set no louder than -8 LUFS, 6 dB over the target, nor than keeps its true peaks, with the music's, under -1 dBTP, and the music dips under it by 2 dB at most, as --duck says\.\n/);
  assert.doesNotMatch(run.stdout, /A larger --duck/);
});

test("a voice at the ceiling holds no place of keep back, a place is never set to nothing, and one that came out with no figure counts as under the music", async () => {
  const { setOver, cameOut } = require("../skills/musicfit/scripts/lib/render");
  const n = 4 * RATE;
  const fill = (f) => {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = f(i);
    return { L: x, R: x.slice() };
  };
  let seed = 3;
  const own = fill((i) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return i >= RATE && i < 1.4 * RATE ? (seed / 2147483648 - 0.5) * 0.4 : 0;
  });
  const music = fill((i) => 0.1 * Math.sin((2 * Math.PI * 110 * i) / RATE));
  // A voice whose peaks stand at -1 dBFS in every millisecond of the place.
  const also = fill((i) => 0.891 * Math.sign(Math.sin((2 * Math.PI * 200 * i) / RATE)));
  const [place] = await setOver(own, music, [[1, 1.4]], { lufs: -14, over: 3, most: 6, duck: 10, also });
  assert.ok(Number.isFinite(place.gain) && place.gain > -20, `its gain is ${place.gain} dB`);
  assert.ok(Number.isFinite(place.over) && place.over >= 2.5, `it is ${place.over} dB over the music`);
  assert.equal(place.dip, 0);
  // The whole as make() adds it, read back: the place's samples are let go, and its figure is unchanged.
  const whole = { L: own.L.slice(), R: own.R.slice() };
  for (let i = 0; i < n; i++) {
    whole.L[i] += music.L[i] + also.L[i];
    whole.R[i] += music.R[i] + also.R[i];
  }
  const before = place.over;
  await cameOut([place], whole, music);
  assert.ok(Math.abs(place.over - before) <= 0.2, `set ${before} dB over the music, and read ${place.over} dB`);
  assert.deepEqual(Object.keys(place).filter((key) => key === "own" || key === "also"), []);
  // A figure that is no number is under the music, and null stays null.
  const none = { a: 0, b: 100, over: -Infinity, dip: 10, own: { L: new Float32Array(100), R: new Float32Array(100) }, also: null };
  const silent = { a: 0, b: 100, over: null, dip: 0, own: { L: new Float32Array(100), R: new Float32Array(100) }, also: null };
  await cameOut([none, silent], whole, music);
  assert.equal(none.over, -70);
  assert.equal(silent.over, null);
});

test("a sound effect that runs to the end of a video a little longer than --length, within a frame, is kept like any other", async () => {
  const fx = wav("fxend", 12, (x) => {
    let seed = 13;
    for (const [from, to] of [[2, 2.3], [11.5, 12]]) {
      for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        x[i] = (seed / 2147483648 - 0.5) * 0.3;
      }
    }
  });
  const video = film("fxend", { sound: fx });
  const out = at("fxend-keep");
  const run = cli([fixture("house").file, "--length", "11.98", "--hit", "8", "--video", video, "--video-sound", "keep", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  const c = cuesOf(out);
  assert.equal(c.video.spans.length, 2);
  const heard = weighted(mono(await decode(path.join(out, "video.mp4"))));
  const last = c.video.spans[1];
  assert.doesNotMatch(run.stdout, /Infinity|NaN|-120/);
  // As loud as a place at the target can be, where almost no music plays.
  const level = lufsOf(windowEnergy(heard, last.from, 11.95));
  assert.ok(Math.abs(level + 14) <= 3, `the last place reads ${level.toFixed(1)} LUFS`);
  const whole = await measureFile(path.join(out, "video.mp4"));
  assert.ok(Number.isFinite(whole.integrated) && whole.integrated > -16, `${whole.integrated} LUFS`);
});

test("the same sound effect inside the closing fade and just after the music has ended comes out about as loud, the one in the fade not pushed down with the music there", async () => {
  // Where the fade runs in this fit, read from a fit without the video:
  // from 11.6 s to the last beat before the end, 13.5 s.
  const plainOut = at("fadeend-plain");
  assert.equal(cli([fixture("house").file, "--length", "14", "--end", "fade", "--out", plainOut]).status, 0);
  const { fade } = cuesOf(plainOut).end;
  const inside = fade.from + 0.45 * (fade.to - fade.from);
  const after = fade.to + 0.1;
  assert.ok(after + 0.35 <= 14 && after - inside >= 0.85, JSON.stringify(fade));
  // A 0.25 s tone at -12 dBFS at both.
  const tones = wav("fadeend", 14, (x) => {
    for (const from of [inside, after]) {
      for (let i = 0; i < 0.25 * RATE; i++) x[Math.round(from * RATE) + i] = 0.25 * Math.sin((2 * Math.PI * 800 * i) / RATE);
    }
  });
  const video = film("fadeend", { seconds: 14, sound: tones });
  const out = at("fadeend-keep");
  const run = cli([fixture("house").file, "--length", "14", "--end", "fade", "--video", video, "--video-sound", "keep", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  const c = cuesOf(out);
  assert.equal(c.video.spans.length, 2);
  assert.equal(c.video.spans[1].over, null);
  const heard = mono(await decode(path.join(out, "video.mp4")));
  const music = mono(await decode(path.join(out, "fitted.wav")));
  const [inFade, afterFade] = await placesOver(heard, music, video, c.video.spans);
  // Over the music in the fade and over none after it, both at about the
  // target, never one far under the other.
  assert.ok(inFade.over >= 2.5, `in the fade ${inFade.over.toFixed(1)} LU over the music`);
  assert.ok(Math.abs(inFade.level - afterFade.level) <= 3, `in the fade ${inFade.level.toFixed(1)} LUFS, after it ${afterFade.level.toFixed(1)} LUFS`);
  for (const p of [inFade, afterFade]) assert.ok(Math.abs(p.level + 14) <= 3, `${p.level.toFixed(1)} LUFS`);
});

test("a click in the first 5 ms of a video's own sound, where no music plays yet, is held under -1 dBTP like any other, and video.mp4 is at --lufs", async () => {
  // A 24 s fit of house.wav with the hit at 16.5 s is silent for its first
  // second, so the clicks there are set to the target, far louder than they
  // were, and their peaks are left to the limiter.
  const clicks = wav("clickhead", 24, (x) => {
    for (const from of [0, 0.4]) for (let i = 0; i < 0.001 * RATE; i++) x[Math.round(from * RATE) + i] = 0.5 * Math.sin((2 * Math.PI * 2000 * i) / RATE);
  });
  const video = film("clickhead", { seconds: 24, sound: clicks });
  const out = at("clickhead-keep");
  const run = cli([fixture("house").file, "--length", "24", "--hit", "16.5", "--video", video, "--video-sound", "keep", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  const c = cuesOf(out);
  assert.equal(c.start.kind, "silence");
  assert.ok(c.video.spans[0].from < 0.01 && c.video.spans[0].over === null, JSON.stringify(c.video.spans));
  const loudness = await measureFile(path.join(out, "video.mp4"));
  assert.ok(Math.abs(loudness.integrated + 14) <= 0.5, `${loudness.integrated} LUFS`);
  assert.ok(loudness.truePeak <= -1, `true peak ${loudness.truePeak} dBTP`);
  assert.match(fs.readFileSync(path.join(out, "FIT.md"), "utf8"), /, the whole set to -14 LUFS, measured after the AAC encoding\./);
  assert.deepEqual(c.warnings, []);
});

test("a video whose only sounds are short clicks is asked about, keep sets the clicks over the music with fitted.wav as it was, and voice finds no speech in them", async () => {
  const clicks = wav("clicks", 12, (x) => {
    for (const second of [3, 9]) {
      for (let i = 0; i < 0.03 * RATE; i++) x[second * RATE + i] = 0.5 * Math.sin((2 * Math.PI * 2000 * i) / RATE) * (1 - i / (0.03 * RATE));
    }
  });
  const video = film("clicks", { sound: clicks });
  const asked = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", video, "--out", at("clicks-ask")]);
  assert.equal(asked.status, 1, asked.stderr);
  assert.match(asked.stderr, /musicfit: clicks\.mp4 has sound of its own for 0\.\d\d of its 12\.0 s, so say what becomes of it with --video-sound/);
  const out = at("clicks-keep");
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", video, "--video-sound", "keep", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(cuesOf(out).video.spans.length, 2);
  assert.equal(cuesOf(out).video.over, 3);
  // Over the music, each click as far as its peaks, the music's and a dip
  // of 10 dB at most allow: one held under 3 dB over it is named in a note.
  for (const span of cuesOf(out).video.spans) {
    assert.ok(span.over > 0, JSON.stringify(span));
    if (span.over < 2.5) assert.match(run.stdout, new RegExp(`Note {4}clicks\\.mp4's own sound is less than 3 dB louder than the music [^\\n]*at [^\\n]*${span.from.toFixed(2)} s \\(${span.over} dB over it\\)[^\\n]*nor than keeps its true peaks, with the music's, under -1 dBTP, and the music dips under it by 10 dB at most, as --duck says\\.`));
  }
  assert.ok(fs.readFileSync(path.join(out, "fitted.wav")).equals(plain().wav), "the music dips under the clicks");
  const spoken = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", video, "--video-sound", "voice", "--out", at("clicks-voice")]);
  assert.equal(spoken.status, 0, spoken.stderr);
  assert.deepEqual(cuesOf(at("clicks-voice")).video.spans, []);
  assert.match(spoken.stdout, /Note {4}No speech was found in clicks\.mp4's own sound, so the music does not dip under it, and it is not raised: it is only turned down if it is louder than -14 LUFS\./);
});

// seams.png's pixels: musicfit writes 8-bit RGB rows, each filtered against
// the pixel to its left.
function pixels(file) {
  const png = fs.readFileSync(file);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const data = [];
  for (let at = 8; at < png.length; ) {
    const size = png.readUInt32BE(at);
    if (png.toString("latin1", at + 4, at + 8) === "IDAT") data.push(png.subarray(at + 8, at + 8 + size));
    at += 12 + size;
  }
  const raw = require("node:zlib").inflateSync(Buffer.concat(data));
  const stride = width * 3;
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (stride + 1)], 1);
    for (let x = 0; x < stride; x++) px[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + (x >= 3 ? px[y * stride + x - 3] : 0)) & 0xff;
  }
  return { width, height, at: (x, y) => [...px.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)] };
}

test("seams.png marks where the music dips under the video's own sound with voice, and names it under the picture, and with keep, whose dips are in video.mp4 only, has no such marks", () => {
  const kept = at("film25-png");
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", film("film25", { sound: effects() }), "--video-sound", "keep", "--out", kept]);
  assert.equal(run.status, 0, run.stderr);
  const plainImage = pixels(path.join(kept, "seams.png"));
  const keptLegend = plainImage.height - 34 + 7;
  assert.ok(!Array.from({ length: 1000 }, (_, x) => plainImage.at(x, keptLegend)).some((p) => p.join() === "199,125,255"), "a legend mark for dips that are not there");
  const out = at("talk-png");
  const spoken = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", film("talk", { sound: speech() }), "--video-sound", "voice", "--out", out]);
  assert.equal(spoken.status, 0, spoken.stderr);
  const spans = cuesOf(out).video.spans;
  assert.equal(spans.length, 2);
  const image = pixels(path.join(out, "seams.png"));
  // The marks sit along the bottom of the strip of the fit, 128 pixels to
  // the second from x 32, in #c77dff over the dark panel.
  const marked = (x) => [534, 537].every((y) => image.at(x, y).every((v, i) => Math.abs(v - [173, 110, 221][i]) <= 8));
  for (const { from, to } of spans) assert.ok(marked(Math.round(32 + ((from + to) / 2) * 128)), `no mark at ${from} to ${to} s`);
  assert.ok(!marked(Math.round(32 + ((spans[0].to + spans[1].from) / 2) * 128)), "a mark where nothing plays");
  // The legend's mark for them, in the line under the picture.
  const legend = image.height - 34 + 7;
  assert.ok(Array.from({ length: 1000 }, (_, x) => image.at(x, legend)).some((p) => p.join() === "199,125,255"), "no legend mark");
});

test("seams.png titles a track named outside a to z by its letters without their marks, or as the track when it has letters the picture cannot draw, never with question marks", () => {
  const title = (name) => {
    const cwd = at(`title-${Buffer.from(name).toString("hex")}`);
    fs.mkdirSync(cwd, { recursive: true });
    fs.copyFileSync(fixture("house").file, path.join(cwd, name));
    const run = spawnSync(process.execPath, [CLI, name, "--analyze", "--out", "out"], { cwd, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const image = pixels(path.join(cwd, "out", "seams.png"));
    // The title's rows, drawn three pixels to a dot from y 24.
    return Array.from({ length: 26 }, (_, y) => Array.from({ length: image.width }, (_, x) => image.at(x, 22 + y).join()).join(" ")).join("\n");
  };
  assert.equal(title("Şarkı.wav"), title("SARKI.WAV"));
  assert.equal(title("трек 音楽.wav"), title("THE TRACK"));
  // The punctuation of a downloaded song's name, in its plain form.
  assert.equal(title("Don’t Stop – Live.wav"), title("DON'T STOP - LIVE.WAV"));
  const { drawable } = require("../skills/musicfit/scripts/lib/draw");
  assert.equal(drawable("café_noir & co!.mp3"), "CAFE_NOIR & CO!.MP3");
  assert.equal(drawable("Smørrebrød straße.wav"), "SMORREBROD STRASSE.WAV");
  assert.equal(drawable("गाना.wav"), null);
  assert.equal(drawable("Artist — Title.mp3"), "ARTIST - TITLE.MP3");
  assert.equal(drawable("“Quoted” ‘and’ wait….wav"), "\"QUOTED\" 'AND' WAIT....WAV");
  assert.equal(drawable("über·song×2.wav"), "UBER.SONGX2.WAV");
  // A sign it has no shape for is left out; a name of nothing else, or with
  // letters of another script, is the track.
  assert.equal(drawable("Song ♪ Live ✨.mp3"), "SONG LIVE.MP3");
  assert.equal(drawable("♪♪.mp3"), null);
  assert.equal(drawable("Песня Song.mp3"), null);
  assert.equal(drawable("___.wav"), "___.WAV");
});

test("a faint room tone the video has stays faint against the music, never raised to --lufs", async () => {
  const hiss = wav("hiss", 12, (x) => {
    let seed = 3;
    for (let i = 0; i < x.length; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      x[i] = (seed / 2147483648 - 0.5) * 0.006;
    }
  });
  const out = at("hiss-fit");
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", film("hiss", { sound: hiss }), "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(cuesOf(out).video.sound, "keep");
  // What plays is the music, barely changed: raised to -14 LUFS, the hiss
  // would be as loud as it.
  const music = mono(await decode(path.join(out, "fitted.wav")));
  const heard = mono(await decode(path.join(out, "video.mp4")));
  let xy = 0;
  let xx = 0;
  let yy = 0;
  for (let i = RATE; i < 11 * RATE; i++) {
    xy += music[i] * heard[i];
    xx += music[i] ** 2;
    yy += heard[i] ** 2;
  }
  assert.ok(xy / Math.sqrt(xx * yy) > 0.98, `the hiss was raised: ${(xy / Math.sqrt(xx * yy)).toFixed(3)}`);
});

test("a video with no sound of its own gets the music alone", () => {
  const out = at("mute-fit");
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", film("mute"), "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(cuesOf(out).video.sound, "none");
  assert.match(run.stdout, /Video {3}video\.mp4 is mute\.mp4 with the music \(ffmpeg reads no sound of its own in it\)/);
});

test("a video that cannot take the fit is refused before any work, and no folder is made", () => {
  const still = at("still.png");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=160x96", "-frames:v", "1", still]);
  const text = at("notes.txt");
  fs.writeFileSync(text, "not a video\n");
  const prores = film("prores", { seconds: 1, codec: ["-c:v", "prores_ks"], ext: "mov" });
  const empty = at("empty.mp4");
  fs.writeFileSync(empty, "");
  // Cut off part way, as a download that stopped: one whose index comes
  // first, and one whose index was to come at the end.
  const cut = (from, name) => {
    const bytes = fs.readFileSync(from);
    fs.writeFileSync(at(name), bytes.subarray(0, Math.floor(bytes.length * 0.4)));
    return at(name);
  };
  const headFirst = cut(film("film12fast", { codec: ["-c:v", "mpeg4", "-q:v", "6", "-movflags", "+faststart"] }), "cut-fast.mp4");
  const headLast = cut(film("film12", {}), "cut-last.mp4");
  const cases = [
    [fixture("house").file, /musicfit: house\.wav has no picture to lay the music under\n$/],
    [at("nothing.mp4"), /musicfit: Cannot read .*nothing\.mp4: no such file\n$/],
    [text, /musicfit: Cannot read .*notes\.txt: it is not a kind of file ffmpeg reads, or it is cut short or damaged\n$/],
    [still, /musicfit: still\.png is a still picture, not a video\n$/],
    [prores, /musicfit: prores\.mov's picture is prores, which an MP4 cannot hold without encoding it again: give --video an H\.264 or HEVC copy of it\n$/],
    [film("film14", { seconds: 14 }), /musicfit: film14\.mp4 is 14\.00 s long \(350 frames at 25 fps\) and --length is 12\.00 s: give --length 14, or 350f\n$/],
    [film("film3602", { fps: 1, seconds: 3602 }), /musicfit: film3602\.mp4 is 3602\.00 s long \(3602 frames at 1 fps\), longer than the hour --length takes at most: give --video a cut of an hour or less\n$/],
    [film("film3601", { fps: 1, seconds: 3601 }), /musicfit: film3601\.mp4 is 3601\.00 s long \(3601 frames at 1 fps\) and --length is 12\.00 s: give --length 3600\n$/],
    [film("film-hour-half", { fps: 2, seconds: 3600.5 }), /musicfit: film-hour-half\.mp4 is 3600\.50 s long \(7201 frames at 2 fps\) and --length is 12\.00 s: give --length 3600\n$/],
    [film("film-half", { seconds: 0.48 }), /musicfit: film-half\.mp4 is 0\.48 s long \(12 frames at 25 fps\), shorter than the 1 second --length takes at least, so musicfit makes no fit under it\n$/],
    // Frames count at 2.333 here, where the video's 8399 are more than an
    // hour, and at 0.333, a rate --fps does not take but this run counts at.
    [film("film-hour-7-3", { fps: "7/3", seconds: 3599.5 }), /musicfit: film-hour-7-3\.mp4 is 3599\.57 s long \(8399 frames at 2\.333 fps\) and --length is 12\.00 s: give --length 3599\.571\n$/],
    [film("film-every-3s", { fps: "1/3", seconds: 18 }), /musicfit: film-every-3s\.mp4 is 18\.00 s long \(6 frames at 0\.333 fps\) and --length is 12\.00 s: give --length 18, or 6f\n$/],
    [empty, /musicfit: Cannot read .*empty\.mp4: it is empty\n$/],
    [headFirst, /musicfit: Cannot read .*cut-fast\.mp4: it is cut short or damaged \(ffmpeg could read \d+ frames, \d\.\d\d s of the 12\.00 s it says it holds\)\n$/],
    [headLast, /musicfit: Cannot read .*cut-last\.mp4: it is cut short or damaged, so ffmpeg finds no index in it\n$/],
  ];
  for (const [video, message] of cases) {
    const out = at(`refused-${path.basename(video)}`);
    const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", video, "--out", out]);
    assert.equal(run.status, 1, `${video}: ${run.stderr}`);
    assert.match(run.stderr, message);
    assert.doesNotMatch(run.stderr, /Reading/);
    assert.ok(!fs.existsSync(out), `${video} made ${out}`);
  }
  // With --fps 30 frames count at 30, where the video's 8 are not its 16 s,
  // so no count of its frames is offered.
  const slow = cli([fixture("house").file, "--length", "12", "--hit", "8", "--fps", "30", "--video", film("film-every-2s", { fps: "1/2", seconds: 16 }), "--out", at("refused-every-2s")]);
  assert.equal(slow.status, 1, slow.stderr);
  assert.match(slow.stderr, /musicfit: film-every-2s\.mp4 is 16\.00 s long \(8 frames at 0\.5 fps\) and --length is 12\.00 s: give --length 16\n$/);
  assert.ok(!fs.existsSync(at("refused-every-2s")));
  assert.deepEqual(fs.readdirSync(dir).filter((e) => e.startsWith(".musicfit-")), []);
});

test("the length a refusal offers is one --length takes, and a video no such length comes within a frame of is refused as such", () => {
  const { fits } = require("../skills/musicfit/scripts/lib/video");
  const video = (seconds, fps, frames, constant = true) => ({ name: "v.mp4", seconds, fps, frames, constant });
  // Within a frame past the hour: an hour takes it.
  assert.doesNotThrow(() => fits(video(3600.5, 2, 7201), 3600, 2));
  assert.doesNotThrow(() => fits(video(3601, 1, 3601), 3600, 1));
  assert.throws(() => fits(video(3600.5, 2, 7201), 12, 2), { message: "v.mp4 is 3600.50 s long (7201 frames at 2 fps) and --length is 12.00 s: give --length 3600" });
  assert.throws(() => fits(video(3601, 1, 3601), 12, 1), { message: "v.mp4 is 3601.00 s long (3601 frames at 1 fps) and --length is 12.00 s: give --length 3600" });
  // Past it by more than a frame, whatever the length, the rate or how steady it is.
  for (const [v, length, fps] of [[video(3602, 1, 3602), 3600, 1], [video(3601, 2, 7202), 3600, 2], [video(7200, 30, 216000), 12, 30], [video(7200, 25, 180000), 3600, 30]]) {
    assert.throws(() => fits(v, length, fps), { message: `v.mp4 is ${v.seconds.toFixed(2)} s long (${v.frames} frames at ${v.fps} fps), longer than the hour --length takes at most: give --video a cut of an hour or less` });
  }
  assert.throws(() => fits(video(5000, 29.5, 147500, false), 12, 30), { message: "v.mp4 is 5000.00 s long, longer than the hour --length takes at most: give --video a cut of an hour or less" });
  // Under a second by more than a frame, and within a frame of it.
  assert.throws(() => fits(video(0.48, 25, 12), 1, 25), { message: "v.mp4 is 0.48 s long (12 frames at 25 fps), shorter than the 1 second --length takes at least, so musicfit makes no fit under it" });
  assert.throws(() => fits(video(0.98, 50, 49), 12, 50), { message: "v.mp4 is 0.98 s long (49 frames at 50 fps) and --length is 12.00 s: give --length 1" });
  assert.doesNotThrow(() => fits(video(0.98, 50, 49), 1, 50));
  // Past 200 fps a frame is under half a hundredth of a second, and past
  // 2000 fps under half a thousandth: the length is written to as many
  // places as tell it from the end it passes.
  assert.throws(() => fits(video(3600.00458, 240, 864001), 12, 240), { message: "v.mp4 is 3600.005 s long (864001 frames at 240 fps), longer than the hour --length takes at most: give --video a cut of an hour or less" });
  assert.throws(() => fits(video(2389 / 2400, 240, 239), 1, 240), { message: "v.mp4 is 0.995 s long (239 frames at 240 fps), shorter than the 1 second --length takes at least, so musicfit makes no fit under it" });
  assert.throws(() => fits(video(9000001.125 / 2500, 2500, 9000001), 3600, 2500), { message: "v.mp4 is 3600.000450 s long (9000001 frames at 2500 fps), longer than the hour --length takes at most: give --video a cut of an hour or less" });
  assert.throws(() => fits(video(2498.875 / 2500, 2500, 2499), 1, 2500), { message: "v.mp4 is 0.999550 s long (2499 frames at 2500 fps), shorter than the 1 second --length takes at least, so musicfit makes no fit under it" });
  // A frame and a millionth of a second past the hour or under a second,
  // where the two sides of the test for a frame can round apart: whatever
  // a refusal says, a run given --length 3600 or 1 hears the same.
  for (const [v, end] of [[video(0.979999, 50, 49), 1], [video(3600.07299370073, 13.7, 49321), 3600], [video(3600 + 1 / 3 + 1e-6, 3, 10801), 3600]]) {
    const said = [12, end].map((length) => {
      try {
        fits(v, length, v.fps);
      } catch (err) {
        return err.message;
      }
      return "";
    });
    assert.equal(said[0], said[1], `${v.seconds}`);
    assert.match(said[0], end === 1 ? /, shorter than the 1 second --length takes at least, so musicfit makes no fit under it$/ : /, longer than the hour --length takes at most: give --video a cut of an hour or less$/);
  }
  // Within the hour as before, in frames too.
  assert.throws(() => fits(video(3599, 1, 3599), 12, 1), { message: "v.mp4 is 3599.00 s long (3599 frames at 1 fps) and --length is 12.00 s: give --length 3599, or 3599f" });
  // A count of frames goes only at the rate this run counts at: a run given
  // it at another would read --hit, --drop and --fade in frames there too.
  assert.throws(() => fits(video(14, 25, 350), 12, 30), { message: "v.mp4 is 14.00 s long (350 frames at 25 fps) and --length is 12.00 s: give --length 14" });
  // Frames are offered only as a run given them reads them. Without --fps
  // such a run counts at 56.943, where 204995 frames are more than an hour,
  // and with --fps 57000/1001 at the rate itself, where they are not.
  const hour = video((204995 * 1001) / 57000, 57000 / 1001, 204995);
  assert.throws(() => fits(hour, 12, 56.943), { message: "v.mp4 is 3600.00 s long (204995 frames at 56.943 fps) and --length is 12.00 s: give --length 3600" });
  assert.throws(() => fits(hour, 12, 57000 / 1001), { message: "v.mp4 is 3600.00 s long (204995 frames at 56.943 fps) and --length is 12.00 s: give --length 3600, or 204995f" });
  // A last frame shown for a twentieth of its step leaves the count past
  // the hour; one shown for two steps leaves it under a second.
  assert.throws(() => fits(video(3599.998, 30000 / 1001, 107893), 12, 29.97), { message: "v.mp4 is 3600.00 s long (107893 frames at 29.97 fps) and --length is 12.00 s: give --length 3599.998" });
  assert.throws(() => fits(video(1, 25, 24), 12, 25), { message: "v.mp4 is 1.00 s long (24 frames at 25 fps) and --length is 12.00 s: give --length 1" });
  // The count is read at this run's rate and goes only when it lands
  // within a frame there: the rate is the run's --fps, or with none the
  // video's as fpsText writes it, which may be one --fps does not take.
  assert.throws(() => fits(video(12, 0.5, 6), 20, 30), { message: "v.mp4 is 12.00 s long (6 frames at 0.5 fps) and --length is 20.00 s: give --length 12" });
  assert.throws(() => fits(video(2, 1000, 2000), 12, 30), { message: "v.mp4 is 2.00 s long (2000 frames at 1000 fps) and --length is 12.00 s: give --length 2" });
  assert.throws(() => fits(video(481 / 240.4, 240.4, 481), 12, 240), { message: "v.mp4 is 2.00 s long (481 frames at 240.4 fps) and --length is 12.00 s: give --length 2.001, or 481f" });
  assert.throws(() => fits(video(12, 0.5, 6), 20, 0.5), { message: "v.mp4 is 12.00 s long (6 frames at 0.5 fps) and --length is 20.00 s: give --length 12, or 6f" });
  assert.throws(() => fits(video(12, 1 / 3, 4), 20, 0.333), { message: "v.mp4 is 12.00 s long (4 frames at 0.333 fps) and --length is 20.00 s: give --length 12, or 4f" });
});

test("the README and SKILL.md say what a refusal of a video that is not --length long gives, as fits() decides it", () => {
  const { fits } = require("../skills/musicfit/scripts/lib/video");
  const said = "the message gives the length to use, 3600 for a video at most a frame past the hour and 1 for one at most a frame under a second; a video more than a frame past the hour is asked for a cut of an hour or less, and one more than a frame under a second gets no fit";
  for (const file of ["../README.md", "../skills/musicfit/SKILL.md"]) assert.ok(fs.readFileSync(path.join(__dirname, file), "utf8").includes(said), file);
  // At 25 fps a frame is 0.04 s.
  const refusal = (seconds) => {
    try {
      fits({ name: "v.mp4", seconds, fps: 25, frames: Math.round(seconds * 25), constant: true }, 12, 25);
    } catch (err) {
      return err.message;
    }
    return "";
  };
  assert.match(refusal(3600.04), /: give --length 3600$/);
  assert.match(refusal(3600.08), /, longer than the hour --length takes at most: give --video a cut of an hour or less$/);
  assert.match(refusal(0.96), /: give --length 1$/);
  assert.match(refusal(0.92), /, shorter than the 1 second --length takes at least, so musicfit makes no fit under it$/);
});

test("every length a refusal offers, in seconds or in frames, is one that a run given it takes at the rate it counts at, and a video refused with no offer is more than a frame past the hour or under a second", () => {
  const { fits, fpsText } = require("../skills/musicfit/scripts/lib/video");
  const { check, parseTime } = require("../skills/musicfit/scripts/musicfit");
  const refusal = (info, length, fps) => {
    try {
      fits(info, length, fps);
    } catch (err) {
      return err.message;
    }
    return "";
  };
  // A run given an offer reads it as musicfit.js does, at this run's rate:
  // its --fps, else the video's as fpsText writes it. It then has to pass
  // check() and fits().
  const takes = (info, offer, fps) => {
    const length = parseTime("--length", offer, fps);
    check({ length });
    fits(info, length, fps);
  };
  const pictures = [];
  const picture = (seconds, rate, frames, rates) => pictures.push({ info: { name: "v.mp4", seconds, fps: rate, frames, constant: true }, rates });
  // Around the hour and the second at usual rates and others, a step or
  // two either side, the last frame shown for a twentieth of a step up to
  // two and a half, counted at the video's rate and at others.
  for (const rate of [57000 / 1001, 30000 / 1001, 24000 / 1001, 60000 / 1001, 25, 30, 7 / 3, 13.7, 0.5, 1 / 3, 240.4, 1000]) {
    for (const seconds of [1, 3600]) {
      for (const shift of [-2, -1, 0, 1, 2]) {
        const frames = Math.round(seconds * rate) + shift;
        if (frames < 2) continue;
        for (const last of [0.05, 0.5, 1, 1.5, 2.5]) picture((frames - 1 + last) / rate, rate, frames, [Number(fpsText(rate)), 25, 30, 240]);
      }
    }
  }
  // Exactly a frame and a millionth of a second past the hour and under a
  // second, the edge of the test for a frame, and a hair either side, at
  // every whole rate --fps takes and some others.
  for (const rate of [...Array.from({ length: 240 }, (_, i) => i + 1), 24000 / 1001, 30000 / 1001, 60000 / 1001, 13.7, 7 / 3, 240.4, 1000, 2500]) {
    const frame = 1 / rate + 1e-6;
    for (const edge of [3600 + frame, 1 - frame]) {
      for (const hair of [0, 1e-9, -1e-9]) picture(edge + hair, rate, Math.max(2, Math.round((edge + hair) * rate)), [Number(fpsText(rate))]);
    }
  }
  // Past 2000 fps a frame is shorter than the third place an offer is
  // written to.
  for (const rate of [2001, 2500, 4000, 10000]) {
    for (const whole of [1, 5, 600, 3599]) {
      for (const shift of [0, 1, 2]) {
        const frames = Math.round(whole * rate) + shift;
        for (const last of [0.05, 0.25, 0.75, 1, 1.25, 1.5, 2]) picture((frames - 1 + last) / rate, rate, frames, [Number(fpsText(rate))]);
      }
    }
  }
  let offers = 0;
  let inFrames = 0;
  let refused = 0;
  for (const { info, rates } of pictures) {
    for (const fps of rates) {
      const said = refusal(info, 12, fps);
      if (!said) continue;
      assert.doesNotMatch(said, /with --fps/);
      const offer = /: give --length ([\d.]+)(?:, or (\d+f))?$/.exec(said);
      if (!offer) {
        // No length --length takes comes within a frame of it: the end it
        // passes does not, and a run given that end hears the same.
        refused++;
        assert.ok(info.seconds > 3600 || info.seconds < 1, said);
        assert.equal(refusal(info, info.seconds > 3600 ? 3600 : 1, fps), said);
        continue;
      }
      offers++;
      assert.doesNotThrow(() => takes(info, offer[1], fps), said);
      if (!offer[2]) continue;
      inFrames++;
      assert.doesNotThrow(() => takes(info, offer[2], fps), said);
    }
  }
  assert.ok(offers >= 2600 && inFrames >= 600 && refused >= 1300, `${offers} offers, ${inFrames} of them in frames, ${refused} refused`);
});

test("a video a frame and a millionth of a second under a second is refused as one under a second, and a run given --length 1 hears the same", () => {
  // 49 frames at 50 fps on a timescale of microseconds, the last moved a
  // microsecond early: 0.979999 s, where the two tests that decided this
  // refusal rounded apart, and --length 1 was offered and refused again.
  // The expression that moves it has no comma, as ffmpeg 4.4 splits -bsf
  // at every one: floor(N/48) is 1 for the last packet, 48, and 0 before.
  const base = film("s50-us", { fps: 50, seconds: 0.98, codec: ["-c:v", "mpeg4", "-q:v", "6", "-video_track_timescale", "1000000"] });
  const video = at("s50-us-early.mp4");
  if (!fs.existsSync(video)) ffmpeg(["-i", base, "-c", "copy", "-bsf:v", "setts=ts=TS-floor(N/48)", "-video_track_timescale", "1000000", video]);
  for (const length of ["12", "1"]) {
    const run = cli([fixture("house").file, "--length", length, "--video", video, "--out", at(`s50-us-${length}`)]);
    assert.equal(run.status, 1, run.stderr);
    assert.equal(run.stderr, "musicfit: s50-us-early.mp4 is 0.98 s long (49 frames at 50 fps), shorter than the 1 second --length takes at least, so musicfit makes no fit under it\n", `--length ${length}`);
  }
});

test("a run that follows a refusal's offer, its other options as they were, is taken and puts --hit given in frames where the first run put it", () => {
  const video = film("film14", { seconds: 14 });
  let runs = 0;
  // Each offer as the refusal words it: --length set to it, and --fps to
  // the rate it names, if any; the rest as given.
  const follow = (args, message, hit) => {
    const refused = cli([fixture("house").file, "--length", "13", ...args, "--video", video, "--out", at("offer-refused")]);
    assert.equal(refused.status, 1, refused.stderr);
    assert.equal(refused.stderr, `musicfit: ${message}\n`);
    for (const offer of /: give --length (.+)$/.exec(refused.stderr.trim())[1].split(", or ")) {
      const [length, fps] = offer.split(" with --fps ");
      const given = fps ? args.map((arg, i) => (args[i - 1] === "--fps" ? fps : arg)) : args;
      const out = at(`offer-${++runs}`);
      const run = cli([fixture("house").file, "--length", length, ...given, "--video", video, "--out", out]);
      assert.equal(run.status, 0, `${offer}: ${run.stderr}`);
      assert.equal(cuesOf(out).drop.time, hit, offer);
    }
  };
  // At --fps 30 the video's 350 frames are not its 14 s, so only the
  // seconds go, and --hit 300f stays at 10 s.
  follow(["--fps", "30", "--hit", "300f"], "film14.mp4 is 14.00 s long (350 frames at 25 fps) and --length is 13.00 s: give --length 14", 10);
  // At its own rate the count goes too, and --hit 300f stays at 12 s.
  follow(["--fps", "25", "--hit", "300f"], "film14.mp4 is 14.00 s long (350 frames at 25 fps) and --length is 13.00 s: give --length 14, or 350f", 12);
  assert.equal(runs, 3);
});

// The boxes at the top of an MP4 or a MOV, each as { kind, at, size }.
function topBoxes(bytes) {
  const found = [];
  for (let at = 0; at + 8 <= bytes.length; ) {
    const size = bytes.readUInt32BE(at);
    found.push({ kind: bytes.toString("latin1", at + 4, at + 8), at, size });
    if (size < 8) break;
    at += size;
  }
  return found;
}

// An ID3v2.4 tag with one title frame, as a tagger puts at a file's start.
function id3(flags = 0, footer = false) {
  const frame = Buffer.concat([Buffer.from("TIT2", "latin1"), Buffer.from([0, 0, 0, 6, 0, 0, 3]), Buffer.from("title", "latin1")]);
  const head = (magic) => Buffer.concat([Buffer.from(magic, "latin1"), Buffer.from([4, 0, flags, 0, 0, 0, frame.length])]);
  return Buffer.concat([head("ID3"), frame, footer ? head("3DI") : Buffer.alloc(0)]);
}

test("an MP4 or a MOV cut short inside its index is said to be, wherever in the index it stops, on every ffmpeg, also behind an ID3v2 tag, a box of a kind no format knows or a MOV's wide box with no ftyp before it, and one that lacks only the end of its tags goes through", () => {
  const refused = (video) => {
    const out = at(`refused-${path.basename(video)}`);
    const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", video, "--out", out]);
    assert.equal(run.status, 1, `${video}: ${run.stderr}`);
    assert.equal(run.stderr, `musicfit: Cannot read ${video}: it is cut short or damaged, so ffmpeg finds no index in it\n`, video);
    assert.ok(!fs.existsSync(out), video);
  };
  for (const ext of ["mp4", "mov"]) {
    // A picture and a sound of its own, the index after them, as ffmpeg
    // writes one: the picture's part of it first, then the sound's.
    const whole = film(`film12-sound-${ext}`, { sound: effects(), ext });
    const bytes = fs.readFileSync(whole);
    const moov = topBoxes(bytes).find((box) => box.kind === "moov");
    const box = (kind, from) => bytes.indexOf(kind, from, "latin1") - 4;
    const picture = box("trak", moov.at);
    const sound = box("trak", picture + 8);
    const offsets = box("stco", picture);
    const cuts = [
      ["just inside", moov.at + 10],
      ["in tkhd", box("tkhd", picture) + 24],
      ["in hdlr", box("hdlr", picture) + 34],
      ["in stsd", box("stsd", picture) + 16],
      // ffmpeg 4.4 will not copy a picture whose size it does not know.
      ["where stts starts", box("stts", picture)],
      ["in stts", box("stts", picture) + 10],
      ["in stsz", box("stsz", picture) + 24],
      // ffmpeg 8 and 9 say nothing of these: they read a cut among the
      // picture's chunk offsets as a shorter video, and one before the
      // sound's part of the index as a video with no sound of its own.
      ["in the picture's chunk offsets", offsets + Math.floor(bytes.readUInt32BE(offsets) / 2)],
      ["where the sound's starts", sound],
      ["in the sound's hdlr", box("hdlr", sound) + 34],
    ];
    assert.ok(picture > moov.at && sound > offsets && offsets > picture, `${whole}: ${picture} ${offsets} ${sound}`);
    for (const [where, size] of cuts) {
      const video = at(`cut-index ${where}.${ext}`);
      fs.writeFileSync(video, bytes.subarray(0, size));
      refused(video);
    }
    // ffmpeg has all it needs: the last bytes are the file's tags.
    const nearly = at(`cut-index tags.${ext}`);
    fs.writeFileSync(nearly, bytes.subarray(0, bytes.length - 8));
    const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", nearly, "--video-sound", "keep", "--out", at(`index-tags-fit-${ext}`)]);
    assert.equal(run.status, 0, run.stderr);
  }
  // ffmpeg passes over ID3v2 tags at the start of a file, and over a box
  // of a kind it does not know, as it guesses what the file is; a MOV may
  // start with its wide box.
  const bytes = fs.readFileSync(film("film12", {}));
  const moov = topBoxes(bytes).find((box) => box.kind === "moov");
  const stsd = bytes.subarray(0, bytes.indexOf("stsd", moov.at, "latin1") + 12);
  const tagged = at("cut-index tagged.mp4");
  fs.writeFileSync(tagged, Buffer.concat([id3(), stsd]));
  refused(tagged);
  const boxed = at("cut-index boxed.mp4");
  fs.writeFileSync(boxed, Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from("abcd", "latin1"), Buffer.alloc(8), stsd]));
  refused(boxed);
  const mov = fs.readFileSync(film("film12mov", { ext: "mov" }));
  const [ftyp] = topBoxes(mov);
  assert.equal(ftyp.kind, "ftyp");
  const wide = at("cut-index wide.mov");
  fs.writeFileSync(wide, mov.subarray(ftyp.size, mov.indexOf("stsd", topBoxes(mov).find((box) => box.kind === "moov").at, "latin1") + 12));
  assert.equal(fs.readFileSync(wide).toString("latin1", 4, 8), "wide");
  refused(wide);
});

test("a video ffmpeg finds cut short as it opens it is said to be, and one ffmpeg only guessed the kind of is not: a Matroska file cut after 600 bytes, also in folders named with ffmpeg's words, an MPEG-TS whose picture ffmpeg knows no size of where it stops, an FLV whose head that gives the size is zeroed, an AVI cut where its frames start, three bytes of text named .mkv, and text named .aac, which ffmpeg cannot open", () => {
  const cut = (from, name, size) => {
    fs.mkdirSync(path.dirname(at(name)), { recursive: true });
    fs.writeFileSync(at(name), fs.readFileSync(from).subarray(0, size));
    return at(name);
  };
  const mkv = film("film12-sound-mkv", { sound: effects(), ext: "mkv" });
  const ts = film("film12-sound-ts", { sound: effects(), ext: "ts" });
  const avi = film("film12avi", { ext: "avi" });
  const frames = fs.readFileSync(avi).indexOf("movi", 0, "latin1") - 8;
  assert.ok(frames > 0, avi);
  fs.writeFileSync(at("notes.mkv"), "ok\n");
  fs.writeFileSync(at("notes.aac"), "some notes\n");
  const unknown = "it is not a kind of file ffmpeg reads, or it is cut short or damaged";
  const noSize = /^ffmpeg finds no size for its picture$/;
  const cases = [
    [cut(mkv, "cut-600.mkv", 600), /^it is cut short or damaged$/],
    [cut(mkv, path.join("detected only with low score", "cut-600.mkv"), 600), /^it is cut short or damaged$/],
    [cut(mkv, path.join("Invalid data found", "cut-600.mkv"), 600), /^it is cut short or damaged$/],
    [cut(ts, "cut-600.ts", 600), noSize],
    [cut(avi, "cut-at-frames.avi", frames), new RegExp(`^${unknown}$`)],
    [at("notes.mkv"), new RegExp(`^${unknown}$`)],
    // ffmpeg's words, which differ from one version to the next.
    [at("notes.aac"), /^ffmpeg: (?:Error opening input: )?End of file$/],
    [cut(at("notes.aac"), path.join("Invalid data found", "notes.aac"), 100), /^ffmpeg: (?:Error opening input: )?End of file$/],
  ];
  // An FLV of H.264, which gives its picture's size in a packet at its head,
  // zeroed there: ffmpeg 4.4 will not copy a picture of no size, and 8 and
  // 9 copy its packets, but no MP4 takes it.
  if (/\blibx264\b/.test(spawnSync(FFMPEG, ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout)) {
    const flv = fs.readFileSync(film("film12-sound-flv", { sound: effects(), ext: "flv", codec: ["-c:v", "libx264"] }));
    fs.writeFileSync(at("zero-head.flv"), Buffer.concat([flv.subarray(0, 100), Buffer.alloc(400), flv.subarray(500)]));
    cases.push([at("zero-head.flv"), noSize]);
  }
  for (const [video, why] of cases) {
    const out = at(`refused-${path.basename(video)}`);
    const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", video, "--out", out]);
    assert.equal(run.status, 1, `${video}: ${run.stderr}`);
    const said = run.stderr.split("\n").filter(Boolean);
    assert.equal(said.length, 1, run.stderr);
    assert.ok(said[0].startsWith(`musicfit: Cannot read ${video}: `), run.stderr);
    assert.match(said[0].slice(`musicfit: Cannot read ${video}: `.length), why, video);
    assert.ok(!fs.existsSync(out), video);
  }
});

// An MP4, `bytes`, whose moov holds its udta, with the cover in it, before
// its trak, and whose cover's JPEG past its first four bytes is made bytes
// no decoder reads. The moov keeps its size, so the places of the picture's
// data stay true.
function coverBeforePicture(bytes) {
  const out = Buffer.from(bytes);
  const moov = topBoxes(bytes).find((box) => box.kind === "moov");
  const inside = [];
  for (let at = moov.at + 8; at + 8 <= moov.at + moov.size; ) {
    const size = bytes.readUInt32BE(at);
    inside.push({ kind: bytes.toString("latin1", at + 4, at + 8), at, size });
    if (size < 8) break;
    at += size;
  }
  const first = (box) => (box.kind === "mvhd" ? 0 : box.kind === "udta" ? 1 : 2);
  const order = [...inside].sort((a, b) => first(a) - first(b));
  Buffer.concat(order.map((box) => bytes.subarray(box.at, box.at + box.size))).copy(out, moov.at + 8);
  const data = out.indexOf("data", out.indexOf("covr", moov.at, "latin1"), "latin1");
  let seed = 11;
  for (let i = data + 16; i < data - 4 + out.readUInt32BE(data - 4); i++) out[i] = (seed = (seed * 1103515245 + 12345) % 2147483648) >>> 23;
  return out;
}

// An MPEG-TS with the packets of the PIDs `drop` left out, and of the PID
// `first` its first `some` packets only, from `from` into `to`.
function withoutPackets(from, to, drop, { first = null, some = 0 } = {}) {
  const bytes = fs.readFileSync(from);
  const kept = [];
  let left = some;
  for (let at = 0; at + 188 <= bytes.length; at += 188) {
    const pid = ((bytes[at + 1] & 0x1f) << 8) | bytes[at + 2];
    if (drop.includes(pid)) continue;
    if (pid === first && left > 0) {
      left--;
      continue;
    }
    kept.push(bytes.subarray(at, at + 188));
  }
  fs.writeFileSync(to, Buffer.concat(kept));
  return to;
}

test("a whole video is read by the picture musicfit lays the music under, the one -map 0:V:0 copies, whatever ffmpeg lists of its other streams: an MPEG-TS whose PMT lists a second picture with no packets, one whose second picture starts after ffmpeg's probe, one whose programs list that empty picture first, and a Matroska file with a cover ffmpeg cannot read fit on every ffmpeg, and the same TS with no packets of its first picture is refused", () => {
  const fit = (video, args = []) => {
    const out = at(`fits-${path.basename(video)}`);
    const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", video, ...args, "--out", out]);
    assert.equal(run.status, 0, `${video}: ${run.stderr}`);
    assert.deepEqual(packets(path.join(out, "video.mp4")), packets(video), video);
  };
  // A second picture of another size, and the film's sound, on PIDs 0x100
  // (the first picture), 0x101 (the sound) and 0x102 (the second picture),
  // as a recording of a broadcast whose PMT lists a service that sent
  // nothing has no packets of it.
  const two = at("two-pictures.ts");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=160x96:r=25:d=12", "-f", "lavfi", "-i", "testsrc=s=128x72:r=25:d=12", "-i", effects(), "-map", "0:v:0", "-map", "2:a:0", "-map", "1:v:0", "-t", "12", "-c:v", "mpeg4", "-q:v", "6", "-c:a", "aac", "-b:a", "128k", "-mpegts_start_pid", "0x100", two]);
  const empty = withoutPackets(two, at("empty-second-picture.ts"), [0x102]);
  assert.match(said(empty), /^\s*Stream #0:2\[0x102\]: Video: [^,\n]+, none\b(?!.*\d+x\d+)/m);
  fit(empty, ["--video-sound", "keep"]);
  // A second picture that starts 8 s in, past what ffmpeg reads to learn
  // the streams, so it lists that one with no size.
  const later = at("later-picture.ts");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=160x96:r=25:d=12", "-itsoffset", "8", "-f", "lavfi", "-i", "testsrc=s=160x96:r=25:d=4", "-map", "0:v", "-map", "1:v", "-c:v", "mpeg4", "-q:v", "6", later]);
  assert.match(said(later), /^\s*Stream #0:1\[0x101\]: Video: [^,\n]+, none\b(?!.*\d+x\d+)/m);
  fit(later);
  // Two programs, the second picture's listed first: with the first copies
  // of its PMT left out, ffmpeg meets the other program's first and numbers
  // its picture 0, which -map 0:V:0 copies, but lists the programs in the
  // order the file names them.
  const programs = at("two-programs.ts");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=160x96:r=25:d=12", "-f", "lavfi", "-i", "testsrc=s=128x72:r=25:d=12", "-map", "0:v", "-map", "1:v", "-c:v", "mpeg4", "-q:v", "6", "-mpegts_start_pid", "0x100", "-mpegts_pmt_start_pid", "0x1000", "-program", "program_num=1:st=1", "-program", "program_num=2:st=0", programs]);
  const listed = withoutPackets(programs, at("empty-program-first.ts"), [0x101], { first: 0x1000, some: 3 });
  const streams = said(listed).split("\n").filter((line) => /^\s*Stream #0:/.test(line));
  assert.match(streams[0], /^\s*Stream #0:1\[0x101\]: Video: [^,\n]+, none\b(?!.*\d+x\d+)/, streams.join("\n"));
  assert.match(streams[1], /^\s*Stream #0:0\[0x100\]: Video: .*, 160x96\b/, streams.join("\n"));
  fit(listed);
  // A cover whose bytes are no picture: ffmpeg lists it, an attached pic,
  // with no size, and -map 0:V:0 leaves it out.
  const cover = at("no-picture.jpg");
  let seed = 11;
  fs.writeFileSync(cover, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(Array.from({ length: 3000 }, () => (seed = (seed * 1103515245 + 12345) % 2147483648) >>> 23))]));
  const covered = at("covered.mkv");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=160x96:r=25:d=12", "-c:v", "mpeg4", "-q:v", "6", "-attach", cover, "-metadata:s:t", "mimetype=image/jpeg", covered]);
  assert.match(said(covered), /^\s*Stream #0:1: Video: [^,\n]+, none\b(?!.*\d+x\d+).*\(attached pic\)/m);
  fit(covered);
  // Such a cover numbered before the picture, as ffmpeg numbers the one of
  // an MP4 whose udta, with the cover in it, comes before its trak: -map
  // 0:V:0 leaves a cover out whatever its number.
  const jpeg = at("small-cover.jpg");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=64x64:d=1", "-frames:v", "1", jpeg]);
  const withCover = at("with-cover.mp4");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=160x96:r=25:d=12", "-i", jpeg, "-map", "0:v", "-map", "1:v", "-c:v:0", "mpeg4", "-q:v", "6", "-c:v:1", "copy", "-disposition:v:1", "attached_pic", "-movflags", "+faststart", withCover]);
  const coverFirst = at("cover-first.mp4");
  fs.writeFileSync(coverFirst, coverBeforePicture(fs.readFileSync(withCover)));
  assert.match(said(coverFirst), /^\s*Stream #0:0\S*: Video: [^,\n]+, none\b(?!.*\d+x\d+).*\(attached pic\)/m);
  assert.match(said(coverFirst), /^\s*Stream #0:1\S*: Video: .*, 160x96\b/m);
  fit(coverFirst);
  // The picture -map 0:V:0 copies, with no packets: ffmpeg lists it with
  // no size, and an MP4 cannot take it.
  const none = withoutPackets(two, at("empty-first-picture.ts"), [0x100]);
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", none, "--video-sound", "keep", "--out", at("refused-empty-first-picture")]);
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stderr, `musicfit: Cannot read ${none}: ffmpeg finds no size for its picture\n`);
});

test("a picture ffmpeg lists with no size is refused in words true of every video it lists one for, a whole MPEG-TS whose only picture starts 8 s after its sound, past what ffmpeg reads to learn the streams, among them, and a still picture is told so whether or not ffmpeg finds its size, as a PNG behind an ID3v2 tag, which ffmpeg 9 finds none for, on every ffmpeg", () => {
  const late = at("late-picture.ts");
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=20", "-itsoffset", "8", "-f", "lavfi", "-i", "testsrc2=s=160x96:r=25:d=12", "-map", "1:v", "-map", "0:a", "-c:v", "mpeg4", "-q:v", "6", "-c:a", "aac", "-b:a", "128k", late]);
  assert.match(said(late), /^\s*Stream #0:0\[0x100\]: Video: [^,\n]+, none\b(?!.*\d+x\d+)/m);
  const refused = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", late, "--out", at("refused-late-picture")]);
  assert.equal(refused.status, 1, refused.stderr);
  assert.equal(refused.stderr, `musicfit: Cannot read ${late}: ffmpeg finds no size for its picture\n`);
  const png = at("still-picture.png");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=160x96:d=1", "-frames:v", "1", png]);
  const tagged = at("tagged-still.png");
  fs.writeFileSync(tagged, Buffer.concat([id3(), fs.readFileSync(png)]));
  const still = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", tagged, "--out", at("refused-tagged-still")]);
  assert.equal(still.status, 1, still.stderr);
  assert.equal(still.stderr, "musicfit: tagged-still.png is a still picture, not a video\n");
});

test("a HEIF picture, as an AVIF or a HEIC is, is a still picture, also on ffmpeg 4.4, which reads no HEIF, and as the track it has no audio stream", () => {
  const avif = at("still.avif");
  fs.copyFileSync(path.join(__dirname, "fixtures", "still.avif"), avif);
  const run = cli([fixture("house").file, "--length", "12", "--video", avif, "--out", at("refused-still-avif")]);
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stderr, "musicfit: still.avif is a still picture, not a video\n");
  const track = cli([avif, "--length", "12", "--out", at("still-avif-track")]);
  assert.equal(track.status, 1, track.stderr);
  assert.equal(track.stderr.split("\n").filter(Boolean).pop(), `musicfit: ${avif} has no audio stream`);
});

test("a JPEG XL picture in its box is never taken for an MP4 cut short: where ffmpeg reads JPEG XL it is a still picture with no audio stream, and where it does not, as ffmpeg 4.4 takes it for an MP4 with no moov, it is a file ffmpeg does not read, as the video, the track and the voice", () => {
  const jxl = at("still.jxl");
  fs.copyFileSync(path.join(__dirname, "fixtures", "still.jxl"), jxl);
  const reads = /^\s*D\S*\s+jpegxl_pipe\b/m.test(spawnSync(FFMPEG, ["-hide_banner", "-demuxers"], { encoding: "utf8" }).stdout);
  const unknown = `musicfit: Cannot read ${jxl}: it is not a kind of file ffmpeg reads, or it is cut short or damaged`;
  const video = cli([fixture("house").file, "--length", "12", "--video", jxl, "--out", at("refused-still-jxl")]);
  assert.equal(video.status, 1, video.stderr);
  assert.equal(video.stderr, `${reads ? "musicfit: still.jxl is a still picture, not a video" : unknown}\n`);
  for (const [i, args] of [[jxl, "--length", "12"], [fixture("house").file, "--length", "12", "--voice", jxl]].entries()) {
    const run = cli([...args, "--out", at(`still-jxl-${i}`)]);
    assert.equal(run.status, 1, run.stderr);
    assert.equal(run.stderr.split("\n").filter(Boolean).pop(), reads ? `musicfit: ${jxl} has no audio stream` : unknown, args.join(" "));
  }
});

test("a whole MP4 or M4A behind an ID3v2 tag is refused on every ffmpeg, as the video, the track and the voice, with a copy without the tag asked for: an ffmpeg that reads past the tag reads every packet of the picture from the wrong place", () => {
  const whole = film("film12", {});
  const tagged = at("whole tagged.mp4");
  fs.writeFileSync(tagged, Buffer.concat([id3(), fs.readFileSync(whole)]));
  // ffmpeg 4.4 and 8 read past the tag, each packet as many bytes early as
  // the tag is long: the same sizes, other bytes. ffmpeg 9 finds no index
  // behind the tag.
  if (!/moov atom not found/.test(said(tagged))) {
    const read = packets(tagged);
    const right = packets(whole);
    assert.equal(read.length, right.length);
    assert.ok(read.every((packet, i) => packet.split(",")[0] === right[i].split(",")[0] && packet !== right[i]), `${read.slice(0, 2)} ${right.slice(0, 2)}`);
  }
  const song = at("tag-song.m4a");
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=12", "-c:a", "aac", "-b:a", "128k", song]);
  const taggedSong = at("whole tagged song.m4a");
  fs.writeFileSync(taggedSong, Buffer.concat([id3(), fs.readFileSync(song)]));
  const runs = [
    [tagged, [fixture("house").file, "--length", "12", "--hit", "8", "--video", tagged]],
    [taggedSong, [taggedSong, "--length", "10"]],
    [taggedSong, [fixture("house").file, "--length", "10", "--voice", taggedSong]],
  ];
  for (const [i, [file, args]] of runs.entries()) {
    const out = at(`refused-tagged-${i}`);
    const run = cli([...args, "--out", out]);
    assert.equal(run.status, 1, run.stderr);
    assert.equal(run.stderr.split("\n").filter(Boolean).pop(), `musicfit: Cannot read ${file}: it starts with an ID3v2 tag, and ffmpeg can read an MP4, a MOV or an M4A behind one from the wrong place, or not at all: give a copy of it without the tag`, args.join(" "));
    assert.ok(!fs.existsSync(out), args.join(" "));
  }
  // The same sound without the tag goes through.
  const fit = cli([song, "--length", "10", "--out", at("untagged-fit")]);
  assert.equal(fit.status, 0, fit.stderr);
});

test("a WAV or a Matroska file behind an ID3v2 tag is read whole where ffmpeg reads past the tag, as 4.4 and 8 do, and where it does not, as 9 does not, it is refused with the tag named among the causes, as the track, the voice and the video; an MP3 cut in its first frames behind the tag is refused so on every ffmpeg", () => {
  const behind = (file) => `musicfit: Cannot read ${file}: it starts with an ID3v2 tag, which ffmpeg 9 does not read past in many kinds of file, or it is not a kind of file ffmpeg reads, or it is cut short or damaged: give a whole copy of it without the tag`;
  // The README and SKILL.md say so in the same words.
  for (const doc of ["README.md", path.join("skills", "musicfit", "SKILL.md")]) {
    const text = fs.readFileSync(path.join(__dirname, "..", doc), "utf8");
    assert.ok(text.includes("ffmpeg 9 does not read past such a tag in many kinds of file, WAV, AIFF, CAF, Matroska, WebM, AVI and ASF among them"), doc);
    assert.ok(text.includes("a whole copy without the tag"), doc);
  }
  const tagged = (from, name) => {
    fs.writeFileSync(at(name), Buffer.concat([id3(), fs.readFileSync(from)]));
    return at(name);
  };
  const { file: house } = fixture("house");
  const song = tagged(house, "tagged song.wav");
  const film12 = tagged(film("film12-house-mkv", { sound: house, ext: "mkv" }), "tagged film.mkv");
  const runs = [
    [song, [song, "--length", "10"]],
    [song, [house, "--length", "10", "--voice", song]],
    [song, [house, "--length", "12", "--video", song]],
    [film12, [film12, "--length", "10"]],
    [film12, [house, "--length", "10", "--voice", film12]],
    [film12, [house, "--length", "12", "--hit", "8", "--video", film12, "--video-sound", "drop"]],
  ];
  for (const [i, [file, args]] of runs.entries()) {
    const out = at(`behind-a-tag-${i}`);
    const run = cli([...args, "--out", out]);
    if (/Invalid data found/.test(said(file))) {
      assert.equal(run.status, 1, run.stderr);
      assert.equal(run.stderr.split("\n").filter(Boolean).pop(), behind(file), args.join(" "));
      assert.ok(!fs.existsSync(out), args.join(" "));
    } else if (args.includes("--video") && path.extname(file) === ".wav") {
      assert.equal(run.status, 1, run.stderr);
      assert.equal(run.stderr, "musicfit: tagged song.wav has no picture to lay the music under\n");
    } else {
      assert.equal(run.status, 0, `${args.join(" ")}: ${run.stderr}`);
    }
  }
  // An MP3 cut in its first frames, behind its tag, which every ffmpeg
  // reads past in an MP3: where ffmpeg finds no data it reads in it, as 8
  // and 9 do, the tag is named among the causes as well, and ffmpeg 4.4,
  // which fails to seek in it, is quoted after the file's name.
  if (/\blibmp3lame\b/.test(spawnSync(FFMPEG, ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout)) {
    const mp3 = at("tag-source.mp3");
    ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=12", "-c:a", "libmp3lame", mp3]);
    const cut = at("cut tagged.mp3");
    fs.writeFileSync(cut, Buffer.concat([id3(), fs.readFileSync(mp3).subarray(0, 200)]));
    const none = /Invalid data found/.test(said(cut));
    for (const [i, args] of [[cut, "--length", "10"], [house, "--length", "10", "--voice", cut]].entries()) {
      const run = cli([...args, "--out", at(`cut-behind-a-tag-${i}`)]);
      assert.equal(run.status, 1, run.stderr);
      const line = run.stderr.split("\n").filter(Boolean).pop();
      if (none) assert.equal(line, behind(cut), args.join(" "));
      else assert.ok(line.startsWith(`musicfit: Cannot read ${cut}: ffmpeg: `), line);
    }
  }
});

test("a video whose own sound is cut short is refused when that sound would be laid in, also when its name holds the words for a sound that has none, and goes with --video-sound drop", () => {
  // Written in fragments, each with the picture's frames first, then the
  // sound's, here a tone that fills some kilobytes of each: cut a kilobyte
  // before the end of the last one, all of the picture is there, as the
  // run with drop shows.
  const frag = film("frag-tone", { sound: bed(), codec: ["-c:v", "mpeg4", "-q:v", "6", "-movflags", "frag_keyframe+empty_moov+default_base_moof"] });
  const bytes = fs.readFileSync(frag);
  const data = topBoxes(bytes).filter((box) => box.kind === "mdat").pop();
  const cut = at("frag-tone cut.mp4");
  fs.writeFileSync(cut, bytes.subarray(0, data.at + data.size - 1000));
  // Its name holds the words of a sound that has none, which say nothing of it.
  const named = at("frag-tone cut has no audio.mp4");
  fs.copyFileSync(cut, named);
  for (const video of [cut, named]) {
    const keep = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", video, "--video-sound", "keep", "--out", at("frag-cut-keep")]);
    assert.equal(keep.status, 1, keep.stderr);
    const last = keep.stderr.split("\n").filter(Boolean).pop();
    assert.ok(last.startsWith(`musicfit: Cannot read ${video}: `), keep.stderr);
    assert.match(last.slice(`musicfit: Cannot read ${video}: `.length), /^it is cut short or damaged \(ffmpeg could read \d+\.\d\d s of its sound\)$/);
    assert.ok(!fs.existsSync(at("frag-cut-keep")));
  }
  const drop = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", cut, "--video-sound", "drop", "--out", at("frag-cut-drop")]);
  assert.equal(drop.status, 0, drop.stderr);
});

test("a video musicfit made is refused as --video while its sound would be laid in, naming the video it was made from when its cues.json is beside it, and taken with --video-sound drop", () => {
  const out = at("remade");
  const source = film("film25", { sound: effects() });
  const first = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", source, "--video-sound", "keep", "--out", out]);
  assert.equal(first.status, 0, first.stderr);
  // A copy of it graded or trimmed elsewhere keeps the mark.
  const graded = at("graded.mp4");
  ffmpeg(["-i", path.join(out, "video.mp4"), "-c", "copy", graded]);
  for (const how of [[], ["--video-sound", "keep"], ["--video-sound", "voice"]]) {
    const again = cli([fixture("house").file, "--length", "12", "--hit", "6", "--video", graded, ...how, "--out", at("remade-again")]);
    assert.equal(again.status, 1, `${how}: ${again.stderr}`);
    assert.match(again.stderr, /musicfit: graded\.mp4 is a video musicfit made, so its own sound has a fitted track in it already: give --video the video it was made from, or --video-sound drop to leave that sound out\n$/);
  }
  // Given as it is, with the cues.json it came with beside it, the video it
  // was made from is named.
  const back = cli([fixture("house").file, "--length", "12", "--hit", "6", "--video", path.join(out, "video.mp4"), "--video-sound", "keep", "--out", at("remade-back")]);
  assert.equal(back.status, 1, back.stderr);
  assert.match(back.stderr, /musicfit: video\.mp4 is a video musicfit made, so its own sound has a fitted track in it already: give --video the video it was made from \(film25\.mp4, as the cues\.json beside it says\), or --video-sound drop to leave that sound out\n$/);
  const dropped = cli([fixture("house").file, "--length", "12", "--hit", "6", "--video", graded, "--video-sound", "drop", "--out", at("remade-drop")]);
  assert.equal(dropped.status, 0, dropped.stderr);
  assert.deepEqual(packets(path.join(at("remade-drop"), "video.mp4")), packets(source));
});

test("a video.mp4 musicfit did not write is refused, a run without --video leaves it alone, and one musicfit wrote goes with the next run", () => {
  const out = at("theirs");
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, "video.mp4"), "their video\n");
  const refused = cli([fixture("house").file, "--length", "12", "--video", film("mute"), "--out", out]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /musicfit: .*theirs\/video\.mp4 is a file no musicfit cues\.json there lists, and this run would replace it: move it, or give another --out\n$/);
  assert.doesNotMatch(refused.stderr, /Reading/);
  const plainRun = cli([fixture("house").file, "--length", "12", "--out", out]);
  assert.equal(plainRun.status, 0, plainRun.stderr);
  assert.equal(fs.readFileSync(path.join(out, "video.mp4"), "utf8"), "their video\n");

  const ours = at("ours");
  assert.equal(cli([fixture("house").file, "--length", "12", "--video", film("mute"), "--out", ours]).status, 0);
  assert.ok(fs.existsSync(path.join(ours, "video.mp4")));
  const again = cli([fixture("house").file, "--length", "12", "--video", film("mute"), "--out", ours]);
  assert.equal(again.status, 0, again.stderr);
  const without = cli([fixture("house").file, "--length", "12", "--out", ours]);
  assert.equal(without.status, 0, without.stderr);
  assert.deepEqual(fs.readdirSync(ours).sort(), ["FIT.md", "cues.json", "fitted.wav", "seams.png"]);
});

test("the same sound is laid in once: a video that is the track, or the voice", () => {
  // A video whose own sound is the music.
  const music = at("music12.wav");
  ffmpeg(["-i", fixture("house").file, "-t", "12", music]);
  const clip = film("clip", { sound: music });
  const out = at("clip-fit");
  const run = cli([clip, "--length", "12", "--video", clip, "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual([cuesOf(out).video.sound, cuesOf(out).video.same], ["drop", "track"]);
  assert.match(run.stdout, /Note {4}clip\.mp4's own sound is the track, so it is not laid in a second time\./);

  const talk = film("talk", { sound: speech() });
  const both = at("talk-both");
  const voiced = cli([fixture("house").file, "--length", "12", "--hit", "8", "--voice", talk, "--video", talk, "--out", both]);
  assert.equal(voiced.status, 0, voiced.stderr);
  assert.deepEqual([cuesOf(both).video.sound, cuesOf(both).video.same], ["drop", "voice"]);
  assert.ok(fs.existsSync(path.join(both, "mix.wav")));
  assert.match(voiced.stdout, /Note {4}talk\.mp4's own sound is the voice given with --voice, so it is laid in once, as the voice\./);
});

test("frames count at the video's rate without --fps, another --fps is noted, and a rate that does not hold steady takes seconds only", () => {
  const video = film("film25", { sound: effects() });
  const out = at("frames25");
  const run = cli([fixture("house").file, "--length", "300f", "--hit", "200f", "--video", video, "--video-sound", "keep", "--out", out, "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const c = JSON.parse(run.stdout);
  assert.deepEqual([c.fps, c.length, c.drop.time, c.video.file], [25, 12, 8, "video.mp4"]);

  const other = cli([fixture("house").file, "--length", "12", "--hit", "8", "--fps", "30", "--video", video, "--video-sound", "keep", "--out", at("fps30")]);
  assert.equal(other.status, 0, other.stderr);
  assert.match(other.stdout, /Note {4}film25\.mp4 runs at 25 fps and --fps is 30, so the frames in cues\.json are not the video's: leave --fps out, or give --fps 25, to count them as the video does\./);

  // Every seventh frame left out and every fifth one 12 ms late, in a
  // timebase of milliseconds: frames come at no steady rate.
  const vfr = film("vfr", { fps: 30, filter: ["-vf", "select='not(eq(mod(n\\,7)\\,3))',settb=1/1000,setpts='PTS+if(eq(mod(N\\,5)\\,2)\\,12\\,0)'", FPS_MODE, "vfr", "-enc_time_base", "1/1000"] });
  const inFrames = cli([fixture("house").file, "--length", "360f", "--video", vfr, "--out", at("vfr-frames")]);
  assert.equal(inFrames.status, 1);
  assert.match(inFrames.stderr, /musicfit: vfr\.mp4 has no steady frame rate, so a time in frames does not name one moment of it: give --length in seconds, or give --fps\n$/);
  const long = cli([fixture("house").file, "--length", "13", "--video", vfr, "--out", at("vfr-long")]);
  assert.equal(long.status, 1);
  assert.match(long.stderr, /musicfit: vfr\.mp4 is 12\.00 s long and --length is 13\.00 s: give --length 12\n$/);
  const seconds = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", vfr, "--out", at("vfr-fit")]);
  assert.equal(seconds.status, 0, seconds.stderr);
  // 309 frames over the 12 s and the last one's length, which encoders
  // write a little differently: 25.75 on ffmpeg 8, 25.749 on 4.4.
  assert.match(seconds.stdout, /Note {4}vfr\.mp4 has no steady frame rate, so the frames in cues\.json count at its average, 25\.7[45]\d* fps\./);
});

test("frames left out of a steady rate are places in it: a recording that dropped frames, and a cut that keeps a frame from after its end, count at their rate", async () => {
  const { probe } = require("../skills/musicfit/scripts/lib/video");
  // Every seventh frame left out: the others stay on the 30 fps grid.
  const dropped = film("dropped", { fps: 30, filter: ["-vf", "select='not(eq(mod(n\\,7)\\,3))'", FPS_MODE, "vfr"] });
  const info = await probe(dropped);
  assert.deepEqual([info.constant, info.fps, info.frames, info.seconds], [true, 30, 360, 12]);
  const out = at("dropped-fit");
  const run = cli([fixture("house").file, "--length", "360f", "--hit", "240f", "--video", dropped, "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  const c = cuesOf(out);
  assert.deepEqual([c.fps, c.length, c.drop.time, c.video.fps, c.video.frames, c.video.steady], [30, 12, 8, 30, 360, true]);
  assert.doesNotMatch(run.stdout, /steady/);
  // As ffmpeg -ss 2.5 -t 6 -c copy can leave an H.264 cut: its last frame
  // comes three thirtieths after the one before, and the cut plays 6.1 s.
  const cut = film("tail-gap", { fps: 30, seconds: 6.1, filter: ["-vf", "select='not(between(n\\,180\\,181))'", FPS_MODE, "vfr"] });
  const tail = await probe(cut);
  assert.deepEqual([tail.constant, tail.fps, tail.frames, Number(tail.seconds.toFixed(3))], [true, 30, 183, 6.1]);
  const short = cli([fixture("house").file, "--length", "6", "--video", cut, "--out", at("tail-gap-6")]);
  assert.equal(short.status, 1);
  assert.match(short.stderr, /musicfit: tail-gap\.mp4 is 6\.10 s long \(183 frames at 30 fps\) and --length is 6\.00 s: give --length 6\.1, or 183f\n$/);
  const whole = cli([fixture("house").file, "--length", "183f", "--video", cut, "--out", at("tail-gap-fit")]);
  assert.equal(whole.status, 0, whole.stderr);
  assert.deepEqual(packets(path.join(at("tail-gap-fit"), "video.mp4")), packets(cut));
});

test("a 29.97 fps video counts at 29.97 and a 30 fps one at 30, even in a timebase of whole milliseconds", async () => {
  const { probe, fpsText } = require("../skills/musicfit/scripts/lib/video");
  for (const ext of ["mp4", "mkv"]) {
    const info = await probe(film(`ntsc-${ext}`, { fps: "30000/1001", ext }));
    assert.ok(info.constant, ext);
    assert.ok(Math.abs(info.fps - 30000 / 1001) < 1e-9, `${ext}: ${info.fps}`);
    assert.equal(fpsText(info.fps), "29.97");
  }
  // 30 fps in milliseconds steps 33, 33 and 34, which comes out 29.999.
  const thirty = await probe(film("thirty-mkv", { fps: 30, ext: "mkv" }));
  assert.ok(thirty.constant);
  assert.equal(thirty.fps, 30);
  // Copied into a finer timebase, it keeps those steps and is still steady.
  const copied = at("thirty-copied.mp4");
  ffmpeg(["-i", film("thirty-mkv", { fps: 30, ext: "mkv" }), "-c", "copy", copied]);
  const again = await probe(copied);
  assert.ok(again.constant);
  assert.equal(again.fps, 30);
});

test("an HEVC picture is tagged hvc1 in video.mp4, so Apple's players take it", { skip: !/libx265/.test(spawnSync(FFMPEG, ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout) && "this ffmpeg has no HEVC encoder" }, () => {
  const hevc = film("hevc", { codec: ["-c:v", "libx265", "-x265-params", "log-level=none"], ext: "mkv" });
  assert.match(said(hevc), /Video: hevc/);
  const out = at("hevc-fit");
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", hevc, "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(said(path.join(out, "video.mp4")), /Video: hevc \(Main\) \(hvc1 \//);
  assert.deepEqual(packets(path.join(out, "video.mp4")), packets(hevc));
});

test("the video's own sound is read on its timeline: a sound that starts a second after the picture is a second late in video.mp4 too", async () => {
  const late = at("late.mp4");
  if (!fs.existsSync(late)) ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=160x96:r=25:d=12", "-itsoffset", "1", "-i", speech(), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "mpeg4", "-q:v", "6", "-c:a", "aac", "-t", "12", late]);
  const out = at("late-fit");
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", late, "--video-sound", "voice", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  // speech.wav speaks from 2 s: in this video, from 3 s.
  const spans = cuesOf(out).video.spans;
  assert.ok(Math.abs(spans[0].from - 3) < 0.15, JSON.stringify(spans));
});

test("a video's own sound is read on its timeline only up to two seconds past the end: a timestamp that jumps far on, as in a damaged file, is not filled with silence up to there, as the video's own sound or as the voice, and a sound that runs on past the picture is said to run more than a second past it, or by how much when it stops sooner", async () => {
  // 12 s of picture whose sound jumps 100 s on at 6 s.
  const jump = at("jump.mkv");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=160x96:r=25:d=12", "-i", effects(), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "mpeg4", "-q:v", "6", "-af", "asetpts=PTS+floor(T/6)*100/TB", "-c:a", "aac", "-b:a", "128k", jump]);
  const read = await decode(jump, { from: 0, most: 14 });
  assert.ok(read.length / 2 / RATE < 14.1, `${read.length / 2 / RATE} s`);
  for (const [name, args] of [
    ["jump-keep", ["--video", jump, "--video-sound", "keep"]],
    ["jump-voice", ["--video", jump, "--voice", jump]],
  ]) {
    const out = at(name);
    const run = cli([fixture("house").file, "--length", "12", "--hit", "8", ...args, "--out", out]);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(cuesOf(out).warnings.filter((w) => /past the end/.test(w)), [], name);
  }
  // A sound that runs on 10 s past its picture, and one half a second.
  for (const [extra, runs] of [[10, /^long-10\.mp4's own sound runs more than a second past the end and was cut there\.$/], [0.5, /^long-0\.5\.mp4's own sound runs 0\.5\d s past the end and was cut there\.$/]]) {
    const video = at(`long-${extra}.mp4`);
    ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=160x96:r=25:d=12", "-f", "lavfi", "-i", `anoisesrc=d=${12 + extra}:c=pink:a=0.05:r=48000`, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "mpeg4", "-q:v", "6", "-c:a", "aac", "-b:a", "128k", video]);
    const out = at(`long-${extra}-fit`);
    const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", video, "--video-sound", "keep", "--out", out]);
    assert.equal(run.status, 0, run.stderr);
    const said = cuesOf(out).warnings.filter((w) => /past the end/.test(w));
    assert.equal(said.length, 1, JSON.stringify(said));
    assert.match(said[0], runs);
  }
  // As the voice the video's own sound is read the same way, and a voice of
  // its own is read to its end, so its note says by how much.
  const voice = wav("voice-13", 13, (x) => x.forEach((_, i) => (x[i] = 0.1 * Math.sin((2 * Math.PI * 330 * i) / RATE))));
  for (const [name, args, runs] of [
    ["long-voice-same", ["--video", at("long-10.mp4"), "--voice", at("long-10.mp4")], "The voice runs more than a second past the end and was cut there."],
    ["long-voice-own", ["--voice", voice], "The voice runs 1.00 s past the end and was cut there."],
  ]) {
    const out = at(name);
    const run = cli([fixture("house").file, "--length", "12", "--hit", "8", ...args, "--out", out]);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(cuesOf(out).warnings.filter((w) => /past the end/.test(w)), [runs], name);
  }
  // The README and SKILL.md say where a voice is read to its end and where
  // only that far.
  assert.equal(require("../skills/musicfit/scripts/lib/video").PAST, 2);
  for (const doc of ["README.md", path.join("skills", "musicfit", "SKILL.md")]) {
    const text = fs.readFileSync(path.join(__dirname, "..", doc), "utf8");
    assert.ok(text.includes("a voice, which is read to its end even where it runs on past the fit, unless it is the video's own sound:"), doc);
    assert.ok(text.includes("The video's own sound, also when it is the voice, is read only up to two seconds past the fit."), doc);
  }
});

test("an AAC that lifts the true peak over -1 dBTP is limited again and encoded again", { skip: process.platform === "win32" ? "the stand-in is a shell script" : false }, () => {
  const state = at(`hotaac-${process.hrtime.bigint()}`);
  const out = at("hotaac-fit");
  const run = spawnSync(process.execPath, [CLI, fixture("house").file, "--length", "12", "--hit", "8", "--video", film("mute"), "--out", out], { encoding: "utf8", env: { ...process.env, FFMPEG_PATH: path.join(__dirname, "fixtures", "hotaac", "ffmpeg"), MUSICFIT_TEST_STATE: state } });
  assert.equal(run.status, 0, run.stderr);
  // The stand-in read the first AAC at -0.4 dBTP: a second one was made.
  assert.equal(fs.readFileSync(state, "utf8").trim().split("\n").length, 2);
  const c = cuesOf(out);
  assert.ok(c.video.loudness.truePeak <= -1, `true peak ${c.video.loudness.truePeak} dBTP`);
  assert.deepEqual(c.warnings.filter((w) => /AAC/.test(w)), []);
});

test("of AAC encodings whose true peaks come out higher and lower each time, the lowest is the one video.mp4 keeps", { skip: process.platform === "win32" ? "the stand-in is a shell script" : false }, () => {
  const state = at(`erratic-${process.hrtime.bigint()}`);
  const out = at("erratic-fit");
  const run = spawnSync(process.execPath, [CLI, fixture("house").file, "--length", "12", "--hit", "8", "--video", film("mute"), "--out", out], { encoding: "utf8", env: { ...process.env, FFMPEG_PATH: path.join(__dirname, "fixtures", "erraticaac", "ffmpeg"), MUSICFIT_TEST_STATE: state, MUSICFIT_TEST_PEAKS: "-0.5 0.4 -0.8 -0.2" } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.readFileSync(state, "utf8").trim(), "4");
  const c = cuesOf(out);
  assert.equal(c.video.loudness.truePeak, -0.8);
  assert.deepEqual(c.warnings.filter((w) => /AAC/.test(w)), ["After the AAC encoding the true peak of video.mp4 is -0.8 dBTP, over -1 dBTP."]);
  // video.mp4 holds the third encoding's packets.
  const kept = ffmpeg(["-i", path.join(out, "video.mp4"), "-map", "0:a", "-c", "copy", "-f", "framecrc", "pipe:1"]).stdout.split("\n").filter((l) => /^\d/.test(l));
  assert.deepEqual(kept, fs.readFileSync(`${state}.3`, "utf8").split("\n").filter((l) => /^\d/.test(l)));
  assert.notDeepEqual(kept, fs.readFileSync(`${state}.4`, "utf8").split("\n").filter((l) => /^\d/.test(l)));
});

test("a loud fit's video.mp4 keeps its true peak under -1 dBTP, as twoloop, ffmpeg 8's default AAC coder, did not", async () => {
  // At -10 LUFS this track came out at +1.3 dBTP with twoloop, 2.3 dB over
  // what it was held to, after four encodings.
  const out = at("loud-lofi");
  const run = cli([fixture("lofi").file, "--length", "12", "--video", film("mute"), "--lufs", "-10", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  const heard = await measureFile(path.join(out, "video.mp4"));
  assert.ok(heard.truePeak <= -1, `true peak ${heard.truePeak} dBTP`);
  assert.doesNotMatch(run.stdout, /true peak of video\.mp4 is/);
  // As loud as asked, or a note says how far short it stopped.
  const c = cuesOf(out);
  if (c.video.loudness.integrated < -10.5) assert.match(run.stdout, /Note {4}video\.mp4 is at -1\d\.\d LUFS after the AAC encoding, short of the -10 LUFS asked for/);
  assert.ok(c.video.loudness.integrated >= -11.5, `${c.video.loudness.integrated} LUFS`);
});

test("the sound of video.mp4 is encoded with ffmpeg's fast AAC coder on any ffmpeg, not with twoloop, ffmpeg 8's default, which lifts the true peak of a loud sound by 3 dB and more", { skip: process.platform === "win32" ? "the stand-in is a shell script" : false }, () => {
  const state = at(`args-${process.hrtime.bigint()}`);
  const run = spawnSync(process.execPath, [CLI, fixture("house").file, "--length", "12", "--hit", "8", "--video", film("film25", { sound: effects() }), "--video-sound", "keep", "--out", at("args-fit")], { encoding: "utf8", env: { ...process.env, FFMPEG_PATH: path.join(__dirname, "fixtures", "argslog", "ffmpeg"), MUSICFIT_TEST_STATE: state } });
  assert.equal(run.status, 0, run.stderr);
  const encodings = fs.readFileSync(state, "utf8").split("\n").filter((line) => / -c:a aac /.test(line));
  assert.ok(encodings.length >= 1, "no AAC was encoded");
  for (const line of encodings) assert.match(line, / -c:a aac -aac_coder fast -b:a 256k /);
});

test("an AAC encoding that came out quieter than the first lost its loudness to the limiting: the ceiling goes no lower, and video.mp4 keeps the loudness", { skip: process.platform === "win32" ? "the stand-in is a shell script" : false }, () => {
  const state = at(`quieter-${process.hrtime.bigint()}`);
  const out = at("quieter-fit");
  const run = spawnSync(process.execPath, [CLI, fixture("house").file, "--length", "12", "--hit", "8", "--video", film("mute"), "--out", out], { encoding: "utf8", env: { ...process.env, FFMPEG_PATH: path.join(__dirname, "fixtures", "erraticaac", "ffmpeg"), MUSICFIT_TEST_STATE: state, MUSICFIT_TEST_PEAKS: "-0.5 -1.4 -1.6 -1.8", MUSICFIT_TEST_LOUDNESS: "-14.0 -15.2 -16.0 -17.0" } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.readFileSync(state, "utf8").trim(), "2");
  const c = cuesOf(out);
  assert.deepEqual(c.video.loudness, { target: -14, integrated: -14, truePeak: -0.5 });
  assert.deepEqual(c.warnings.filter((w) => /AAC/.test(w)), ["After the AAC encoding the true peak of video.mp4 is -0.5 dBTP, over -1 dBTP."]);
  const kept = ffmpeg(["-i", path.join(out, "video.mp4"), "-map", "0:a", "-c", "copy", "-f", "framecrc", "pipe:1"]).stdout.split("\n").filter((l) => /^\d/.test(l));
  assert.deepEqual(kept, fs.readFileSync(`${state}.1`, "utf8").split("\n").filter((l) => /^\d/.test(l)));
});

test("a video.mp4 that stopped short of the loudness asked for says so, in the summary, in a note and in FIT.md", { skip: process.platform === "win32" ? "the stand-in is a shell script" : false }, () => {
  const out = at("short-fit");
  const run = spawnSync(process.execPath, [CLI, fixture("house").file, "--length", "12", "--hit", "8", "--video", film("mute"), "--out", out], { encoding: "utf8", env: { ...process.env, FFMPEG_PATH: path.join(__dirname, "fixtures", "erraticaac", "ffmpeg"), MUSICFIT_TEST_STATE: at(`short-${process.hrtime.bigint()}`), MUSICFIT_TEST_PEAKS: "-1.2", MUSICFIT_TEST_LOUDNESS: "-15.3" } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /\n {2}Video {3}video\.mp4 is mute\.mp4 with the music \(ffmpeg reads no sound of its own in it\); -15\.3 LUFS, true peak -1\.2 dBTP\n/);
  assert.match(run.stdout, /\n {2}Note {4}video\.mp4 is at -15\.3 LUFS after the AAC encoding, short of the -14 LUFS asked for: any louder and its true peaks would pass -1 dBTP\.\n/);
  const md = fs.readFileSync(path.join(out, "FIT.md"), "utf8");
  assert.match(md, /into `video\.mp4`, with the music \(ffmpeg reads no sound of its own in it\), the whole raised toward -14 LUFS but stopped at -15\.3 LUFS, measured after the AAC encoding: any louder and its true peaks would pass -1 dBTP\./);
  assert.doesNotMatch(md, /the whole set to -14 LUFS/);
  // Short of the target and over -1 dBTP: both said, and no peak given as
  // the reason it stopped.
  const over = at("short-over-fit");
  const hot = spawnSync(process.execPath, [CLI, fixture("house").file, "--length", "12", "--hit", "8", "--video", film("mute"), "--out", over], { encoding: "utf8", env: { ...process.env, FFMPEG_PATH: path.join(__dirname, "fixtures", "erraticaac", "ffmpeg"), MUSICFIT_TEST_STATE: at(`short-over-${process.hrtime.bigint()}`), MUSICFIT_TEST_PEAKS: "0.2 0.3 0.4 0.5", MUSICFIT_TEST_LOUDNESS: "-15.3 -15.3 -15.3 -15.3" } });
  assert.equal(hot.status, 0, hot.stderr);
  assert.match(hot.stdout, /\n {2}Note {4}After the AAC encoding the true peak of video\.mp4 is 0\.2 dBTP, over -1 dBTP\.\n {2}Note {4}video\.mp4 is at -15\.3 LUFS after the AAC encoding, short of the -14 LUFS asked for, with true peaks at 0\.2 dBTP\.\n/);
  const hotMd = fs.readFileSync(path.join(over, "FIT.md"), "utf8");
  assert.match(hotMd, /the whole raised toward -14 LUFS but stopped at -15\.3 LUFS with true peaks at 0\.2 dBTP, measured after the AAC encoding\./);
  assert.doesNotMatch(hotMd, /would pass -1 dBTP/);
  // Short of the target with true peaks well under -1 dBTP: there was room,
  // so the peaks are not the reason, and both numbers are said.
  const under = at("short-under-fit");
  const low = spawnSync(process.execPath, [CLI, fixture("house").file, "--length", "12", "--hit", "8", "--video", film("mute"), "--out", under], { encoding: "utf8", env: { ...process.env, FFMPEG_PATH: path.join(__dirname, "fixtures", "erraticaac", "ffmpeg"), MUSICFIT_TEST_STATE: at(`short-under-${process.hrtime.bigint()}`), MUSICFIT_TEST_PEAKS: "-3.9", MUSICFIT_TEST_LOUDNESS: "-15.3" } });
  assert.equal(low.status, 0, low.stderr);
  assert.match(low.stdout, /\n {2}Note {4}video\.mp4 is at -15\.3 LUFS after the AAC encoding, short of the -14 LUFS asked for, with true peaks at -3\.9 dBTP\.\n/);
  assert.doesNotMatch(low.stdout, /would pass -1 dBTP/);
  const lowMd = fs.readFileSync(path.join(under, "FIT.md"), "utf8");
  assert.match(lowMd, /the whole raised toward -14 LUFS but stopped at -15\.3 LUFS with true peaks at -3\.9 dBTP, measured after the AAC encoding\./);
  assert.doesNotMatch(lowMd, /would pass -1 dBTP/);
});

test("true peaks are the reason a loudness stopped short only at -1 dBTP or within half a dB under it", () => {
  const { heldAtCeiling } = require("../skills/musicfit/scripts/lib/report");
  for (const peak of [-1, -1.1, -1.5]) assert.equal(heldAtCeiling(peak), true, peak);
  for (const peak of [-0.9, 0.2, -1.6, -3.9, null]) assert.equal(heldAtCeiling(peak), false, peak);
});

// A fit under a film with sound effects kept, through the stand-in that reads
// the true peaks listed and the loudness each encoding really has.
function erraticKeep(name, peaks) {
  const state = at(`${name}-${process.hrtime.bigint()}`);
  const out = at(name);
  const run = spawnSync(process.execPath, [CLI, fixture("house").file, "--length", "12", "--hit", "8", "--video", film("film25", { sound: effects() }), "--video-sound", "keep", "--out", out], { encoding: "utf8", env: { ...process.env, FFMPEG_PATH: path.join(__dirname, "fixtures", "erraticaac", "ffmpeg"), MUSICFIT_TEST_STATE: state, MUSICFIT_TEST_PEAKS: peaks, MUSICFIT_TEST_LOUDNESS: "real" } });
  assert.equal(run.status, 0, run.stderr);
  const readings = fs.readFileSync(`${state}.loudness`, "utf8").trim().split("\n").map(Number);
  return { c: cuesOf(out), out, run, state, readings };
}

test("with keep, a peak the encoder lifted by chance costs the first encoding's excess and half a LU at most: the sound is not turned down by what one encoding overshot", { skip: process.platform === "win32" ? "the stand-in is a shell script" : false }, () => {
  // The first encoding is 0.3 dB over, the next 2.7 dB, the next under -1 dBTP.
  const { c, readings } = erraticKeep("erratic-keep", "-0.7 1.7 -1.2");
  assert.equal(readings.length, 3);
  assert.ok(readings[0] - readings[2] <= 0.3 + 0.5 + 0.15, `the three encodings read ${readings.join(", ")} LUFS`);
  assert.equal(c.video.loudness.truePeak, -1.2);
  assert.equal(c.video.loudness.integrated, readings[2]);
  assert.deepEqual(c.warnings.filter((w) => /over -1 dBTP/.test(w)), []);
});

test("with keep, when no encoding comes in at -1 dBTP or under, video.mp4 keeps the first, the loudest, and a note says it is over", { skip: process.platform === "win32" ? "the stand-in is a shell script" : false }, () => {
  const { c, out, state, readings } = erraticKeep("erratic-keep-over", "-0.7 1.7 0.9 -0.8");
  assert.equal(readings.length, 4);
  assert.equal(c.video.loudness.truePeak, -0.7);
  assert.equal(c.video.loudness.integrated, readings[0]);
  assert.deepEqual(c.warnings.filter((w) => /over -1 dBTP/.test(w)), ["After the AAC encoding the true peak of video.mp4 is -0.7 dBTP, over -1 dBTP."]);
  const kept = ffmpeg(["-i", path.join(out, "video.mp4"), "-map", "0:a", "-c", "copy", "-f", "framecrc", "pipe:1"]).stdout.split("\n").filter((l) => /^\d/.test(l));
  assert.deepEqual(kept, fs.readFileSync(`${state}.1`, "utf8").split("\n").filter((l) => /^\d/.test(l)));
});

// A film with two sound streams, as `sounds` (files) in order.
function filmSounds(name, sounds) {
  const file = at(`${name}.mp4`);
  if (!fs.existsSync(file)) ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=160x96:r=25:d=12", ...sounds.flatMap((s) => ["-i", s]), "-map", "0:v:0", ...sounds.flatMap((_, k) => ["-map", `${k + 1}:a:0`]), "-c:v", "mpeg4", "-q:v", "6", "-c:a", "aac", "-b:a", "128k", "-t", "12", file]);
  return file;
}

const silence = () => wav("silence", 12, () => {});

test("a video with more than one sound stream: sound in a later one under a silent first is refused with keep and voice too, drop goes on without it, and a run that goes on says only the first is read", () => {
  const { file } = fixture("house");
  const twoStreams = filmSounds("two-streams", [silence(), speech()]);
  // Nothing to hear in the first, a voice in the second: refused before any
  // work, as keep and voice would read only the silent first stream.
  const out = at("two-streams-fit");
  for (const how of [[], ["--video-sound", "keep"], ["--video-sound", "voice"]]) {
    const refused = cli([file, "--length", "12", "--video", twoStreams, ...how, "--out", out]);
    assert.equal(refused.status, 1, `${how}: ${refused.stderr}`);
    assert.match(refused.stderr, /musicfit: two-streams\.mp4 has 2 sound streams and musicfit reads only the first, which is silent or nearly so, while number 2 plays for \d+\.\d of its 12\.0 s: give --video a copy with that sound first, or --video-sound drop to go on without it\n$/);
    assert.ok(!fs.existsSync(out));
  }
  // Left out on purpose: no stream is read, so nothing is said of them.
  const dropped = cli([file, "--length", "12", "--video", twoStreams, "--video-sound", "drop", "--out", at("two-streams-drop")]);
  assert.equal(dropped.status, 0, dropped.stderr);
  assert.doesNotMatch(dropped.stdout, /sound streams/);
  // Sound in the first: asked as for any video, and with no sound in the
  // others none of them is refused for it.
  const firstSounds = filmSounds("first-sounds", [speech(), silence()]);
  const inFirst = cli([file, "--length", "12", "--video", firstSounds, "--out", at("first-sounds-fit")]);
  assert.equal(inFirst.status, 1);
  assert.match(inFirst.stderr, /first-sounds\.mp4 has sound of its own for \d+\.\d of its 12\.0 s, so say what becomes of it with --video-sound/);
  // The user chose: a note says what is not in video.mp4, in all three places.
  const note = "first-sounds.mp4 has 2 sound streams and only the first is read: what the others hold is not in video.mp4.";
  const kept = cli([file, "--length", "12", "--video", firstSounds, "--video-sound", "keep", "--out", out]);
  assert.equal(kept.status, 0, kept.stderr);
  assert.ok(kept.stdout.includes(`\n  Note    ${note}\n`), kept.stdout);
  assert.ok(cuesOf(out).warnings.includes(note));
  assert.ok(fs.readFileSync(path.join(out, "FIT.md"), "utf8").includes(`\n- ${note}\n`));
  // video.mp4 holds one sound stream, and its picture.
  const listed = spawnSync(FFMPEG, ["-hide_banner", "-nostdin", "-i", path.join(out, "video.mp4")], { encoding: "utf8" }).stderr;
  assert.equal(listed.match(/Stream #0:\d+.*: Audio: /g).length, 1);
  const quiet = cli([file, "--length", "12", "--video", filmSounds("all-silent", [silence(), silence()]), "--out", at("all-silent-fit")]);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.match(quiet.stdout, /Note {4}all-silent\.mp4 has 2 sound streams and only the first is read/);
});

test("subtitle streams, which video.mp4 does not hold, are named in a note, whatever becomes of the video's own sound", () => {
  const { file } = fixture("house");
  const words = at("words.srt");
  fs.writeFileSync(words, "1\n00:00:01,000 --> 00:00:03,000\nHello there\n\n2\n00:00:05,000 --> 00:00:07,000\nAnd again\n");
  const subtitled = (name, streams) => {
    const made = at(`${name}.mp4`);
    if (!fs.existsSync(made)) ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=160x96:r=25:d=12", ...Array(streams).fill(["-i", words]).flat(), "-map", "0:v:0", ...Array.from({ length: streams }, (_, k) => ["-map", `${k + 1}:s:0`]).flat(), "-c:v", "mpeg4", "-q:v", "6", "-c:s", "mov_text", "-t", "12", made]);
    return made;
  };
  const one = subtitled("subtitled", 1);
  const note = "subtitled.mp4 has a subtitle stream, which is not in video.mp4.";
  for (const how of [[], ["--video-sound", "drop"]]) {
    const out = at(`subtitled-fit-${how.length}`);
    const run = cli([file, "--length", "12", "--hit", "8", "--video", one, ...how, "--out", out]);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.stdout.includes(`\n  Note    ${note}\n`), run.stdout);
    assert.ok(cuesOf(out).warnings.includes(note));
    assert.ok(fs.readFileSync(path.join(out, "FIT.md"), "utf8").includes(`\n- ${note}\n`));
    assert.doesNotMatch(said(path.join(out, "video.mp4")), /: Subtitle: /);
  }
  const two = cli([file, "--length", "12", "--hit", "8", "--video", subtitled("subtitled-twice", 2), "--out", at("subtitled-twice-fit")]);
  assert.equal(two.status, 0, two.stderr);
  assert.ok(two.stdout.includes("\n  Note    subtitled-twice.mp4 has 2 subtitle streams, which are not in video.mp4.\n"), two.stdout);
  // A video with none has nothing to say about them.
  assert.doesNotMatch(cli([file, "--length", "12", "--hit", "8", "--video", film("mute"), "--out", at("no-words-fit")]).stdout, /subtitle/);
});

test("the run's own files are read by their names from their own folder, so an out folder with a % in its name, which the hosted ffmpeg refuses as an input, ends well; a relative FFMPEG_PATH still finds that ffmpeg", { skip: process.platform === "win32" ? "the stand-in is a shell script" : false }, async () => {
  const { file } = fixture("house");
  const repo = path.resolve(__dirname, "..");
  // There already, so the run's hidden folder is inside it.
  const out = at("yüzde 100% fit");
  fs.mkdirSync(out);
  const run = spawnSync(process.execPath, [CLI, file, "--length", "12", "--hit", "8", "--video", film("mute"), "--out", out], { cwd: repo, encoding: "utf8", env: { ...process.env, FFMPEG_PATH: path.join("test", "fixtures", "nopercent", "ffmpeg") } });
  assert.equal(run.status, 0, run.stderr);
  const heard = await measureFile(path.join(out, "video.mp4"));
  assert.ok(Number.isFinite(heard.integrated), "video.mp4 has no sound");
});

// A stand-in for ffmpeg in `folder`, which runs the real one.
function standIn(folder) {
  const real = process.env.FFMPEG_PATH ? path.resolve(process.env.FFMPEG_PATH) : spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "ffmpeg"), `#!/bin/sh\nexec "${real}" "$@"\n`, { mode: 0o755 });
}

// A folder whose X/link leads to Y/real, so that X/link/../bin is Y/bin to
// the system, where the stand-in for ffmpeg is, and by its letters X/bin,
// which is not there.
function throughLink(name) {
  const root = at(name);
  fs.mkdirSync(path.join(root, "X"), { recursive: true });
  fs.mkdirSync(path.join(root, "Y", "real"), { recursive: true });
  fs.symlinkSync(path.join("..", "Y", "real"), path.join(root, "X", "link"));
  standIn(path.join(root, "Y", "bin"));
  return root;
}

test("an ffmpeg found through a relative entry of PATH is found by every call, also those that run in the out folder", { skip: process.platform === "win32" ? "the stand-in is a shell script" : false }, () => {
  const { file } = fixture("house");
  // A folder PATH names from where musicfit starts.
  standIn(at("relative-bin"));
  const { FFMPEG_PATH, ...rest } = process.env;
  const run = spawnSync(process.execPath, [CLI, file, "--length", "12", "--hit", "8", "--video", film("mute"), "--out", at("relative-path-fit")], { cwd: dir, encoding: "utf8", env: { ...rest, PATH: `no-such-folder${path.delimiter}relative-bin` } });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(fs.existsSync(at("relative-path-fit/video.mp4")));
});

test("an entry of PATH that goes through a link and up again keeps naming its folder for the calls that run in the out folder, absolute or relative", { skip: process.platform === "win32" ? "the stand-in is a shell script" : false }, () => {
  const { file } = fixture("house");
  const root = throughLink("path-through-link");
  const { FFMPEG_PATH, ...rest } = process.env;
  for (const [kind, entry] of [["absolute", `${root}/X/link/../bin`], ["relative", "X/link/../bin"]]) {
    const out = at(`path-through-link-${kind}`);
    const run = spawnSync(process.execPath, [CLI, file, "--length", "12", "--hit", "8", "--video", film("mute"), "--out", out], { cwd: root, encoding: "utf8", env: { ...rest, PATH: entry } });
    assert.equal(run.status, 0, `${kind}: ${run.stderr}`);
    assert.ok(fs.existsSync(path.join(out, "video.mp4")), kind);
  }
});

test("off Windows a variable named path before PATH changes nothing, as the system reads only PATH", { skip: process.platform === "win32" ? "Windows has one variable for both names" : false }, () => {
  const { file } = fixture("house");
  standIn(at("lower-path-bin"));
  const { FFMPEG_PATH, PATH, ...rest } = process.env;
  const run = spawnSync(process.execPath, [CLI, file, "--length", "12", "--hit", "8", "--video", film("mute"), "--out", at("lower-path-fit")], { cwd: dir, encoding: "utf8", env: { path: "/no-such-folder", ...rest, PATH: "lower-path-bin" } });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(fs.existsSync(at("lower-path-fit/video.mp4")));
});

test("a call run in another folder gets PATH with each relative entry put after the folder musicfit started in, and every absolute one as it was", { skip: process.platform === "win32" ? "this reads the POSIX rules" : false }, () => {
  const { fromHere } = require("../skills/musicfit/scripts/lib/audio");
  const here = process.cwd();
  const saved = process.env.PATH;
  try {
    process.env.PATH = `/opt/link/../bin::rel:./dot:a/link/../up:"/quoted"`;
    assert.equal(fromHere().PATH, `/opt/link/../bin:${here}:${here}/rel:${here}/dot:${here}/a/link/../up:${here}/"/quoted"`);
    delete process.env.PATH;
    assert.equal(fromHere(), process.env, "no PATH is no PATH");
  } finally {
    process.env.PATH = saved;
  }
});

test("on Windows a PATH entry in quotes is read without them, one with a ; inside them stays whole, an empty one is passed over, and the variable is found in any case", () => {
  const { fromHere } = require("../skills/musicfit/scripts/lib/audio");
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const saved = process.env.PATH;
  const left = [`"C:\\Program Files\\ffmpeg\\bin"`, "D:\\tools", "", `'E:\\a;b'`, `"F:\\c;d"`, "\\\\server\\share\\bin"];
  try {
    delete process.env.PATH;
    process.env.Path = [...left, "rel", `"in quotes"`].join(";");
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    assert.equal(fromHere().Path, [...left, path.resolve("rel"), path.resolve("in quotes")].join(";"));
    delete process.env.Path;
    assert.equal(fromHere(), process.env, "no PATH is no PATH");
  } finally {
    Object.defineProperty(process, "platform", platform);
    delete process.env.Path;
    process.env.PATH = saved;
  }
});

test("FFMPEG_PATH, a track, a voice and a video named through a link and up again are found where the system finds them", { skip: process.platform === "win32" ? "the stand-in is a shell script" : false }, () => {
  const root = throughLink("named-through-link");
  fs.copyFileSync(fixture("house").file, path.join(root, "Y", "track.wav"));
  fs.copyFileSync(speech(), path.join(root, "Y", "voice.wav"));
  fs.copyFileSync(film("mute"), path.join(root, "Y", "film.mp4"));
  const { FFMPEG_PATH, ...rest } = process.env;
  for (const [kind, up] of [["relative", "X/link/.."], ["absolute", `${root}/X/link/..`]]) {
    const out = at(`named-through-link-${kind}`);
    const run = spawnSync(process.execPath, [CLI, `${up}/track.wav`, "--length", "12", "--hit", "8", "--voice", `${up}/voice.wav`, "--video", `${up}/film.mp4`, "--out", out], { cwd: root, encoding: "utf8", env: { ...rest, FFMPEG_PATH: `${up}/bin/ffmpeg` } });
    assert.equal(run.status, 0, `${kind}: ${run.stderr}`);
    assert.ok(fs.existsSync(path.join(out, "video.mp4")), kind);
  }
});

test("FIT.md says what plays under the picture in plain words, and never that the loudness stopped short when the music only dips", () => {
  const { fitMarkdown, underVideo } = require("../skills/musicfit/scripts/lib/report");
  const base = {
    length: 12, frames: 300, fps: 25, mix: null, tempo: null, drop: null, seams: [], segments: [{ from: 0, to: 12, source: [0, 12], sourceBars: null }],
    start: { kind: "top", firstBar: null, fadeIn: 0 }, end: { kind: "fade", time: 12, frame: 300, finalHit: null, fade: { from: 11, to: 12, fromFrame: 275, toFrame: 300, onBeat: false } },
    mode: "energy", warnings: [], loudness: { target: -14, integrated: -24, truePeak: -6.9, range: 3, limited: true },
  };
  const video = (fields) => ({ file: "video.mp4", source: "talk.mp4", length: 12, fps: 25, frames: 300, steady: true, picture: "h264", same: null, spans: [{ from: 2, to: 5, over: null }], loudness: { target: -14, integrated: -14, truePeak: -1.2 }, ...fields });
  const voice = { file: "vo.wav", duck: 10, spans: [{ from: 6, to: 8 }] };
  // keep: every place 3 dB over the music, one of two, none, and no music under any.
  const heard = [{ from: 2, to: 5, over: 3.1 }, { from: 7, to: 8, over: 12.4 }];
  const held = [{ from: 2, to: 5, over: 3.1 }, { from: 7, to: 8, over: -1.2 }];
  const keep = (spans) => video({ sound: "keep", duck: null, over: 3, spans });
  const words = (spans) => underVideo({ ...base, voice: null, video: keep(spans) });
  assert.equal(words(heard), "the music and its own sound, that sound about 3 dB or more louder than the music where it plays (2 places)");
  assert.equal(words(held), "the music and its own sound, that sound about 3 dB or more louder than the music in 1 of the 2 places it plays");
  assert.equal(words([held[1]]), "the music and its own sound, that sound less than 3 dB louder than the music where it plays (1 place)");
  assert.equal(words([{ from: 2, to: 5, over: null }]), "the music and its own sound, that sound set to -14 LUFS where it plays, as no music plays there");
  const cases = [
    { video: keep(heard) },
    { video: keep(held) },
    { video: keep([{ from: 2, to: 5, over: null }]) },
    { video: video({ sound: "keep", duck: null, over: null, spans: [] }) },
    { video: keep(held), voice },
    { video: video({ sound: "voice", duck: 10 }) },
    { video: video({ sound: "voice", duck: 10, spans: [] }) },
    { video: video({ sound: "voice", duck: 10 }), voice },
    { video: video({ sound: "drop", duck: null, spans: [] }) },
    { video: video({ sound: "drop", duck: null, spans: [] }), voice },
    { video: video({ sound: "none", duck: null, spans: [] }) },
    { video: video({ sound: "drop", same: "track", duck: null, spans: [] }) },
    { video: video({ sound: "drop", same: "voice", duck: null, spans: [] }), voice },
  ];
  for (const fields of cases) {
    const c = { ...base, voice: null, ...fields };
    const md = fitMarkdown(c, { trackName: "house.wav" });
    const words = underVideo(c);
    const label = `${c.video.sound}${c.video.same ? `/${c.video.same}` : ""}${c.voice ? " with a voice" : ""}${c.video.spans.length ? "" : " and no spans"}`;
    assert.ok(md.includes(`\`video.mp4\` is talk.mp4 with ${words}: its picture as it was`), label);
    assert.ok(md.includes(`into \`video.mp4\`, with ${words}, the whole set to -14 LUFS`), label);
    assert.doesNotMatch(md, /\b(\w+ \w+) \1\b/, label);
    const dips = Boolean(c.voice) || (c.video.duck !== null && c.video.spans.length > 0);
    // -24 LUFS is the music as a whole with its dips, not a loudness the limiter stopped at.
    if (dips) assert.doesNotMatch(md, /stopped at/, label);
    if (dips) assert.match(md, /at -24 LUFS as a whole, dips included, with true peaks/, label);
    // With keep the music does not dip under the video's own sound.
    if (c.video.sound === "keep" && !c.voice) assert.doesNotMatch(md, /dip/, label);
  }
  const stopped = (truePeak) => fitMarkdown({ ...base, voice: null, video: null, loudness: { ...base.loudness, integrated: -15.3, truePeak } }, { trackName: "house.wav" });
  assert.match(stopped(-1.2), /Loudness raised toward -14 LUFS but stopped at -15\.3 LUFS, with a limiter holding the true peaks at -1\.2 dBTP: any louder and the peaks would pass -1 dBTP\./);
  // A true peak the limiter did not hold under -1 dBTP, or one well under
  // it with room to spare, is no reason it stopped.
  for (const peak of [0.4, -6.9]) {
    assert.ok(stopped(peak).includes(`Loudness raised toward -14 LUFS but stopped at -15.3 LUFS, with a limiter holding the true peaks at ${peak} dBTP.`), String(peak));
    assert.doesNotMatch(stopped(peak), /would pass -1 dBTP/);
  }
});

test("with --video-sound voice and no voice, FIT.md says the loudness was set where the video's own sound does not play", () => {
  const out = at("talk-voice");
  if (!fs.existsSync(path.join(out, "FIT.md"))) assert.equal(cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", film("talk", { sound: speech() }), "--video-sound", "voice", "--out", out]).status, 0);
  const md = fs.readFileSync(path.join(out, "FIT.md"), "utf8");
  assert.doesNotMatch(md, /stopped at/);
  assert.match(md, /Loudness set to -14 LUFS where talk\.mp4's own sound does not play/);
  assert.match(md, /with its own sound set to -14 LUFS where it plays, the music dipping 10 dB under it, the whole set to -14 LUFS/);
});

test("a track, a voice and a video named like 16:9 mix.wav or 9:16.mp4 are read as the files they are, not as a protocol", { skip: process.platform === "win32" ? "Windows names take no colon" : false }, () => {
  const cwd = at("colons");
  fs.mkdirSync(cwd, { recursive: true });
  fs.copyFileSync(fixture("house").file, path.join(cwd, "16:9 mix.wav"));
  fs.copyFileSync(speech(), path.join(cwd, "vo:take 2.wav"));
  fs.copyFileSync(film("film25", { sound: effects() }), path.join(cwd, "9:16.mp4"));
  const run = spawnSync(process.execPath, [CLI, "16:9 mix.wav", "--length", "12", "--hit", "8", "--voice", "vo:take 2.wav", "--video", "9:16.mp4", "--video-sound", "keep", "--out", "fit"], { cwd, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(fs.readdirSync(path.join(cwd, "fit")).sort(), ["FIT.md", "cues.json", "fitted.wav", "mix.wav", "seams.png", "video.mp4"]);
  assert.deepEqual(packets(path.join(cwd, "fit", "video.mp4")), packets(path.join(cwd, "9:16.mp4")));
});

test("a video or an out folder whose name holds a line of ffmpeg's words for a file it could not finish is not taken for one", { skip: process.platform === "win32" ? "Windows names take no line break" : false }, () => {
  const cwd = at("trailer-names");
  fs.mkdirSync(cwd, { recursive: true });
  const odd = "odd\nError writing trailer";
  fs.copyFileSync(film("film25", { sound: effects() }), path.join(cwd, `${odd}.mp4`));
  // The out folder is there already, so the run's own files are read in it.
  fs.mkdirSync(path.join(cwd, odd));
  const run = spawnSync(process.execPath, [CLI, fixture("house").file, "--length", "12", "--hit", "8", "--video", `${odd}.mp4`, "--video-sound", "keep", "--out", odd], { cwd, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(fs.readdirSync(path.join(cwd, odd)).sort(), ["FIT.md", "cues.json", "fitted.wav", "seams.png", "video.mp4"]);
});

test("a whole video whose name or tags hold the words ffmpeg prints for a damaged file is not taken for a damaged one", async () => {
  const { probe } = require("../skills/musicfit/scripts/lib/video");
  const named = at("partial file.mp4");
  fs.copyFileSync(film("mute"), named);
  const tagged = at("tagged.mp4");
  ffmpeg(["-i", film("mute"), "-c", "copy", "-metadata", "title=Packet corrupt input packet in stream 0", "-metadata", "comment=File ended prematurely", tagged]);
  // ffmpeg prints the tags again under the output it writes.
  const titled = at("titled.mp4");
  ffmpeg(["-i", film("mute"), "-c", "copy", "-metadata", "title=corrupt input packet in stream 0", "-metadata", "comment=A note that ends in: corrupt input packet in stream 0", "-metadata:s:v:0", "handler_name=x: corrupt input packet in stream 0", titled]);
  for (const file of [named, tagged, titled]) {
    const info = await probe(file);
    assert.deepEqual([info.seconds, info.frames], [12, 300], file);
  }
  const run = cli([fixture("house").file, "--length", "12", "--video", named, "--out", at("partial-file-fit")]);
  assert.equal(run.status, 0, run.stderr);
});

test("a picture that starts after the top of its file, as in a fragmented MP4 with B-frames, is measured from its first frame, and in video.mp4 it starts with the sound", async () => {
  const { probe } = require("../skills/musicfit/scripts/lib/video");
  // mpeg4 with B-frames, written in fragments with no edit list: the
  // picture starts a frame after the sound.
  const frag = film("frag-bframes", { sound: effects(), codec: ["-c:v", "mpeg4", "-q:v", "6", "-bf", "2", "-movflags", "frag_keyframe+empty_moov"] });
  const info = await probe(frag);
  assert.ok(info.start > 0.03, `the picture starts at ${info.start} s`);
  assert.deepEqual([info.seconds, info.frames, info.fps], [12, 300, 25]);
  for (const length of ["12", "300f"]) {
    const out = at(`frag-fit-${length}`);
    const run = cli([fixture("house").file, "--length", length, "--hit", "8", "--video", frag, "--video-sound", "keep", "--out", out]);
    assert.equal(run.status, 0, run.stderr);
    const c = cuesOf(out);
    assert.deepEqual([c.frames, c.video.frames, c.video.length], [300, 300, 12]);
    // Its own sound is read from the first frame: the effect at 2 s of the
    // file plays a frame earlier on the picture.
    assert.ok(Math.abs(c.video.spans[0].from - (2 - info.start)) < 0.05, JSON.stringify(c.video.spans));
    assert.deepEqual(packets(path.join(out, "video.mp4")), packets(frag));
    // In video.mp4 the first frame is at 0, and the sound lines up with it.
    const made = await probe(path.join(out, "video.mp4"));
    assert.ok(Math.abs(made.start) < 0.001, `video.mp4's picture starts at ${made.start} s`);
    const music = mono(await decode(path.join(out, "fitted.wav")));
    const under = mono(await decode(path.join(out, "video.mp4"), { from: made.start }));
    assert.ok(Math.abs(lag(music, under, 4, 6)) <= 96, `video.mp4's sound is ${lag(music, under, 4, 6)} samples off`);
  }
});

test("an MPEG-TS whose sound starts before its picture keeps that sound where it was against the picture", () => {
  const ts = at("early.ts");
  if (!fs.existsSync(ts)) ffmpeg(["-itsoffset", "0.5", "-f", "lavfi", "-i", "testsrc2=s=160x96:r=25:d=12", "-i", speech(), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "mpeg4", "-q:v", "6", "-c:a", "aac", ts]);
  const out = at("early-ts-fit");
  const run = cli([fixture("house").file, "--length", "12", "--hit", "8", "--video", ts, "--video-sound", "voice", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  const c = cuesOf(out);
  assert.equal(c.video.length, 12);
  // speech.wav speaks from 2 s, and its sound comes about half a second
  // before the picture: about 1.5 s into the picture.
  assert.ok(Math.abs(c.video.spans[0].from - 1.5) < 0.12, JSON.stringify(c.video.spans));
});

test("a video cut without encoding again, whose first shown frame needs frames from before the cut, is read from that frame, and video.mp4 shows it at 0", async () => {
  const { probe } = require("../skills/musicfit/scripts/lib/video");
  const whole = film("gop16", { seconds: 16, codec: ["-c:v", "mpeg4", "-q:v", "6", "-g", "50", "-bf", "2"] });
  const cut = at("gop-cut.mp4");
  ffmpeg(["-ss", "1.5", "-i", whole, "-t", "12", "-c", "copy", cut]);
  const info = await probe(cut);
  // The frames before the cut are in the file, flagged so no player shows them.
  const all = ffmpeg(["-i", cut, "-map", "0:V:0", "-c", "copy", "-f", "framecrc", "pipe:1"]).stdout.split("\n").filter((l) => /^\d/.test(l)).length;
  assert.ok(info.frames < all, `${info.frames} of ${all} packets counted`);
  assert.ok(Math.abs(info.start) < 0.001, `the picture starts at ${info.start} s`);
  const out = at("gop-cut-fit");
  const run = cli([fixture("house").file, "--length", String(Number(info.seconds.toFixed(3))), "--video", cut, "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  const made = await probe(path.join(out, "video.mp4"));
  assert.ok(Math.abs(made.start) < 0.001, `video.mp4's first shown frame is at ${made.start} s`);
  const first = (file) => ffmpeg(["-i", file, "-map", "0:v:0", "-frames:v", "1", "-f", "framemd5", "pipe:1"]).stdout.split("\n").find((l) => /^\d/.test(l)).split(",").pop().trim();
  assert.equal(first(path.join(out, "video.mp4")), first(cut));
});
