"use strict";

// What musicfit asks of ffmpeg works on ffmpeg 4.4 (Ubuntu 22.04's, the
// oldest it takes) as on newer ones, the hosted service's 9.0.2 among them,
// and an ffmpeg that fails is named with the line that says why.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { reason } = require("../skills/musicfit/scripts/lib/audio");
const { fixture, outDir } = require("./helpers");

const CLI = path.resolve(__dirname, "../skills/musicfit/scripts/musicfit.js");
const ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.join(__dirname, "fixtures");
const posix = { skip: process.platform === "win32" ? "the stand-ins are shell scripts" : false };

test("a fit and an analysis run on an ffmpeg that knows only info and verbose for framelog, as 4.4", posix, () => {
  const { file } = fixture("house");
  const vo = fixture("voice");
  const env = { ...process.env, FFMPEG_PATH: path.join(FIXTURES, "ffmpeg44", "ffmpeg") };
  const fit = spawnSync(process.execPath, [CLI, file, "--length", "12", "--hit", "8", "--voice", vo.file, "--out", outDir("ffmpeg44-fit")], { encoding: "utf8", env });
  assert.equal(fit.status, 0, fit.stderr);
  assert.ok(fs.existsSync(path.join(outDir("ffmpeg44-fit"), "mix.wav")));
  const read = spawnSync(process.execPath, [CLI, file, "--analyze", "--out", outDir("ffmpeg44-analysis")], { encoding: "utf8", env });
  assert.equal(read.status, 0, read.stderr);
});

test("an ffmpeg that refuses a value of the loudness meter is named with that line, not with how it gave up", posix, () => {
  // The real ffmpeg of this machine, given a framelog value no ffmpeg has.
  const { file } = fixture("house");
  const env = { ...process.env, FFMPEG_PATH: path.join(FIXTURES, "badframelog", "ffmpeg") };
  const run = spawnSync(process.execPath, [CLI, file, "--length", "12", "--out", outDir("bad-framelog")], { encoding: "utf8", env });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /musicfit: ffmpeg: Error (setting option|initializing filter|applying option).*ebur128/);
  assert.doesNotMatch(run.stderr, /Conversion failed|Error opening output files/);
});

test("the line that says why is found in what ffmpeg 4.4, 6.1, 8 and 9 print", () => {
  const said = (name) => fs.readFileSync(path.join(FIXTURES, "stderr", `${name}.txt`), "utf8");
  const cases = {
    // Written in two parts, so the meter's settings in it are not read as a framelog value musicfit asks for.
    "framelog-4.4": "ffmpeg: Error initializing filter 'ebur128' with args 'peak=true:framelog" + "=bogus'",
    "framelog-6.1": "ffmpeg: Error applying option 'framelog' to filter 'ebur128': Invalid argument",
    "framelog-8.0": "ffmpeg: Error applying option 'framelog' to filter 'ebur128': Invalid argument",
    "no-folder-4.4": "ffmpeg: /nonexistent/dir/fitted.wav: No such file or directory",
    "no-folder-8.0": "ffmpeg: Error opening output /nonexistent/dir/fitted.wav: No such file or directory",
    "disk-full-4.4": "ffmpeg: Error writing trailer of /dev/full: No space left on device",
    "disk-full-8.0": "ffmpeg: Error writing trailer: No space left on device",
    "no-input-4.4": "ffmpeg: nothing.wav: No such file or directory",
    "no-input-8.0": "ffmpeg: Error opening input: No such file or directory",
    "encoder-4.4": "ffmpeg: Unknown encoder 'nosuchencoder'",
    "encoder-8.0": "ffmpeg: Unknown encoder 'nosuchencoder'",
    // At -v info, as the loudness meter and the read of a video run, ffmpeg
    // ends a failure with its report of what it wrote, "... muxing
    // overhead: unknown": in 4.4 when the pipe it writes to closes, in 8
    // when the system starts no more threads for it.
    "closed-pipe-4.4": "ffmpeg: Error writing trailer of pipe:1: Broken pipe",
    "no-threads-8.0": "ffmpeg: Error sending frames to consumers: Resource temporarily unavailable",
    // ffmpeg 9.0.2, the hosted service's, as it printed each of them.
    "framelog-9.0": "ffmpeg: Error applying option 'framelog' to filter 'ebur128': Invalid argument",
    "no-folder-9.0": "ffmpeg: Error opening output /nonexistent/dir/fitted.wav: No such file or directory",
    "disk-full-9.0": "ffmpeg: Error writing trailer: No space left on device",
    "no-input-9.0": "ffmpeg: Error opening input: No such file or directory",
    "encoder-9.0": "ffmpeg: Unknown encoder 'nosuchencoder'",
    "closed-pipe-9.0": "ffmpeg: Error writing trailer: Broken pipe",
    "no-threads-9.0": "ffmpeg: pthread_create() failed: Resource temporarily unavailable",
  };
  for (const [name, line] of Object.entries(cases)) assert.equal(reason(said(name), 1), line, name);
  // A line with no word of an error, as a wrapper or a guard may print, and nothing at all.
  assert.equal(reason("fitted.wav: No space left on device\n", 1), "ffmpeg: fitted.wav: No space left on device");
  assert.equal(reason("kits ffmpeg: in/a%d.wav: an input named with % or ending in .y is not opened\n", 1), "kits ffmpeg: in/a%d.wav: an input named with % or ending in .y is not opened");
  assert.equal(reason("", 1), "ffmpeg exited with 1");
  // Stopped by a signal it caught, as Ctrl-C to the whole process group.
  assert.equal(reason("Exiting normally, received signal 2.\n", 255), "ffmpeg was stopped (signal 2)");
  assert.equal(reason("", null, "SIGKILL"), "ffmpeg was stopped (SIGKILL)");
  // At -v error a caught signal leaves no line at all, only the exit code
  // 255, which ffmpeg 7 and newer also give a refused operation, with a line.
  assert.equal(reason("", 255), "ffmpeg was stopped");
  assert.equal(reason("[out#0/wav @ 0x5970b98c6a00] Error opening output fitted.wav: Operation not permitted\n", 255), "ffmpeg: Error opening output fitted.wav: Operation not permitted");
});

test("fitted.wav and mix.wav say nothing of the ffmpeg that wrote them, so any ffmpeg writes the same bytes", async () => {
  const { fit } = require("../skills/musicfit/scripts/lib/fit");
  const { file } = fixture("house");
  const vo = fixture("voice");
  const out = outDir("bitexact");
  await fit(file, { fps: 30, duck: 10, lufs: -14, end: "auto", length: 12, voice: vo.file, out });
  for (const name of ["fitted.wav", "mix.wav"]) {
    const wav = fs.readFileSync(path.join(out, name));
    assert.equal(wav.toString("latin1", 0, 4), "RIFF");
    const chunks = [];
    for (let at = 12; at + 8 <= wav.length; ) {
      const id = wav.toString("latin1", at, at + 4);
      chunks.push(id);
      if (id === "data") break;
      at += 8 + wav.readUInt32LE(at + 4) + (wav.readUInt32LE(at + 4) % 2);
    }
    assert.deepEqual(chunks, ["fmt ", "data"], `${name} has ${chunks.join(", ")}`);
    assert.ok(!wav.subarray(0, 200).includes("Lavf"), `${name} names its ffmpeg`);
  }
});

// Every .js file of the kit, the tests and the tools included.
function sources(dir = ROOT) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name.startsWith("musicfit-")) continue;
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sources(at));
    else if (entry.name.endsWith(".js")) found.push(at);
  }
  return found;
}

test("the loudness meter is asked only for framelog values ffmpeg 4.4 has, in every .js file, comments too", () => {
  // The pattern MakersMCP-Api's ffmpeg check reads an installed kit with.
  const value = /framelog\s*=\s*(\w+)/g;
  const files = sources();
  assert.ok(files.some((f) => f.endsWith(path.join("lib", "audio.js"))));
  let asked = 0;
  for (const file of files) {
    for (const m of fs.readFileSync(file, "utf8").matchAll(value)) {
      asked++;
      assert.ok(["info", "verbose"].includes(m[1]), `${path.relative(ROOT, file)} asks for framelog ${m[1]}`);
    }
  }
  assert.ok(asked > 0, "the meter is asked for no framelog value at all");
});

test("a stereo sound handed to ffmpeg a block at a time is the same sound as one interleaved copy of it", async () => {
  const { decode, measure, encodeWav } = require("../skills/musicfit/scripts/lib/audio");
  const whole = await decode(fixture("house").file);
  const n = whole.length / 2;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = whole[2 * i];
    R[i] = whole[2 * i + 1];
  }
  assert.deepEqual(await measure({ L, R }), await measure(whole));
  const [a, b] = [outDir("blocks.wav"), outDir("whole.wav")];
  await encodeWav({ L, R }, a);
  await encodeWav(whole, b);
  assert.ok(fs.readFileSync(a).equals(fs.readFileSync(b)));
});

const lowLimit = { skip: process.platform === "win32" ? "it takes sh to lower the limit" : false };

// What a node with 256 file descriptors at most prints when it holds all
// it may but one, too few for ffmpeg's pipes, and runs ffmpeg: first, or
// once the start check has passed while they were free.
function shortOfFiles(checkFirst) {
  const script = `
    const fs = require("node:fs");
    const { ready, run } = require(${JSON.stringify(path.join(ROOT, "skills", "musicfit", "scripts", "lib", "audio"))});
    (${checkFirst} ? ready() : Promise.resolve()).then(() => {
      const held = [];
      try {
        for (;;) held.push(fs.openSync(${JSON.stringify(__filename)}, "r"));
      } catch {}
      fs.closeSync(held.pop());
      return run(["-version"], null);
    }).then(() => console.log("ran"), (err) => console.log(err.message, err.unstarted));
  `;
  const r = spawnSync("sh", ["-c", 'ulimit -n 256 && exec "$0" -e "$1"', process.execPath, script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

const NO_FILES = "musicfit could not start ffmpeg: too many open files. Raise the limit on open files (ulimit -n) and run it again. true\n";

test("a start check that cannot start ffmpeg for want of file descriptors says so and what to do", lowLimit, () => {
  assert.equal(shortOfFiles(false), NO_FILES);
});

test("a call after the start check that cannot start ffmpeg for want of file descriptors says so and what to do, where the run ended with the words of a TypeError", lowLimit, () => {
  assert.equal(shortOfFiles(true), NO_FILES);
});

test("a line a program printed is quoted as it is, its control characters written out, and a long one keeps its start and its end", () => {
  const { quoted } = require("../skills/musicfit/scripts/lib/audio");
  assert.equal(quoted("#!/bin/sh\r"), '"#!/bin/sh\\r"');
  assert.equal(quoted("a\tb\x1b[31mc\x7f\u0085\ufeffd\u202e"), '"a\\tb\\x1b[31mc\\x7f\\x85\\ufeffd\\u202e"');
  assert.equal(quoted("env: \u2018runner\u2019: No such file or directory"), '"env: \u2018runner\u2019: No such file or directory"');
  const long = `${"a".repeat(150)}${"b".repeat(100)}`;
  assert.equal(quoted(long), `"${"a".repeat(120)}...${"b".repeat(80)}"`);
  assert.equal(quoted("x".repeat(200)), `"${"x".repeat(200)}"`);
});

test("an ffmpeg that gives no answer when asked its version is stopped once the time is up, and the run stops saying only that, with no advice to install one", posix, async () => {
  const { ready } = require("../skills/musicfit/scripts/lib/audio");
  const real = process.env.FFMPEG_PATH ? path.resolve(process.env.FFMPEG_PATH) : spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  // One that never answers, and an ffmpeg that would, a moment too late,
  // as on a machine short of memory.
  for (const [name, script] of [
    ["silent", "#!/bin/sh\nexec sleep 30\n"],
    ["slow", `#!/bin/sh\nsleep 2 && exec "${real}" "$@"\n`],
  ]) {
    const standIn = path.join(outDir(name), "ffmpeg");
    fs.mkdirSync(path.dirname(standIn), { recursive: true });
    fs.writeFileSync(standIn, script);
    fs.chmodSync(standIn, 0o755);
    const was = process.env.FFMPEG_PATH;
    process.env.FFMPEG_PATH = standIn;
    const began = Date.now();
    try {
      await assert.rejects(ready(500), (err) => {
        assert.equal(err.message, `musicfit could not check ffmpeg, ${standIn}: it gave no answer in 0.5 s when asked its version, as on a machine short of memory. Run it again.`);
        assert.ok(err.unstarted);
        return true;
      });
    } finally {
      if (was === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = was;
    }
    assert.ok(Date.now() - began < 10000, `${name}: ${Date.now() - began} ms`);
  }
});

test("the ffmpeg is asked its version once for its FFMPEG_PATH and PATH, looked for again after a failure, and one that can no longer be started is said to be", posix, async () => {
  const { ready, run } = require("../skills/musicfit/scripts/lib/audio");
  const real = process.env.FFMPEG_PATH ? path.resolve(process.env.FFMPEG_PATH) : spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  const folder = outDir("asked-once");
  fs.mkdirSync(folder, { recursive: true });
  const standIn = path.join(folder, "ffmpeg");
  const asked = path.join(folder, "asked");
  const was = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = standIn;
  try {
    await assert.rejects(ready(), { message: /^musicfit needs ffmpeg, and FFMPEG_PATH points to .*, where there is none\./ });
    fs.writeFileSync(standIn, `#!/bin/sh\necho "$*" >> "${asked}"\nexec "${real}" "$@"\n`);
    fs.chmodSync(standIn, 0o755);
    assert.equal(await ready(), standIn);
    await run(["-version"], null);
    await run(["-version"], null);
    assert.equal(fs.readFileSync(asked, "utf8"), "-version\n-hide_banner -nostdin -version\n-hide_banner -nostdin -version\n");
    fs.rmSync(standIn);
    await assert.rejects(run(["-version"], null), (err) => {
      assert.equal(err.message, `musicfit could not start ffmpeg, ${standIn}, again: no such file or directory. Check that it is still there and may be run, and run musicfit again.`);
      assert.ok(err.unstarted);
      return true;
    });
  } finally {
    if (was === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = was;
  }
});

test("an ffmpeg that cannot be started again later in a run is told as one, never as a track or a video ffmpeg cannot read, nor as a video.mp4 that cannot be read back", posix, () => {
  const real = process.env.FFMPEG_PATH ? path.resolve(process.env.FFMPEG_PATH) : spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  const root = outDir("started-again");
  const film = path.join(root, "film.mp4");
  fs.mkdirSync(root, { recursive: true });
  const made = spawnSync(real, ["-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x96:r=25:d=12", "-c:v", "mpeg4", "-q:v", "6", film], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const { file } = fixture("house");
  const { FFMPEG_PATH, ...rest } = process.env;
  // The track is read first, or with --video the video, once ffmpeg has
  // answered its version; video.mp4 is read back once it is written.
  for (const [n, gone, args] of [
    [1, "-version", []],
    [2, "-version", ["--video", film]],
    [3, "+faststart", ["--video", film]],
  ]) {
    // A wrapper that runs ffmpeg and takes itself away after the call that
    // has `gone` in it, in a folder whose name holds the words a failed read
    // of the track or the video looks for in what ffmpeg says.
    const standIn = path.join(root, String(n), "Invalid data found", "ffmpeg");
    fs.mkdirSync(path.dirname(standIn), { recursive: true });
    fs.writeFileSync(standIn, `#!/bin/sh\n"${real}" "$@"\nstatus=$?\ncase " $* " in *" ${gone} "*) rm -f "$0" ;; esac\nexit $status\n`);
    fs.chmodSync(standIn, 0o755);
    const out = path.join(root, String(n), "out");
    const run = spawnSync(process.execPath, [CLI, file, "--length", "12", ...args, "--out", out], { encoding: "utf8", env: { ...rest, FFMPEG_PATH: standIn } });
    assert.equal(run.status, 1, run.stderr);
    assert.ok(`\n${run.stderr}`.endsWith(`\nmusicfit: musicfit could not start ffmpeg, ${standIn}, again: no such file or directory. Check that it is still there and may be run, and run musicfit again.\n`), `${n}: ${run.stderr}`);
    assert.deepEqual(fs.readdirSync(path.dirname(out)), ["Invalid data found"], `${n}`);
  }
});

test("on Windows an FFMPEG_PATH that names a file with no extension is said to have no .exe in its name, which Windows does not run, and an ffmpeg.exe beside it is used", posix, async () => {
  // Windows as this system plays it, with stand-ins its shell runs.
  const { ready } = require("../skills/musicfit/scripts/lib/audio");
  const real = process.env.FFMPEG_PATH ? path.resolve(process.env.FFMPEG_PATH) : spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  const bare = path.join(outDir("no-extension"), "ffmpeg");
  const answers = `#!/bin/sh\nexec "${real}" "$@"\n`;
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  fs.writeFileSync(bare, answers);
  fs.chmodSync(bare, 0o755);
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const was = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = bare;
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    await assert.rejects(ready(), (err) => {
      assert.equal(err.message, `musicfit needs ffmpeg, and FFMPEG_PATH points to ${bare}, which has no .exe in its name, so Windows does not run it. Set FFMPEG_PATH to an ffmpeg, or unset it and install one (brew install ffmpeg, sudo apt install ffmpeg or winget install ffmpeg).`);
      assert.ok(err.unstarted);
      return true;
    });
    fs.writeFileSync(`${bare}.exe`, answers);
    fs.chmodSync(`${bare}.exe`, 0o755);
    assert.equal(await ready(), `${bare}.exe`);
  } finally {
    Object.defineProperty(process, "platform", platform);
    if (was === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = was;
  }
});

test("a call in a folder that is not there is not taken for an ffmpeg that cannot start", async () => {
  const { run } = require("../skills/musicfit/scripts/lib/audio");
  const gone = path.join(outDir("no-such-folder"), "inside");
  await assert.rejects(run(["-version"], null, { cwd: gone }), (err) => {
    assert.ok(!err.unstarted, err.message);
    assert.doesNotMatch(err.message, /needs ffmpeg/);
    return true;
  });
});

test("a track or a video is said to be missing only when it is: a No such file or does not exist in what ffmpeg says, as in the name of the folder it is in, or of another file, is told in ffmpeg's words", posix, async () => {
  const { decode } = require("../skills/musicfit/scripts/lib/audio");
  const { probe } = require("../skills/musicfit/scripts/lib/video");
  const gone = outDir("taken-away.wav");
  await assert.rejects(decode(gone), { message: `Cannot read ${gone}: no such file` });
  await assert.rejects(probe(gone), { message: `Cannot read ${gone}: no such file` });
  // A file that is no track and no video, in folders named with those words.
  for (const folder of ["No such file", "does not exist"]) {
    const notes = path.join(outDir(folder), "notes.txt");
    fs.mkdirSync(path.dirname(notes), { recursive: true });
    fs.writeFileSync(notes, "some notes\n");
    await assert.rejects(decode(notes), { message: `Cannot read ${notes}: it is not a kind of file ffmpeg reads, or it is cut short or damaged` });
    await assert.rejects(probe(notes), { message: `Cannot read ${notes}: it is not a kind of file ffmpeg reads, or it is cut short or damaged` });
  }
  // An ffmpeg that fails on a part of the input that is not there, in the
  // words ffmpeg 4.4 and 8 use.
  const { file } = fixture("house");
  const real = process.env.FFMPEG_PATH ? path.resolve(process.env.FFMPEG_PATH) : spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  const was = process.env.FFMPEG_PATH;
  for (const [said, message] of [
    ["/nonexistent/part.wav: No such file or directory", "ffmpeg: /nonexistent/part.wav: No such file or directory"],
    ["[in#0 @ 0x5d9b3c0a8cc0] Error opening input: No such file or directory\nError opening input file /nonexistent/part.wav.\nError opening input files: No such file or directory", "ffmpeg: Error opening input: No such file or directory"],
  ]) {
    const standIn = path.join(outDir(`partgone-${message.length}`), "ffmpeg");
    fs.mkdirSync(path.dirname(standIn), { recursive: true });
    fs.writeFileSync(standIn, `#!/bin/sh\nif [ "$1" = -version ]; then exec "${real}" -version; fi\ncat >&2 <<'LINES'\n${said}\nLINES\nexit 1\n`);
    fs.chmodSync(standIn, 0o755);
    process.env.FFMPEG_PATH = standIn;
    try {
      await assert.rejects(decode(file), { message });
      await assert.rejects(probe(file), { message });
    } finally {
      if (was === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = was;
    }
  }
});

test("what ffmpeg 4.4, 8 and 9 print when they cannot read a file is read on any system, together with the file's own boxes: an MP4 or a MOV with no whole index, also behind ID3v2 tags or a box no format knows, or a MOV that starts with its wide box; a HEIF picture; an MP4 behind ID3v2 tags, refused before ffmpeg reads it when its index is whole; a file that ended early, unless ffmpeg only guessed what it is; a picture of no size; and a file ffmpeg could not open", () => {
  const { unread } = require("../skills/musicfit/scripts/lib/video");
  const { unreadSound, where } = require("../skills/musicfit/scripts/lib/audio");
  const { boxes, refusedByBoxes } = require("../skills/musicfit/scripts/lib/unread");
  const folder = outDir("failure-lines");
  fs.mkdirSync(folder, { recursive: true });
  const put = (name, ...parts) => {
    const file = path.join(folder, name);
    fs.writeFileSync(file, Buffer.concat(parts));
    return file;
  };
  const box = (kind, ...body) => {
    const inside = Buffer.concat(body);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(8 + inside.length);
    return Buffer.concat([size, Buffer.from(kind, "latin1"), inside]);
  };
  const brands = (...names) => Buffer.from(names.join(""), "latin1");
  // An ID3v2.4 tag with one title frame, and one whose flags give it a
  // footer, which counts 10 bytes more.
  const frame = Buffer.concat([Buffer.from("TIT2", "latin1"), Buffer.from([0, 0, 0, 6, 0, 0, 3]), Buffer.from("title", "latin1")]);
  const id3 = (flags = 0) => Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.from([4, 0, flags, 0, 0, 0, frame.length]), frame, flags & 0x10 ? Buffer.concat([Buffer.from("3DI", "latin1"), Buffer.from([4, 0, flags, 0, 0, 0, frame.length])]) : Buffer.alloc(0)]);
  // An MP4 starts with its ftyp box, as the files these lines were printed
  // for do; ffmpeg passes over ID3v2 tags before it, and over a box of a
  // kind it does not know, as it guesses what a file is, and a MOV may
  // start with its wide box.
  const ftyp = box("ftyp", brands("isom", "\0\0\x02\0", "isom", "iso2", "mp41"));
  const mp4s = [
    put("cut.mp4", ftyp),
    put("tagged.mp4", id3(), ftyp),
    put("tagged twice.mp4", id3(), id3(), ftyp),
    put("tag with a footer.mp4", id3(0x10), ftyp),
    put("boxed.mp4", box("abcd", Buffer.alloc(8)), ftyp),
    put("wide.mov", box("wide"), box("mdat", Buffer.alloc(64))),
  ];
  const others = [put("notes.txt", Buffer.from("some notes\n")), put("zeros.mp4", Buffer.alloc(64))];
  // The lines a version printed, with the name of the file it was given
  // then put back as this file's whole name, as musicfit gives files.
  const NAMED = { "cut-index": "cut.mp4", "cut-index-eof": "cut.mp4", "no-index": "cut.mp4", "low-score": "notes.mp4", "tagged-index": "tagged.mp4", heif: "still.avif", sizeless: "cut.mp4", ended: "cut.mkv", "guessed-ended": "notes.mkv", unopened: "notes.aac" };
  const read = (kind, version, file, change = (lines) => lines) => {
    const said = change(fs.readFileSync(path.join(FIXTURES, "stderr", `${kind}-${version}.txt`), "utf8")).split(NAMED[kind]).join(where(file));
    const layout = boxes(where(file));
    const message = (err) => (err ? err.message : null);
    return { video: message(unread(file, said, layout)), sound: message(unreadSound(file, said, layout)) };
  };
  const both = (message) => ({ video: message, sound: message });
  const index = (file) => both(`Cannot read ${file}: it is cut short or damaged, so ffmpeg finds no index in it`);
  const unknown = (file) => both(`Cannot read ${file}: it is not a kind of file ffmpeg reads, or it is cut short or damaged`);
  for (const version of ["4.4", "8.0", "9.0"]) {
    for (const kind of ["cut-index", "cut-index-eof", "no-index"]) {
      for (const file of mp4s) assert.deepEqual(read(kind, version, file), index(file), `${kind}-${version}: ${file}`);
    }
    // "error reading header", which other demuxers may say too, and "moov
    // atom not found" of a file that is no MP4.
    for (const file of others) {
      assert.deepEqual(read("cut-index", version, file), unknown(file), `cut-index-${version}: ${file}`);
      assert.deepEqual(read("no-index", version, file), unknown(file), `no-index-${version}: ${file}`);
      assert.deepEqual(read("cut-index-eof", version, file), both(`Cannot read ${file}: ffmpeg: ${version === "4.4" ? "error reading header" : "Error opening input: End of file"}`), `cut-index-eof-${version}: ${file}`);
    }
    const notes = put("notes.mp4", Buffer.from("not a video\n"));
    assert.deepEqual(read("low-score", version, notes), unknown(notes), `low-score-${version}`);
    // A Matroska file that ended early: as a sound, ffmpeg's words for it
    // are not read, as at -v error ffmpeg does not say when it guessed.
    const cut = put("cut.mkv", Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(596));
    assert.deepEqual(read("ended", version, cut), { video: `Cannot read ${cut}: it is cut short or damaged`, sound: `Cannot read ${cut}: ffmpeg: ${version === "4.4" ? "" : "Error opening input: "}Input/output error` }, `ended-${version}`);
    const guessed = put("notes.mkv", Buffer.from("ok\n"));
    assert.deepEqual(read("guessed-ended", version, guessed), unknown(guessed), `guessed-ended-${version}`);
    const aac = put("notes.aac", Buffer.from("some notes\n"));
    assert.deepEqual(read("unopened", version, aac), both(`Cannot read ${aac}: ffmpeg: ${version === "4.4" ? "" : "Error opening input: "}End of file`), `unopened-${version}`);
  }
  // ffmpeg 4.4 reads no HEIF picture: an AVIF or a HEIC has a meta box and
  // no moov. An MP4 with a meta box and no moov, by its brands no HEIF,
  // is one whose index is gone.
  const meta = box("meta", Buffer.alloc(4), box("hdlr", Buffer.alloc(8), brands("pict"), Buffer.alloc(13)));
  const still = put("still.avif", box("ftyp", brands("avif", "\0\0\0\0", "avif", "mif1", "miaf")), meta, box("mdat", Buffer.alloc(32)));
  assert.deepEqual(read("heif", "4.4", still), { video: "still.avif is a still picture, not a video", sound: `${still} has no audio stream` });
  const notStill = put("meta.mp4", ftyp, meta, box("mdat", Buffer.alloc(32)));
  assert.deepEqual(read("heif", "4.4", notStill), index(notStill));
  // A whole index behind ID3v2 tags is refused before ffmpeg reads the
  // file, on every ffmpeg, and one cut short behind them as cut short.
  // Behind them a file with no index at all is one whose index is gone, as
  // ffmpeg 9 says of every file behind a tag.
  const moov = box("moov", box("mvhd", Buffer.alloc(100)));
  const early = (file) => (refusedByBoxes(file, boxes(file)) || {}).message || null;
  for (const tags of [[id3()], [id3(), id3()], [id3(0x10)]]) {
    const whole = put("tagged whole.mp4", ...tags, ftyp, box("mdat", Buffer.alloc(32)), moov);
    assert.equal(early(whole), `Cannot read ${whole}: it starts with an ID3v2 tag, and ffmpeg can read an MP4, a MOV or an M4A behind one from the wrong place, or not at all: give a copy of it without the tag`);
    const cut = put("tagged cut.mp4", ...tags, ftyp, box("mdat", Buffer.alloc(32)), moov.subarray(0, moov.length - 20));
    assert.equal(early(cut), `Cannot read ${cut}: it is cut short or damaged, so ffmpeg finds no index in it`);
    // An index ffmpeg finds and cannot read is damaged, tag or not.
    assert.deepEqual(read("cut-index", "9.0", whole), index(whole));
  }
  const gone = put("tagged gone.mp4", id3(), ftyp, box("mdat", Buffer.alloc(32)));
  assert.equal(early(gone), null);
  assert.deepEqual(read("tagged-index", "9.0", gone), index(gone));
  const plain = put("plain.mp4", ftyp, box("mdat", Buffer.alloc(32)), moov);
  assert.equal(early(plain), null);
  // A picture ffmpeg 4.4 knows no size of, which it will not copy; ffmpeg
  // 8 and 9 copy none of its frames. The tags it lists are not lines of its
  // own, whatever words they hold.
  const sizeless = put("sizeless.mp4", ftyp, moov);
  const frames = `Cannot read ${sizeless}: it is cut short or damaged, so ffmpeg finds no frames in it`;
  assert.equal(read("sizeless", "4.4", sizeless).video, frames);
  const noted = (lines) => lines.replace(/^( +)handler_name +: VideoHandler$/m, "$&\n$1comment         : a note that ends in: corrupt input packet in stream 0");
  assert.match(noted(fs.readFileSync(path.join(FIXTURES, "stderr", "sizeless-4.4.txt"), "utf8")), /^ +comment +: a note that ends in: corrupt input packet in stream 0$/m);
  assert.equal(read("sizeless", "4.4", sizeless, noted).video, frames);
  // A picture listed with its size is not one ffmpeg knows nothing of, and
  // an MPEG-TS stream's number in the file, as [0x100], is no size.
  const stream = /^( +)Stream #0:0\(und\): Video: .*$/m;
  assert.match(fs.readFileSync(path.join(FIXTURES, "stderr", "sizeless-4.4.txt"), "utf8"), stream);
  assert.equal(read("sizeless", "4.4", sizeless, (lines) => lines.replace(stream, "$1Stream #0:0(und): Video: mpeg4 (mp4v / 0x7634706D), none, 160x96, 330 kb/s, 12800 tbr")).video, null);
  assert.equal(read("sizeless", "4.4", sizeless, (lines) => lines.replace(stream, "$1Stream #0:0[0x100]: Video: mpeg4 ([16][0][0][0] / 0x0010), none, 90k tbr, 90k tbn, 90k tbc")).video, frames);
});

test("the file's own boxes tell an MP4's index cut short as ffmpeg would read them: a moov that runs past the end of the file is cut, unless all it lacks is part of its last box, a udta, and sizes of 8 bytes and of 0 are read; a kind ffmpeg guesses an MP4 by counts only in the first MiB, past ID3v2 tags; a HEIF picture is told by its brands", () => {
  const { boxes } = require("../skills/musicfit/scripts/lib/unread");
  const folder = outDir("own-boxes");
  fs.mkdirSync(folder, { recursive: true });
  const box = (kind, ...body) => {
    const inside = Buffer.concat(body);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(8 + inside.length);
    return Buffer.concat([size, Buffer.from(kind, "latin1"), inside]);
  };
  const layout = (...parts) => {
    const file = path.join(folder, "file.mp4");
    fs.writeFileSync(file, Buffer.concat(parts));
    return boxes(file);
  };
  const ftyp = box("ftyp", Buffer.from("isom\0\0\x02\0isomiso2mp41", "latin1"));
  const mdat = box("mdat", Buffer.alloc(64));
  const trak = box("trak", box("tkhd", Buffer.alloc(84)));
  const udta = box("udta", box("meta", Buffer.alloc(40)));
  const mvhd = box("mvhd", Buffer.alloc(100));
  const whole = box("moov", mvhd, trak, udta);
  const cut = (bytes, short) => bytes.subarray(0, bytes.length - short);
  const index = (bytes) => layout(ftyp, mdat, bytes).index;
  assert.equal(index(whole), "whole");
  // Short of a part of its tags only, or of all its tags but their header.
  assert.equal(index(cut(whole, 8)), "whole");
  assert.equal(index(cut(whole, udta.length - 8)), "whole");
  // Short of more: its tags whole and gone, a trak part way, a udta that
  // is not its last box.
  assert.equal(index(cut(whole, udta.length)), "cut");
  assert.equal(index(cut(whole, udta.length + 20)), "cut");
  assert.equal(index(cut(box("moov", mvhd, udta, trak), trak.length + 8)), "cut");
  // A moov of 64-bit size, and one of size 0, which runs to the end.
  const large = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from("moov", "latin1"), Buffer.from([0, 0, 0, 0, 0, 0, 0, 16 + mvhd.length]), mvhd]);
  assert.equal(index(large), "whole");
  assert.equal(index(cut(large, 4)), "cut");
  assert.equal(index(Buffer.concat([Buffer.alloc(4), Buffer.from("moov", "latin1"), mvhd])), "whole");
  assert.equal(layout(ftyp, mdat).index, null);
  // The kinds ffmpeg guesses an MP4 by, past ID3v2 tags, in the first MiB.
  const tag = Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.from([4, 0, 0, 0, 0, 0, 4]), Buffer.alloc(4)]);
  const short = cut(whole, udta.length + 20);
  assert.deepEqual(layout(tag, ftyp, mdat, short), { mp4: true, tagged: true, index: "cut", picture: false });
  assert.deepEqual(layout(box("abcd", Buffer.alloc((1 << 20) - 8)), ftyp, mdat, short), { mp4: false, tagged: false, index: null, picture: false });
  assert.deepEqual(layout(Buffer.from("some notes\n")), { mp4: false, tagged: false, index: null, picture: false });
  // An ID3v2 tag as ffmpeg knows one: a version of 0xff, or a size byte
  // with its top bit set, makes it none, and a box that declares fewer than
  // its own 8 bytes is none either, whatever kind it names.
  const notTag = (bytes, at) => layout(bytes, Buffer.alloc(at - bytes.length), ftyp, mdat).mp4;
  assert.equal(notTag(Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0x84]), 142), false);
  assert.equal(notTag(Buffer.from([0x49, 0x44, 0x33, 0xff, 0, 0, 0, 0, 0, 4]), 14), false);
  assert.equal(notTag(Buffer.from([0x49, 0x44, 0x33, 4, 0xff, 0, 0, 0, 0, 4]), 14), false);
  assert.equal(notTag(Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 4]), 14), true);
  assert.equal(layout(Buffer.from([0, 0, 0, 4]), Buffer.from("ftyp", "latin1")).mp4, false);
  // Inside the moov too: a box of fewer than 8 bytes before a udta the
  // file ends in makes the index cut, not short of its tags only.
  const odd = Buffer.concat([Buffer.from([0, 0, 0, 4]), udta]);
  const moovOdd = Buffer.concat([Buffer.alloc(4), Buffer.from("moov", "latin1"), mvhd, odd]);
  moovOdd.writeUInt32BE(moovOdd.length);
  assert.equal(index(cut(moovOdd, 8)), "cut");
  // A HEIF picture: its brands, a meta box and no moov.
  const meta = box("meta", Buffer.alloc(32));
  const heif = (brand) => layout(box("ftyp", Buffer.from(`${brand}\0\0\0\0${brand}miaf`, "latin1")), meta, mdat).picture;
  assert.deepEqual(["avif", "heic", "mif1", "isom"].map(heif), [true, true, true, false]);
  // Its minor version, which comes after its major brand, is no brand.
  assert.equal(layout(box("ftyp", Buffer.from("isommif1isom", "latin1")), meta, mdat).picture, false);
  assert.equal(layout(box("ftyp", Buffer.from("avif\0\0\0\0avifmif1", "latin1")), meta, mdat, whole).picture, false);
  // Only a regular file is read.
  assert.deepEqual(boxes(folder), { mp4: false, tagged: false, index: null, picture: false });
});

test("an ffmpeg stopped by a signal while it reads a video or a sound leaves a stopped run, whatever it said of the file before", posix, async () => {
  const { decode } = require("../skills/musicfit/scripts/lib/audio");
  const { probe } = require("../skills/musicfit/scripts/lib/video");
  const { file } = fixture("house");
  const real = process.env.FFMPEG_PATH ? path.resolve(process.env.FFMPEG_PATH) : spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  const standIn = path.join(outDir("stopped-reading"), "ffmpeg");
  fs.mkdirSync(path.dirname(standIn), { recursive: true });
  // Lines a read of a file that ended early starts with, then the end of
  // an ffmpeg that Ctrl-C stopped.
  fs.writeFileSync(standIn, `#!/bin/sh\nif [ "$1" = -version ]; then exec "${real}" -version; fi\ncat >&2 <<'LINES'\n[matroska,webm @ 0x1] File ended prematurely\nError opening input file ${file}.\nExiting normally, received signal 2.\nLINES\nexit 255\n`);
  fs.chmodSync(standIn, 0o755);
  const was = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = standIn;
  try {
    for (const read of [probe, decode]) {
      await assert.rejects(read(file), (err) => {
        assert.ok(err.stopped, err.message);
        return true;
      });
    }
  } finally {
    if (was === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = was;
  }
});

test("a file that is no video is not taken for an MP4 cut short when its name, the name of its folder or its tags hold ffmpeg's words for one", async () => {
  const { probe } = require("../skills/musicfit/scripts/lib/video");
  const named = [path.join(outDir("moov atom not found"), "notes.txt"), path.join(outDir("error reading header"), "notes.txt")];
  // A name that holds a line of them, where the system takes one.
  if (process.platform !== "win32") named.push(path.join(outDir("index-named"), "odd\n[mov,mp4,m4a,3gp,3g2,mj2 @ 0x1] moov atom not found\n.txt"));
  for (const notes of named) {
    fs.mkdirSync(path.dirname(notes), { recursive: true });
    fs.writeFileSync(notes, "some notes\n");
    await assert.rejects(probe(notes), { message: `Cannot read ${notes}: it is not a kind of file ffmpeg reads, or it is cut short or damaged` });
  }
  // A sound with no picture, which ffmpeg lists with its tags before it
  // says so.
  const tagged = outDir("tagged-sound.m4a");
  const made = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "aac", "-metadata", "comment=moov atom not found", "-metadata", "title=[mov,mp4,m4a,3gp,3g2,mj2 @ 0x1] error reading header", tagged], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  await assert.rejects(probe(tagged), { message: "tagged-sound.m4a has no picture to lay the music under" });
});
