import fs from "node:fs";
import path from "node:path";
import Pipeline from "~/pipeline.js";

const dataDir = path.join(import.meta.dirname, "..", "data");

const startTime = Date.now();

const pipeline = new Pipeline();
const text = await pipeline.stt(await fs.promises.readFile(path.join(dataDir, "in.wav")));
const response = await pipeline.llm(text);
const buffer = await pipeline.tts(response);
await fs.promises.writeFile(path.join(dataDir, "out.wav"), buffer);

console.log("Execution time", Date.now() - startTime);

process.exit(0);
