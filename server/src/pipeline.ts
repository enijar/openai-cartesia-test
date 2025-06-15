import crypto from "node:crypto";
import { OpenAI } from "openai";
import { CartesiaClient } from "@cartesia/cartesia-js";
import type { WSContext } from "hono/ws";
import config from "~/config.js";

export default class Pipeline {
  private stopped = false;
  private openai = new OpenAI({ apiKey: config.openaiKey });
  private cartesia = new CartesiaClient({ apiKey: config.cartesiaKey });
  private sttSocket = this.cartesia.stt.websocket({
    model: "ink-whisper",
    language: "en",
    encoding: "pcm_s16le",
    sampleRate: 16000,
  });
  private ttsSocket = this.cartesia.tts.websocket({
    container: "raw",
    encoding: "pcm_s16le",
    sampleRate: 44100,
  });
  private input: Array<{ role: "user" | "assistant"; content: string }> = [];

  constructor(private instructions: string) {}

  stop() {
    this.stopped = true;
  }

  start() {
    this.stopped = false;
  }

  stt(buffer: Buffer<ArrayBufferLike>) {
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
            resolve(parts.join("").trim());
            console.log("stt:", Date.now() - startTime);
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

  async *llm(text: string) {
    console.log("llm->input", text);
    this.input.push({ role: "user", content: text });
    const startTime = Date.now();
    const chunks = await this.openai.responses.create({
      model: "gpt-4.1-nano-2025-04-14",
      instructions: this.instructions,
      input: this.input,
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
    // return this.input[index].content;
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
      switch (json.type) {
        case "chunk":
          if (firstChunk) {
            firstChunk = false;
            console.log("tts first chunk:", Date.now() - startTime);
          }
          // ws.send(Buffer.from(json.data, "base64"));
          yield { type: "part", data: Buffer.from(json.data, "base64") } as const;
          break;
      }
    }
    console.log("tts:", Date.now() - startTime);
    // ws.send(JSON.stringify({ event: "endOfTts" }));
  }

  async run(ws: WSContext<WebSocket>, buffer: Buffer<ArrayBufferLike>) {
    const text = await this.stt(buffer);
    const chunks = this.llm(text);
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
          const chunks = this.tts(line, contextId, true);
          for await (const chunk of chunks) {
            ws.send(chunk.data);
          }
        }
      }
    }
    if (llmBuffer.length > 0) {
      const remaining = llmBuffer.trim();
      if (remaining) sentences.push(remaining);
    }
    if (sentences.length > 0) {
      for (const sentence of sentences) {
        const chunks = this.tts(sentence, contextId, true);
        for await (const chunk of chunks) {
          ws.send(chunk.data);
        }
      }
    }
    ws.send(JSON.stringify({ event: "endOfTts" }));
  }
}
