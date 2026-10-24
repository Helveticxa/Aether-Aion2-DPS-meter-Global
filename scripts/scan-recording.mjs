// Lists the connections in packet recordings (.aetherpc) and how many game
// heartbeats each carries: "loose" counts the three bytes 0E 00 36 alone,
// "strict" also needs the server clock after them, as the meter does since
// 3.3.0. A connection with loose hits and no strict ones is other traffic that
// only looks like the game; a recording of hundreds of MB means some other
// program's traffic was captured too.
//
//   node scripts/scan-recording.mjs "$env:APPDATA/com.helveticxa.aether/recordings/auto-*.aetherpc"
//
// Takes files or a directory. Format: see src-tauri/src/dps_meter/capture/recorder.rs.
import fs from "node:fs";
import path from "node:path";

const CLOCK_MIN = 1_577_836_800_000n; // 2020-01-01
const CLOCK_MAX = 4_102_444_800_000n; // 2100-01-01

function* records(file) {
  const data = fs.readFileSync(file);
  if (data.subarray(0, 8).toString("latin1") !== "AETHERPC") throw new Error(`${file}: not a recording`);
  let at = 12;
  while (at + 28 <= data.length) {
    const time = data.readDoubleLE(at);
    const src = [...data.subarray(at + 8, at + 12)].join(".");
    const dst = [...data.subarray(at + 12, at + 16)].join(".");
    const srcPort = data.readUInt16LE(at + 16);
    const dstPort = data.readUInt16LE(at + 18);
    const length = data.readUInt32LE(at + 24);
    if (at + 28 + length > data.length) break;
    yield { time, flow: `${src}:${srcPort}->${dst}:${dstPort}`, payload: data.subarray(at + 28, at + 28 + length) };
    at += 28 + length;
  }
}

function scan(file) {
  const flows = new Map();
  let packets = 0;
  let start = null;
  for (const { time, flow, payload } of records(file)) {
    packets += 1;
    start ??= time;
    const entry = flows.get(flow) ?? { bytes: 0, loose: 0, strict: 0, first: null, last: null };
    entry.bytes += payload.length;
    for (let i = payload.indexOf(Buffer.from([0x0e, 0x00, 0x36])); i !== -1; i = payload.indexOf(Buffer.from([0x0e, 0x00, 0x36]), i + 1)) {
      entry.loose += 1;
      if (i + 11 <= payload.length) {
        const clock = payload.readBigUInt64LE(i + 3);
        if (clock >= CLOCK_MIN && clock <= CLOCK_MAX) {
          entry.strict += 1;
          entry.first ??= time - start;
          entry.last = time - start;
        }
      }
    }
    flows.set(flow, entry);
  }
  console.log(`== ${path.basename(file)}: ${packets} packets, ${(fs.statSync(file).size / 1048576).toFixed(1)} MB`);
  const rows = [...flows.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
  for (const [flow, e] of rows) {
    if (e.loose === 0 && e.bytes < 100_000) continue;
    const span = e.strict ? `  heartbeats ${e.first.toFixed(1)}s..${e.last.toFixed(1)}s` : "";
    const verdict = e.strict ? "GAME" : e.loose ? "lookalike" : "other";
    console.log(`  ${flow.padEnd(44)} ${String(e.bytes).padStart(11)} B  loose ${String(e.loose).padStart(5)}  strict ${String(e.strict).padStart(5)}  ${verdict}${span}`);
  }
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: node scripts/scan-recording.mjs <file.aetherpc | directory> ...");
  process.exit(1);
}
for (const arg of args) {
  const files = fs.statSync(arg).isDirectory()
    ? fs.readdirSync(arg).filter((name) => name.endsWith(".aetherpc")).sort().map((name) => path.join(arg, name))
    : [arg];
  for (const file of files) scan(file);
}
