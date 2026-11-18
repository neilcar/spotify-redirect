// node test/native-drive.mjs <type> <id> — sends one framed request to native/tidal-play.mjs
// the way Firefox does and prints the reply. Talks to the real TIDAL app (plays music).
import { spawn } from "node:child_process";
import { encodeMessage, decodeMessages } from "../native/tidal-play.mjs";
const [type, id] = process.argv.slice(2);
const child = spawn(process.execPath, [new URL("../native/tidal-play.mjs", import.meta.url).pathname]);
let buf = Buffer.alloc(0);
child.stdout.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  const { messages } = decodeMessages(buf);
  if (messages.length) { console.log(JSON.stringify(messages[0])); child.stdin.end(); }
});
child.stderr.pipe(process.stderr);
const t0 = Date.now();
child.on("exit", () => console.log(`exited after ${Date.now() - t0} ms`));
child.stdin.write(encodeMessage({ type, id }));
