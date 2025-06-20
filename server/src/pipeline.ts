import crypto from "node:crypto";
import type { WSContext } from "hono/ws";
import config from "~/config.js";
import Audio from "~/audio.js";
import { LLMService } from "~/services/llm.ts";
import { STTService } from "~/services/sst.ts";
import { TTSService } from "~/services/tts.ts";

export default class Pipeline {
  private stopped = false;
  private audio = new Audio();
  // keep a chronological list of all audio buffers
  // we store sampleRate here so you can sanity-check later if needed
  private audioChunks: Array<{ role: "user" | "assistant" | "model"; data: Buffer }> = [];
  private llmService?: LLMService;
  private sttService = new STTService({
    apiKey: config.cartesiaKey,
    shouldStop: () => this.isStopped(),
    audioChunks: this.audioChunks,
  });
  private ttsService = new TTSService({
    apiKey: config.cartesiaKey,
    shouldStop: () => this.isStopped(),
    audioChunks: this.audioChunks,
  });

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

  isStopped() {
    return this.stopped;
  }

  async run(
    ws: WSContext<WebSocket>,
    buffer: Buffer<ArrayBufferLike>,
    persona: string,
    modelName: "claude" | "openai" | "gemini",
  ) {
    const text = await this.sttService.transcribe(buffer);

    if (!text.trim()) {
      const contextId = crypto.randomUUID();
      for await (const ttsChunk of this.ttsService.speak(
        "I'm sorry, I'm not following. Could you say that again?",
        contextId,
        true,
      )) {
        ws.send(ttsChunk.data);
      }
      ws.send(JSON.stringify({ event: "endOfTts" }));
      return;
    }

    this.llmService = new LLMService({
      openaiKey: config.openaiKey,
      anthropicKey: config.anthropicKey,
      geminiKey: config.geminiKey,
      instructions: this.instructions,
      shouldStop: () => this.isStopped(),
    });

    const llm = this.llmService.getLLM(modelName);
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
          for await (const ttsChunk of this.ttsService.speak(line, contextId, true)) {
            ws.send(ttsChunk.data);
          }
        }
      }
    }

    if (llmBuffer.trim()) sentences.push(llmBuffer.trim());
    if (sentences.length > 0) {
      for (const sentence of sentences) {
        for await (const ttsChunk of this.ttsService.speak(sentence, contextId, true)) {
          ws.send(ttsChunk.data);
        }
      }
    }

    ws.send(JSON.stringify({ event: "endOfTts" }));
  }

  async getCombinedAudioWav() {
    const audioChunks = await this.sttService.getAudioChunks();
    return await this.audio.pcmToWav(audioChunks);
  }
}
