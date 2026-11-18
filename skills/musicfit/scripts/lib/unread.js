"use strict";

// What tells that ffmpeg could not read a file, or read only part of it,
// shared by the read of a video (probe() in video.js) and of a sound
// (decode() in audio.js): ffmpeg's own lines, never a file's name or its
// tags, and for an MP4, a MOV or one of their kin the file's own boxes,
// which read the same whatever the version of ffmpeg.

const fs = require("node:fs");

// What ffmpeg prints while it reads a file that is cut short or has a
// broken packet: a packet cut off at the end, an MP4's samples past the end
// of the file, a Matroska or WebM file that stops in the middle.
const DAMAGED = [
  /^\[[^\]\n]+\] (?:Packet corrupt\b|File ended prematurely\b|stream \d+, offset 0x[0-9a-f]+: partial file\b|corrupt input packet in stream \d+)/m,
  // ffmpeg 4.4 starts this one with the file's name.
  /: corrupt input packet in stream \d+\s*$/m,
];
const damaged = (lines) => DAMAGED.some((line) => line.test(lines));

// What ffmpeg's mov demuxer, which reads MP4, MOV, M4A, 3GP and their kin,
// says of a file with no whole index: none found, or one that stops part
// way. FFmpeg 4.4 to 8 name the demuxer that says them, as
// "[mov,mp4,m4a,3gp,3g2,mj2 @ 0x...]", but FFmpeg 9 names every demuxer
// "[in#0 @ 0x...]" while it opens a file, and other demuxers may say "error
// reading header" too, so they count only for a file whose own boxes are an
// MP4's (see boxes()).
const NO_MOOV = /^\[[^\]\n]+\] moov atom not found\r?$/m;
const NO_HEADER = /^\[[^\]\n]+\] error reading header\r?$/m;

// The kinds of box ffmpeg takes a file for an MP4, a MOV or one of their kin
// by when it guesses what a file is.
const MP4_BOXES = new Set(["ftyp", "moov", "mdat", "pnot", "udta", "wide", "ediw", "free", "junk", "pict", "skip", "uuid", "prfl"]);

// The brands of a HEIF file, which holds pictures, as AVIF and HEIC do.
const HEIF = new Set(["mif1", "msf1", "avif", "avis", "heic", "heix"]);

// The most boxes read at the top of a file or in its moov: an MP4 has a
// handful at its top, and a fragmented one two more for each fragment, all
// after its moov.
const MOST = 10000;

// The top-level boxes of the file at `at`, read as ffmpeg reads them: past
// any ID3v2 tags at its start, which ffmpeg passes over, a run of boxes,
// each its size in 4 bytes, or in 8 more when that is 1, or to the end of
// the file when it is 0, and its kind in 4. They tell whether the file is
// an MP4, a MOV or one of their kin (mp4), by a kind of MP4_BOXES among the
// boxes in its first MiB, as ffmpeg takes a file for one; whether it starts
// with an ID3v2 tag (tagged); whether its moov box, which holds the index,
// is "whole" or "cut" (index), cut when it runs past the end of the file,
// as when a recording or a download stopped inside it, unless all it lacks
// is part of its last box, a udta, which holds the file's tags, and null
// when there is none; whether, with no moov, it has an mdat box, the
// picture and the sound an index would give the places of (data); and
// whether it is a HEIF picture, as AVIF and HEIC are (picture), by the
// brands of its ftyp box, with a meta box and no moov. Only what the
// file's size says it holds is read, and it is opened without waiting, as a
// named pipe would make it: a pipe, a device or a folder, which states no
// size or cannot be read, tells nothing.
function boxes(at) {
  const layout = { mp4: false, tagged: false, index: null, data: false, picture: false };
  const { O_RDONLY, O_NONBLOCK = 0 } = fs.constants;
  let fd;
  try {
    fd = fs.openSync(at, O_RDONLY | O_NONBLOCK);
    const end = fs.fstatSync(fd).size;
    const head = Buffer.alloc(16);
    const read = (from) => fs.readSync(fd, head, 0, head.length, from);
    let pos = 0;
    // An ID3v2 tag: "ID3", its version in 2 bytes, neither of them 0xff,
    // its flags in 1, its size in 4 bytes of 7 bits each, and 10 bytes more
    // when its flags give it a footer.
    while (read(pos) >= 10 && head.toString("latin1", 0, 3) === "ID3" && head[3] !== 0xff && head[4] !== 0xff && [6, 7, 8, 9].every((k) => head[k] < 0x80)) {
      layout.tagged = true;
      pos += 10 + ((head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9]) + (head[5] & 0x10 ? 10 : 0);
    }
    let heif = false;
    let meta = false;
    for (let n = 0; n < MOST && pos + 8 <= end; n++) {
      const got = read(pos);
      const kind = head.toString("latin1", 4, 8);
      let size = head.readUInt32BE(0);
      let header = 8;
      if (size === 1) {
        header = 16;
        size = got < 16 ? Infinity : Number(head.readBigUInt64BE(8));
      } else if (size === 0) size = end - pos;
      if (size < header) break;
      if (pos < 1 << 20 && MP4_BOXES.has(kind)) layout.mp4 = true;
      if (kind === "ftyp") heif = brands(fd, pos + header, Math.min(pos + size, end)).some((brand) => HEIF.has(brand));
      if (kind === "meta") meta = true;
      if (kind === "mdat") layout.data = true;
      if (kind === "moov") {
        layout.index = pos + size <= end || onlyTags(fd, pos + header, pos + size, end) ? "whole" : "cut";
        break;
      }
      pos += size;
    }
    layout.picture = layout.mp4 && heif && meta && layout.index === null;
    if (!layout.mp4 || layout.index !== null) layout.data = false;
    if (!layout.mp4) layout.index = null;
    return layout;
  } catch {
    return layout;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The brands an ftyp box from `from` to `to` names: its major brand, and
// after its minor version the brands it is compatible with.
function brands(fd, from, to) {
  const body = Buffer.alloc(Math.max(0, Math.min(to - from, 256)));
  const got = fs.readSync(fd, body, 0, body.length, from);
  const names = [];
  for (let i = 0; i + 4 <= got; i += 4) if (i !== 4) names.push(body.toString("latin1", i, i + 4));
  return names;
}

// Whether all a moov that runs past the end of the file, at `end`, lacks is
// part of its last box, a udta, which holds the file's tags: its boxes from
// `from` are whole up to a udta that the file ends in, and that udta would
// end where the moov would, at `last`.
function onlyTags(fd, from, last, end) {
  const head = Buffer.alloc(8);
  let pos = from;
  for (let n = 0; n < MOST && pos + 8 <= end; n++) {
    fs.readSync(fd, head, 0, head.length, pos);
    const size = head.readUInt32BE(0);
    if (size < 8) return false;
    if (pos + size > end) return head.toString("latin1", 4, 8) === "udta" && pos + size === last;
    pos += size;
  }
  return false;
}

// ffmpeg's own lines in what it printed, `said`, for a file it was given as
// `at`: the ones that start at the left edge, with that name taken out, as
// a name may hold a line of ffmpeg's words. The streams and the tags it
// lists are indented.
function ownLines(said, at) {
  return said
    .split(at)
    .join("")
    .split("\n")
    .filter((line) => !/^\s/.test(line))
    .join("\n");
}

// What ffmpeg's lines for a file with no whole index, on its own lines
// `own`, say of the file its boxes, `layout`, lay out (see boxes()): null
// when they are not there or the file is no MP4 or MOV; "picture" for a
// HEIF picture, which has no index at all; "cut" for a file whose index
// is there or whose data is, the picture and the sound an index would give
// the places of; else null too. A file with neither may be an MP4 cut
// before its data as well as a kind of file ffmpeg does not read whose
// boxes are an MP4's, as ffmpeg 4.4 takes a JPEG XL picture in its box
// for one and finds no moov in it, so ffmpeg's other words tell it.
function noIndex(own, layout) {
  if (!layout.mp4 || !(NO_MOOV.test(own) || NO_HEADER.test(own))) return null;
  if (layout.picture) return "picture";
  if (layout.index === null && !layout.data) return null;
  return "cut";
}

// The refusal of a file with no whole index, as noIndex() finds it.
const indexError = (file) => new Error(`Cannot read ${file}: it is cut short or damaged, so ffmpeg finds no index in it`);

// The refusal, before ffmpeg runs, of an MP4, a MOV or an M4A whose own
// boxes, `layout` (see boxes()), show it cannot be read whole: one whose
// index runs past the end of the file, as ffmpeg can read part of such a
// file and say nothing of it, and one whose whole index comes after an
// ID3v2 tag. Most such files give the places of their picture and sound
// counted from the first byte of the file the tag was put in front of:
// ffmpeg 4.4 and 8 pass over the tag and read every sample as many bytes
// early as the tag is long, and ffmpeg 9 finds no index behind the tag. A
// fragmented MP4 whose fragments count from themselves reads right on 4.4
// and 8, and is refused all the same, as telling it apart would take
// reading every fragment. null when the boxes show neither.
function refusedByBoxes(file, layout) {
  if (layout.index === "cut") return indexError(file);
  if (layout.tagged && layout.index === "whole") return new Error(`Cannot read ${file}: it starts with an ID3v2 tag, and ffmpeg can read an MP4, a MOV or an M4A behind one from the wrong place, or not at all: give a copy of it without the tag`);
  return null;
}

// The refusal of a file ffmpeg found no data it could read in: it says so
// of a kind of file it does not read, and of one it knows that is cut short
// or damaged in its first bytes alike.
const unknown = (file) => new Error(`Cannot read ${file}: it is not a kind of file ffmpeg reads, or it is cut short or damaged`);

// The same refusal of a file that starts with an ID3v2 tag, by its boxes,
// `layout` (see boxes()), with the tag among its causes: ffmpeg 9 does not
// read past such a tag in a WAV, an AIFF, a CAF, a Matroska, a WebM, an AVI
// or an ASF file, which ffmpeg 4.4 and 8 read whole, and ffmpeg 8 and 9
// find no data in an MP3 cut in its first frames, behind the tag an MP3
// most often has.
const noData = (file, layout) => (layout.tagged ? new Error(`Cannot read ${file}: it starts with an ID3v2 tag, which ffmpeg 9 does not read past in many kinds of file, or it is not a kind of file ffmpeg reads, or it is cut short or damaged: give a whole copy of it without the tag`) : unknown(file));

// Whether ffmpeg says it could not open the file it was given as `at`:
// ffmpeg 6.1 and newer name it in "Error opening input file <file>.", and
// 4.4 to 6.0 start the line that says why with it.
function unopened(said, at) {
  const lines = `\n${said}`;
  return lines.includes(`\nError opening input file ${at}.`) || lines.includes(`\n${at}: `);
}

// What ffmpeg printed with the name `at` taken out, also where 4.4 to 6.0
// start a line with it, so that the line that says why names no path.
const unnamed = (said, at) => said.split(`${at}: `).join("").split(at).join("");

module.exports = { DAMAGED, damaged, boxes, ownLines, noIndex, indexError, refusedByBoxes, unknown, noData, unopened, unnamed };
