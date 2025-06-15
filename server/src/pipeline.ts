import crypto from "node:crypto";
import { OpenAI } from "openai";
import { CartesiaClient } from "@cartesia/cartesia-js";
import type { WSContext } from "hono/ws";
import config from "~/config.js";
import { injectVariables } from "~/utils.js";

export default class Pipeline {
  private stopped = false;
  private openai = new OpenAI({ apiKey: config.openaiKey });
  private cartesia = new CartesiaClient({ apiKey: config.cartesiaKey });

  // keep a chronological list of all audio buffers
  // we store sampleRate here so you can sanity-check later if needed
  private audioChunks: Array<{
    role: "user" | "assistant";
    data: Buffer;
    sampleRate: number;
  }> = [];

  // for reference when generating the WAV header
  private readonly sttSampleRate = 16000;
  private readonly ttsSampleRate = 44100;

  private sttSocket = this.cartesia.stt.websocket({
    model: "ink-whisper",
    language: "en",
    encoding: "pcm_s16le",
    sampleRate: this.sttSampleRate,
  });
  private ttsSocket = this.cartesia.tts.websocket({
    container: "raw",
    encoding: "pcm_s16le",
    sampleRate: this.ttsSampleRate,
  });

  private input: Array<{ role: "user" | "assistant"; content: string }> = [];

  constructor(private instructions: string) {}

  stop() {
    this.stopped = true;
  }

  start() {
    this.stopped = false;
    // clear out any previously collected audio
    // this.audioChunks = [];
  }

  async stt(buffer: Buffer<ArrayBufferLike>) {
    // record the raw user audio buffer
    this.audioChunks.push({
      role: "user",
      data: buffer,
      sampleRate: this.sttSampleRate,
    });

    return new Promise<string>(async (resolve) => {
      const parts: string[] = [];
      const startTime = Date.now();
      await this.sttSocket.onMessage(async (message) => {
        switch (message.type) {
          case "transcript":
            parts.push(message.text ?? "");
            break;
          case "flush_done":
            await this.sttSocket.done();
            break;
          case "done":
            console.log("stt:", Date.now() - startTime);
            resolve(parts.join("").trim());
            break;
        }
      });

      const chunkSize = 3200;
      for (let i = 0; i < buffer.length; i += chunkSize) {
        if (this.stopped) break;
        const chunk = buffer.subarray(i, i + chunkSize);
        const arrayBuffer = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
        await this.sttSocket.send(arrayBuffer as ArrayBuffer);
      }
      await this.sttSocket.finalize();
    });
  }

  async *llm(text: string, persona: string) {
    console.log("llm->input", text);
    this.input.push({ role: "user", content: text });
    const startTime = Date.now();
    const chunks = await this.openai.responses.create({
      model: "gpt-4.1-nano-2025-04-14",
      instructions: injectVariables(this.instructions, {
        knowledgeCutoff: "2025-04-14",
        currentDate: new Date().toISOString().slice(0, 10),
        difficulty: "Easy",
        persona,
      }),
      input: [{ role: "system", content: "" }, ...this.input],
      stream: true,
    });

    const index = this.input.push({ role: "assistant", content: "" }) - 1;
    let parts = 0;
    for await (const chunk of chunks) {
      if (this.stopped) break;
      if (chunk.type !== "response.output_text.delta") continue;
      if (parts === 0) {
        console.log("llm (first chunk):", Date.now() - startTime);
      }
      parts++;
      yield { type: "part", data: chunk.delta } as const;
      this.input[index].content += chunk.delta;
    }
    console.log("llm:", Date.now() - startTime);
    console.log("llm->output", this.input[index].content);
    yield { type: "final", data: this.input[index].content } as const;
  }

  async *tts(text: string, contextId: string, first: boolean) {
    const startTime = Date.now();
    const response = await this.ttsSocket.send({
      contextId,
      modelId: "sonic-2",
      voice: {
        mode: "id",
        id: "031851ba-cc34-422d-bfdb-cdbb7f4651ee",
      },
      transcript: text,
      continue: !first,
    });

    let firstChunk = true;
    for await (const message of response.events("message")) {
      if (this.stopped) break;
      const json = JSON.parse(message);
      if (json.type === "chunk") {
        if (firstChunk) {
          firstChunk = false;
          console.log("tts first chunk:", Date.now() - startTime);
        }
        const buf = Buffer.from(json.data, "base64");

        // record each assistant TTS chunk
        this.audioChunks.push({
          role: "assistant",
          data: buf,
          sampleRate: this.ttsSampleRate,
        });

        yield { type: "part", data: buf } as const;
      }
    }
    console.log("tts:", Date.now() - startTime);
  }

  async run(ws: WSContext<WebSocket>, buffer: Buffer<ArrayBufferLike>, persona: string) {
    const text = await this.stt(buffer);
    const chunks = this.llm(text, persona);
    const contextId = crypto.randomUUID();
    const sentenceBoundary = /(?<=[.?!])\s+/;
    let llmBuffer = "";
    const sentences: string[] = [];

    for await (const chunk of chunks) {
      if (chunk.type !== "part") continue;
      llmBuffer += chunk.data;
      const parts = llmBuffer.split(sentenceBoundary);
      llmBuffer = parts.pop() ?? "";
      for (const part of parts) {
        const sentence = part.trim();
        if (sentence) sentences.push(sentence);
      }
      if (sentences.length > 0) {
        const lines = [...sentences];
        sentences.length = 0;
        for (const line of lines) {
          for await (const ttsChunk of this.tts(line, contextId, true)) {
            ws.send(ttsChunk.data);
          }
        }
      }
    }

    if (llmBuffer.trim()) sentences.push(llmBuffer.trim());
    if (sentences.length > 0) {
      for (const sentence of sentences) {
        for await (const ttsChunk of this.tts(sentence, contextId, true)) {
          ws.send(ttsChunk.data);
        }
      }
    }

    ws.send(JSON.stringify({ event: "endOfTts" }));
  }

  private resamplePCM16(buf: Buffer, srcRate: number, dstRate: number) {
    if (srcRate === dstRate) return buf;
    const srcSamples = buf.length / 2;
    const dstSamples = Math.floor((srcSamples * dstRate) / srcRate);
    const out = Buffer.alloc(dstSamples * 2);
    for (let i = 0; i < dstSamples; i++) {
      const srcIndex = Math.floor((i * srcRate) / dstRate);
      const sample = buf.readInt16LE(srcIndex * 2);
      out.writeInt16LE(sample, i * 2);
    }
    return out;
  }

  public getCombinedAudioWav(outputRate = this.ttsSampleRate) {
    if (this.audioChunks.length === 0) {
      return null;
    }
    // WAV header constants
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = outputRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    // resample each chunk to `outputRate`
    const pcmBuffers = this.audioChunks.map(({ data, sampleRate }) => this.resamplePCM16(data, sampleRate, outputRate));
    const pcmData = Buffer.concat(pcmBuffers);
    const dataSize = pcmData.length;
    // build WAV header
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(outputRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write("data", 36);
    header.writeUInt32LE(dataSize, 40);
    return Buffer.concat([header, pcmData]);
  }
}
