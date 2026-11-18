"use strict";

// --video: what the video holds, read before any work; its own sound on its
// timeline; and the fitted sound laid under its picture, which is copied
// packet for packet and never encoded again. Every call goes through the
// same ffmpeg (FFMPEG_PATH), and none needs ffprobe.
//
// The video is read on its own timestamps (-copyts), the same in every
// call: ffmpeg would otherwise start each call's streams at 0 by its own
// rule, which in an MPEG-TS or a fragmented MP4 moves the picture against
// the sound. Everything here counts from the picture's first frame, and in
// video.mp4 that frame and the sound both start at 0.

const fs = require("node:fs");
const path = require("node:path");
const { RATE, run, decode, gone, where } = require("./audio");
const { blocks } = require("./breathe");

const num = (x, digits) => String(Number(x.toFixed(digits)));

// A frame rate as people write it: 25, 29.97, 23.976.
const fpsText = (fps) => num(fps, 3);

// The usual frame rates. A steady rate read from a timebase in whole
// milliseconds comes out a hair off (29.969 for 29.97, 29.999 for 30):
// within a tenth of a percent of one of these, it is the nearest of them.
const RATES = [24000 / 1001, 24, 25, 30000 / 1001, 30, 48000 / 1001, 48, 50, 60000 / 1001, 60, 100, 120000 / 1001, 120, 144, 240];
function nominal(fps) {
  const near = RATES.filter((rate) => Math.abs(fps - rate) < rate * 0.001).sort((a, b) => Math.abs(fps - a) - Math.abs(fps - b));
  return near.length ? near[0] : fps;
}

// The comment musicfit writes in video.mp4, so a video it made is known
// when it is given back as --video. It names no file: the video goes out
// to people, and the names of the files it was made from are the user's.
const mark = (version) => `musicfit ${version}: a fitted track laid under this picture`;
const MARK = /^musicfit \S+: a fitted track laid under this picture$/;

// What ffmpeg prints while it reads a file that is cut short or has a
// broken packet: a packet cut off at the end, an MP4's samples past the end
// of the file, a Matroska or WebM file that stops in the middle. Only its
// own lines are read for these, never the file's name or its tags (see
// probe()).
const DAMAGED = [
  /^\[[^\]\n]+\] (?:Packet corrupt\b|File ended prematurely\b|stream \d+, offset 0x[0-9a-f]+: partial file\b|corrupt input packet in stream \d+)/m,
  // ffmpeg 4.4 starts this one with the file's name.
  /: corrupt input packet in stream \d+\s*$/m,
];

// What ffmpeg says of the input: its lines from "Input #0" up to the first
// output.
function inputSection(said) {
  const from = Math.max(0, said.indexOf("Input #0"));
  const rest = said.slice(from);
  const to = rest.search(/^(Output #0|Stream mapping:)/m);
  return to < 0 ? rest : rest.slice(0, to);
}

// What ffmpeg's mov demuxer, which reads MP4, MOV, M4A, 3GP and their kin,
// says of a file with no whole index: none found, or one that stops part
// way. Only ffmpeg's own lines are read for these, which start at the left
// edge with what logs them in brackets, never a file's name.
const NO_MOOV = /^\[[^\]\n]+\] moov atom not found\r?$/m;
const NO_HEADER = /^\[[^\]\n]+\] error reading header\r?$/m;

// The kinds of box ffmpeg takes a file for an MP4, a MOV or one of their kin
// by when it guesses what a file is.
const MP4_BOXES = new Set(["ftyp", "moov", "mdat", "pnot", "udta", "wide", "ediw", "free", "junk", "pict", "skip", "uuid", "prfl"]);

// Whether a file starts as an MP4 or a MOV does: past any ID3v2 tags, which
// ffmpeg passes over when it guesses a format, a run of boxes, each its size
// in 4 bytes and its kind in 4, with a kind of MP4_BOXES among them in its
// first MiB. "error reading header" is no proof of one, as other demuxers
// may say it too. FFmpeg 4.4 to 8 name the demuxer that says it, as
// "[mov,mp4,m4a,3gp,3g2,mj2 @ 0x...]", but FFmpeg 9 names every demuxer
// "[in#0 @ 0x...]" while it opens a file, so its words no longer tell. The
// file's own first bytes, which tell ffmpeg what it is, tell it the same on
// every version.
function mp4Like(file) {
  let fd;
  try {
    fd = fs.openSync(where(file), "r");
    const head = Buffer.alloc(1 << 20);
    const got = fs.readSync(fd, head, 0, head.length, 0);
    let at = 0;
    // An ID3v2 tag: "ID3", its version in 2 bytes, neither of them 0xff, its
    // flags in 1, its size in 4 bytes of 7 bits each, and 10 bytes more when
    // its flags give it a footer.
    const tag = (i) => head.toString("latin1", i, i + 3) === "ID3" && head[i + 3] !== 0xff && head[i + 4] !== 0xff && [6, 7, 8, 9].every((k) => head[i + k] < 0x80);
    while (at + 10 <= got && tag(at)) at += 10 + ((head[at + 6] << 21) | (head[at + 7] << 14) | (head[at + 8] << 7) | head[at + 9]) + (head[at + 5] & 0x10 ? 10 : 0);
    while (at + 8 <= got) {
      if (MP4_BOXES.has(head.toString("latin1", at + 4, at + 8))) return true;
      const size = head.readUInt32BE(at);
      if (size < 8) return false;
      at += size;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Whether ffmpeg, on a file with no picture, lists no stream it could tell
// anything of. A file that stops early in its index lists none at all, or
// one it knows nothing about, not even a kind: "Data: none".
function noStreams(said) {
  const streams = inputSection(said)
    .split("\n")
    .filter((line) => /^\s*Stream #0:\d+/.test(line));
  return streams.every((line) => /: Data: none(?: \(default\))?\s*$/.test(line));
}

// The video's picture as its packets give it: how long it is, its frames,
// its frame rate and whether that holds steady, the codec of its picture
// and of its first sound stream, how many sound and subtitle streams it has,
// and whether musicfit made it. One frame is copied into
// an MP4 too, into a pipe, to see that an MP4 holds the picture as it is.
// Refused with the reason when the video cannot be read, is cut short or
// damaged, has no picture or a still one, or holds a picture an MP4 cannot
// take without encoding it again.
async function probe(file) {
  const name = path.basename(file);
  const size = (fs.statSync(file, { throwIfNoEntry: false }) || {}).size;
  if (size === 0) throw new Error(`Cannot read ${file}: it is empty`);
  const cutShort = (what) => new Error(`Cannot read ${file}: it is cut short or damaged, so ffmpeg finds no ${what} in it`);
  let crc;
  let said;
  try {
    const { chunks, stderr } = await run(["-v", "info", "-nostats", "-copyts", "-i", where(file), "-map", "0:V:0", "-c", "copy", "-f", "framecrc", "pipe:1"]);
    crc = Buffer.concat(chunks).toString("utf8");
    said = stderr;
  } catch (err) {
    if (err.unstarted) throw err;
    const why = err.stderr || err.message;
    if (/No such file|does not exist/.test(why) && gone(file)) throw new Error(`Cannot read ${file}: no such file`);
    // An MP4 or a MOV that stops before its index or inside it, as one whose
    // recording or download was cut off; a file ffmpeg only guessed was one
    // is not, nor, where ffmpeg's words may be another demuxer's, one that
    // does not start as one (see mp4Like()). Read without the file's name,
    // which may hold a line of such words.
    const own = why.split(where(file)).join("");
    if (!/detected only with low score/.test(own) && (NO_MOOV.test(own) || (NO_HEADER.test(own) && mp4Like(file)))) throw cutShort("index");
    if (/Invalid data found/.test(why) || NO_MOOV.test(own)) throw new Error(`Cannot read ${file}: ffmpeg does not know this format`);
    if (/matches no streams/.test(why)) throw noStreams(why) ? cutShort("streams") : new Error(`${name} has no picture to lay the music under`);
    // A picture ffmpeg 4.4 will not even start to copy, as nothing is known
    // of it yet where the index stops; ffmpeg 8 copies none of its frames.
    if (/^\s*Stream #0:\d+.*: Video: none, none/m.test(inputSection(why))) throw cutShort("frames");
    throw err;
  }

  const input = inputSection(said);
  const lines = input.split("\n");
  const pictureLine = lines.find((l) => /^\s*Stream #0:\d+.*: Video: /.test(l) && !/\(attached pic\)/.test(l)) || "";
  const soundLines = lines.filter((l) => /^\s*Stream #0:\d+.*: Audio: /.test(l));
  const subtitleLines = lines.filter((l) => /^\s*Stream #0:\d+.*: Subtitle: /.test(l));
  const format = (/Input #0, ([^,\s]+)/.exec(input) || [])[1] || "";
  // The file's own tags come before its duration; the streams' after.
  const head = input.slice(0, Math.max(0, input.search(/^\s*Duration:/m)));
  const comment = (/^\s*comment\s*:\s?(.*)$/im.exec(head) || [])[1] || "";

  // framecrc lists each packet as: stream, dts, pts, duration, size, crc,
  // and its flags when they are more than a key frame's. A packet flagged
  // to be dropped (0x4) is never shown: an MP4 cut without encoding again
  // keeps the frames before the cut that its first shown frame needs, and
  // an edit list hides them.
  const tb = /^#tb 0: (\d+)\/(\d+)/m.exec(crc);
  const unit = tb ? Number(tb[1]) / Number(tb[2]) : 0;
  let frames = 0;
  const packets = [];
  for (const line of crc.split("\n")) {
    if (!/^\d/.test(line)) continue;
    const fields = line.split(",").map((s) => s.trim());
    const flags = fields.map((f) => /^F=0x([0-9a-f]+)$/i.exec(f)).find(Boolean);
    if (flags && parseInt(flags[1], 16) & 4) continue;
    frames++;
    const [, dts, pts, duration] = fields.map(Number);
    const at = pts > -1e15 ? pts : dts > -1e15 ? dts : NaN;
    if (Number.isFinite(at)) packets.push({ at, duration });
  }
  // The step from frame to frame: the middle one of the gaps between their
  // times, else of their durations.
  const times = packets.map((p) => p.at).sort((a, b) => a - b);
  const gaps = times.slice(1).map((t, i) => t - times[i]).filter((d) => d > 0);
  const durations = packets.map((p) => p.duration).filter((d) => d > 0);
  const middle = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
  const step = gaps.length ? middle(gaps) : durations.length ? middle(durations) : 0;
  let first = Infinity;
  let last = -Infinity;
  for (const p of packets) {
    first = Math.min(first, p.at);
    last = Math.max(last, p.at + (p.duration > 0 ? p.duration : step));
  }
  // Where the picture starts on the video's timeline, and how long it is
  // from its first frame.
  const start = Number.isFinite(first) ? first * unit : 0;
  const seconds = Number.isFinite(last) ? (last - first) * unit : 0;
  // What ffmpeg itself said as it read the packets. Its own lines start at
  // the left edge; the tags it prints of the file, under the input and again
  // under the output, are indented, and the header that names the file is
  // left out.
  const reading = (said.includes("Input #0") ? said.replace(input, "") : said)
    .split("\n")
    .filter((line) => !/^\s/.test(line))
    .join("\n");
  if (DAMAGED.some((line) => line.test(reading))) {
    const d = /^\s*Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)/m.exec(input);
    const whole = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0;
    throw new Error(`Cannot read ${file}: it is cut short or damaged (ffmpeg could read ${frames} ${frames === 1 ? "frame" : "frames"}, ${seconds.toFixed(2)} s${whole > seconds + 0.05 ? ` of the ${whole.toFixed(2)} s it says it holds` : ""})`);
  }
  // A still picture has its one frame; an index cut short can list a picture
  // with no frame of it.
  if (!frames) throw cutShort("frames");
  if (frames <= 1 || /^(image2|image2pipe|\w+_pipe)$/.test(format) || !(seconds > 0) || !step) throw new Error(`${name} is a still picture, not a video`);
  // The rate holds steady when every gap is a whole number of steps, give
  // or take a tick of the timebase or a millisecond (a 29.97 fps video in a
  // millisecond timebase steps 33 and 34, and keeps those steps when it is
  // copied into a finer one). A gap of two steps or more is frames left
  // out, the one before it shown for longer: a recording that dropped
  // frames, or a cut made without encoding again that keeps a frame from
  // after the cut. Its frames still count at the rate, empty places
  // included. A step is measured as the mean of the gaps of one step.
  const tolerance = Math.max(1, step * 0.01, 0.0011 / unit);
  const single = gaps.filter((g) => Math.abs(g - step) <= tolerance);
  const period = single.length ? single.reduce((sum, g) => sum + g, 0) / single.length : step;
  const steps = gaps.map((g) => Math.round(g / period));
  const constant = gaps.every((g, i) => steps[i] >= 1 && Math.abs(g - steps[i] * period) <= tolerance);
  const places = steps.reduce((sum, k) => sum + k, 0);

  try {
    await run(["-v", "error", "-i", where(file), "-map", "0:V:0", "-c", "copy", "-frames:v", "1", "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+delay_moov", "pipe:1"]);
  } catch (err) {
    const tag = /Could not find tag for codec (\w+)/.exec(err.stderr || err.message);
    if (tag) throw new Error(`${name}'s picture is ${tag[1]}, which an MP4 cannot hold without encoding it again: give --video an H.264 or HEVC copy of it`);
    throw err;
  }

  // A steady rate from the first frame to the last, which a timebase in
  // whole milliseconds rounds no frame of; else frames over the time. At a
  // steady rate the frames are the places from the first to the last.
  const span = (times[times.length - 1] - times[0]) * unit;
  return {
    file,
    name,
    seconds,
    start,
    frames: constant && span > 0 ? places + 1 : frames,
    fps: constant && span > 0 ? nominal(places / span) : frames / seconds,
    constant,
    picture: (/: Video: (\w+)/.exec(pictureLine) || [])[1] || "unknown",
    sound: soundLines.length ? (/: Audio: (\w+)/.exec(soundLines[0]) || [])[1] || "unknown" : null,
    sounds: soundLines.length,
    subtitles: subtitleLines.length,
    made: MARK.test(comment.trim()),
  };
}

// What --length takes, in seconds: 1 second to an hour. musicfit.js checks
// it with the numbers written out, and a test holds these to those.
const LENGTH_LEAST = 1;
const LENGTH_MOST = 3600;

// Refuses a video that is not `length` long to a frame of it: the sound
// is cut or padded to the picture only within that frame. `fps` is the
// rate frames count at here. The length it offers is the one --length
// takes nearest the video's, written to 3 places, or to 6 where 3 land
// more than a frame off, as they can past 2000 fps. It is offered only
// when `near` takes it, the very test a run given it meets, so that run
// takes it. When neither is near, the video is more than a frame past the
// hour or under a second, where no length --length takes comes within a
// frame of it, and it is refused for that.
function fits(info, length, fps) {
  const frame = 1 / info.fps + 1e-6;
  const near = (seconds) => Math.abs(info.seconds - seconds) <= frame;
  if (near(length)) return;
  const counted = info.constant ? ` (${info.frames} frames at ${fpsText(info.fps)} fps)` : "";
  const give = Math.min(Math.max(info.seconds, LENGTH_LEAST), LENGTH_MOST);
  const offer = [num(give, 3), num(give, 6)].find((text) => near(Number(text)));
  if (offer === undefined) {
    const long = `${info.name} is ${beyond(info.seconds, give)} s long${counted}`;
    if (info.seconds > LENGTH_MOST) throw new Error(`${long}, longer than the hour --length takes at most: give --video a cut of an hour or less`);
    throw new Error(`${long}, shorter than the 1 second --length takes at least, so musicfit makes no fit under it`);
  }
  throw new Error(`${info.name} is ${info.seconds.toFixed(2)} s long${counted} and --length is ${length.toFixed(2)} s: give --length ${offer}${inFrames(info, fps, near)}`);
}

// The video's length beside the end of what --length takes that it is
// refused for passing: to 2 places as the other sentences give it, or to 3
// or 6 where fewer would read as that end itself. Past 200 fps a frame is
// under half a hundredth of a second, and past 2000 fps under half a
// thousandth, so 2 or 3 places can round the length to the end; a video
// refused this way passes the end by more than a frame and a millionth of
// a second, which 6 places always show.
function beyond(seconds, end) {
  return [seconds.toFixed(2), seconds.toFixed(3)].find((text) => Number(text) !== end) || seconds.toFixed(6);
}

// The video's own count of frames as a --length as well, ", or 350f": only
// at a steady rate, where a count names one moment, and only when a run
// given it takes it. That run reads the count at the rate this run counts
// frames at, `fps`, as a length --length takes that has to be `near` the
// video. A count is never offered at another rate with an --fps of its
// own: a run given it would read its --hit, --drop and --fade in frames at
// that rate too, and move them; the length in seconds serves a run at any
// rate. With no --fps a run counts at the video's rate as fpsText writes
// it, to three places: at 57000/1001 fps, 56.943, where the video's 204995
// frames read as more than an hour though it is shorter.
function inFrames(info, fps, near) {
  if (!info.constant) return "";
  const length = info.frames / fps;
  return length >= LENGTH_LEAST && length <= LENGTH_MOST && near(length) ? `, or ${info.frames}f` : "";
}

// The video's own sound on its timeline from `start`, where its picture
// starts, as { L, R } exactly `n` samples long, and how many seconds of it
// ran past that and were cut; null when it has none. `stream` is which of
// its sound streams, from 0.
async function ownSound(file, n, start, stream = 0) {
  let x;
  try {
    x = await decode(file, { rate: RATE, channels: 2, from: start, stream });
  } catch (err) {
    if (/has no audio/.test(err.message)) return null;
    throw err;
  }
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  await blocks(0, Math.min(n, x.length / 2), (from, to) => {
    for (let i = from; i < to; i++) {
      L[i] = x[2 * i];
      R[i] = x[2 * i + 1];
    }
  });
  return { L, R, over: Math.max(0, x.length / 2 - n) / RATE };
}

// The sound as AAC in an .m4a of its own, to be measured as a player hears
// it before the picture is copied over it once. At 256 kb/s: at 192 the
// encoder's noise around a sharp sound lifted the true peak by up to 1.1 dB
// in two launch films, and by another amount each time the sound was
// encoded again, up to 2.4 dB, so a sound limited further could come out
// higher; at 256 it lifted it by half a dB at most but once, by 1 dB. With
// ffmpeg's fast coder, the default of ffmpeg 4.4, on every ffmpeg: twoloop,
// the default of ffmpeg 5.0 and newer and there in 4.4 too, lifted the true
// peak of a loud fit held to -1 dBTP to +3.3 dBTP on 4.4 and 8 alike, and
// limiting it again to take that off took loudness with it. Both versions
// know the coder by this name.
async function encodeAac(samples, file) {
  await run(["-v", "error", "-f", "f32le", "-ar", String(RATE), "-ac", "2", "-i", "pipe:0", "-c:a", "aac", "-aac_coder", "fast", "-b:a", "256k", "-y", where(file)], samples, { writes: where(file) });
}

// The video's picture, copied packet for packet, over `sound` (an .m4a),
// copied too, in an MP4 that plays as it downloads. The picture is moved
// by `start`, so its first frame is at 0 with the sound. `comment` replaces
// the video's own comment tag, so a mark another tool left there
// (voiceoverfit marks its files so) is not carried over to a file it did
// not make. HEVC is tagged hvc1, the tag QuickTime, Safari and iOS play.
// The run's own files are read by their names, from their own folder, as
// the name of the out folder is the user's (see measureFile() in audio.js).
async function mux(file, sound, out, { picture, comment, start }) {
  const tag = picture === "hevc" ? ["-tag:v", "hvc1"] : [];
  await run(["-v", "error", "-copyts", "-itsoffset", (-start).toFixed(6), "-i", where(file), "-i", path.basename(sound), "-map", "0:V:0", "-map", "1:a:0", "-c", "copy", ...tag, "-metadata", `comment=${comment}`, "-movflags", "+faststart", "-y", where(out)], null, { writes: where(out), cwd: path.dirname(sound) });
  // Read back, every packet of it, before the run may put it in place: an
  // MP4 whose index did not get written is no video, whatever ffmpeg said.
  let why = null;
  const name = path.basename(out);
  try {
    const { stderr } = await run(["-v", "error", "-i", name, "-map", "0", "-c", "copy", "-f", "null", "-"], null, { cwd: path.dirname(out) });
    if (DAMAGED.some((line) => line.test(stderr))) why = "it is cut short";
  } catch (err) {
    if (err.stopped || err.unstarted) throw err;
    why = err.message.replace(/^ffmpeg: /, "").split(`${name}: `).join("");
  }
  if (why) throw new Error(`The video.mp4 this run wrote cannot be read back (${why}), so it was not put in place`);
}

module.exports = { probe, fits, ownSound, encodeAac, mux, mark, fpsText, LENGTH_LEAST, LENGTH_MOST };
