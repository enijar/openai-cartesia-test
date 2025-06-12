import fs from "node:fs";
import path from "node:path";
import { OpenAI } from "openai";
import { CartesiaClient } from "@cartesia/cartesia-js";
import config from "~/config.js";

const openai = new OpenAI({ apiKey: config.openaiKey });
const cartesia = new CartesiaClient({ apiKey: config.cartesiaKey });

const dataDir = path.join(import.meta.dirname, "..", "data");

function stt(audioBuffer: Buffer<ArrayBufferLike>) {
  return new Promise<string>(async (resolve) => {
    const socket = cartesia.stt.websocket({
      model: "ink-whisper",
      language: "en",
      encoding: "pcm_s16le",
      sampleRate: 16000,
    });
    const parts: string[] = [];
    await socket.onMessage(async (message) => {
      switch (message.type) {
        case "transcript":
          parts.push(message.text ?? "");
          break;
        case "flush_done":
          await socket.done();
          break;
        case "done":
          resolve(parts.join("").trim());
          await socket.done();
          break;
      }
    });
    const chunkSize = 3200;
    for (let i = 0; i < audioBuffer.length; i += chunkSize) {
      const chunk = audioBuffer.subarray(i, i + chunkSize);
      const arrayBuffer = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
      await socket.send(arrayBuffer as ArrayBuffer);
    }
    await socket.finalize();
  });
}

async function llm(text: string) {
  const response = await openai.responses.create({
    model: "gpt-4.1-nano-2025-04-14",
    instructions: "You are a friendly assistant.",
    input: [
      {
        role: "user",
        content: text,
      },
    ],
  });
  return response.output_text;
}

async function tts(text: string) {
  const websocket = cartesia.tts.websocket({
    container: "raw",
    encoding: "pcm_f32le",
    sampleRate: 44100,
  });
  const response = await websocket.send({
    modelId: "sonic-2",
    voice: {
      mode: "id",
      id: "a0e99841-438c-4a64-b679-ae501e7d6091",
    },
    transcript: text,
  });
  const chunks: string[] = [];
  for await (const message of response.events("message")) {
    const json = JSON.parse(message);
    switch (json.type) {
      case "chunk":
        chunks.push(json.data);
        break;
    }
  }
  const pcm = Uint8Array.from(chunks.map(atob).map((bin) => new Uint8Array([...bin].map((c) => c.charCodeAt(0)))));
  return Buffer.from(await pcmToWav(pcm).arrayBuffer());
}

function pcmToWav(pcmBytes: Uint8Array<ArrayBuffer>, sampleRate = 16000, numChannels = 1) {
  const byteRate = sampleRate * numChannels * 2;
  const blockAlign = numChannels * 2;
  const wavDataSize = pcmBytes.length;
  const buffer = new ArrayBuffer(44 + wavDataSize);
  const view = new DataView(buffer);
  let offset = 0;
  view.setUint32(offset, 0x52494646, false);
  offset += 4;
  view.setUint32(offset, 36 + wavDataSize, true);
  offset += 4;
  view.setUint32(offset, 0x57415645, false);
  offset += 4;
  view.setUint32(offset, 0x666d7420, false);
  offset += 4;
  view.setUint32(offset, 16, true);
  offset += 4;
  view.setUint16(offset, 1, true);
  offset += 2;
  view.setUint16(offset, numChannels, true);
  offset += 2;
  view.setUint32(offset, sampleRate, true);
  offset += 4;
  view.setUint32(offset, byteRate, true);
  offset += 4;
  view.setUint16(offset, blockAlign, true);
  offset += 2;
  view.setUint16(offset, 16, true);
  offset += 2;
  view.setUint32(offset, 0x64617461, false);
  offset += 4;
  view.setUint32(offset, wavDataSize, true);
  new Uint8Array(buffer, 44).set(pcmBytes);
  return new Blob([buffer], { type: "audio/wav" });
}

async function time<T>(label: string, fn: () => Promise<T>) {
  let result;
  const startTime = Date.now();
  result = await fn();
  console.log(label, Date.now() - startTime);
  return result;
}

const startTime = Date.now();

const text = await time("TTS", async () => {
  const audioBuffer = await fs.promises.readFile(path.join(dataDir, "in.wav"));
  return await stt(audioBuffer);
});

const response = await time("LLM", async () => {
  return await llm(text);
});

const audio = await time("TTS", async () => {
  return await tts(response);
});

await fs.promises.writeFile(path.join(dataDir, "out.wav"), audio);

console.log("Execution time", Date.now() - startTime);

process.exit(0);
