import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { OpenAI } from "openai";
import { Anthropic } from "@anthropic-ai/sdk";
import { CartesiaClient } from "@cartesia/cartesia-js";
import type { WSContext } from "hono/ws";
import config from "~/config.js";
import Audio from "~/audio.js";
import { injectVariables } from "~/utils.js";

// Define the LLMProvider type
type LLMProvider = (
  text: string,
  persona: string,
) => AsyncGenerator<{ type: "part" | "final"; data: string }, void, unknown>;

export default class Pipeline {
  private stopped = false;
  private openai = new OpenAI({ apiKey: config.openaiKey });
  private anthropic = new Anthropic({ apiKey: config.anthropicKey });
  private cartesia = new CartesiaClient({ apiKey: config.cartesiaKey });
  private audio = new Audio();

  // keep a chronological list of all audio buffers
  // we store sampleRate here so you can sanity-check later if needed
  private audioChunks: Array<{ role: "user" | "assistant"; data: Buffer }> = [];

  private sttSocket = this.cartesia.stt.websocket({
    model: "ink-whisper",
    language: "en",
    encoding: "pcm_s16le",
    sampleRate: 16000,
  });
  private ttsSocket = this.cartesia.tts.websocket({
    container: "raw",
    encoding: "pcm_s16le",
    sampleRate: 16000,
  });

  private input: Array<{ role: "user" | "assistant"; content: string }> = [];

  constructor(private instructions: string) {}

  stop() {
    this.stopped = true;
  }

  start() {
    this.stopped = false;
  }

  end() {
    this.stopped = true;
    // clear out any previously collected audio
    this.audioChunks = [];
  }

  getLLMProvider(modelName: string): LLMProvider {
    switch (modelName) {
      case "claude":
        return this.llmnAnthropic.bind(this);
      case "openai":
        return this.llm.bind(this);
      default:
        return this.llm.bind(this);
    }
  }

  async stt(buffer: Buffer<ArrayBufferLike>) {
    // record the raw user audio buffer
    this.audioChunks.push({ role: "user", data: buffer });

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

  async *llmnAnthropic(text: string, persona: string) {
    console.log("llm->input", text);
    this.input.push({ role: "user", content: text });
    const startTime = Date.now();

    const claudeMessages = [
      {
        role: "user" as const,
        content: injectVariables(this.instructions, {
          knowledgeCutoff: "2025-04-14",
          currentDate: new Date().toISOString().slice(0, 10),
          difficulty: "Easy",
          persona,
        }),
      },
      ...this.input.map(({ role, content }) => ({
        role: role as "user" | "assistant",
        content,
      })),
    ];
    const chunks = await this.anthropic.messages.stream({
      model: "claude-opus-4-20250514",
      max_tokens: 1024,
      messages: claudeMessages,
    });

    const index = this.input.push({ role: "assistant", content: "" }) - 1;
    let parts = 0;
    for await (const chunk of chunks) {
      if (this.stopped) break;
      let delta: string | undefined;
      if (
        chunk.type === "content_block_delta" &&
        chunk.delta &&
        typeof chunk.delta === "object" &&
        "text" in chunk.delta
      ) {
        delta = chunk.delta.text;
      }
      if (!delta) continue;

      if (parts === 0) {
        console.log("llm (first chunk):", Date.now() - startTime);
      }
      parts++;
      yield { type: "part", data: delta } as const;
      this.input[index].content += delta;
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
        const buffer = Buffer.from(json.data, "base64");

        // record each assistant TTS chunk
        this.audioChunks.push({ role: "assistant", data: buffer });

        yield { type: "part", data: buffer } as const;
      }
    }
    console.log("tts:", Date.now() - startTime);
  }

  async run(
    ws: WSContext<WebSocket>,
    buffer: Buffer<ArrayBufferLike>,
    persona: string,
    modelName: "claude" | "openai",
  ) {
    const text = await this.stt(buffer);
    // const chunks = this.llm(text, persona);
    // const chunks = this.llmnAnthropic(text, persona);
    const llm = this.getLLMProvider(modelName);
    const chunks = llm(text, persona);
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

  async getCombinedAudioWav() {
    return await this.audio.pcmToWav(this.audioChunks.map((chunk) => chunk.data));
  }
}
