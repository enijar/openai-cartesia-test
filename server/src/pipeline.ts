import { OpenAI } from "openai";
import { ResponseInput } from "openai/resources/responses/responses";
import { CartesiaClient } from "@cartesia/cartesia-js";
import config from "~/config.js";

export default class Pipeline {
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
  private input: ResponseInput = [];

  private pcmToWav(pcmBytes: Uint8Array<ArrayBuffer>, sampleRate = 16000, numChannels = 1) {
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
        const chunk = buffer.subarray(i, i + chunkSize);
        const arrayBuffer = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
        await this.sttSocket.send(arrayBuffer as ArrayBuffer);
      }
      await this.sttSocket.finalize();
    });
  }

  async llm(text: string) {
    this.input.push({ role: "user", content: text });
    console.log(this.input);
    const startTime = Date.now();
    const response = await this.openai.responses.create({
      model: "gpt-4.1-nano-2025-04-14",
      instructions: "You are a friendly assistant.",
      input: this.input,
    });
    console.log("llm:", Date.now() - startTime);
    this.input.push({ role: "assistant", content: response.output_text });
    return response.output_text;
  }

  async tts(text: string) {
    const startTime = Date.now();
    let gotFirstChunk = false;
    const response = await this.ttsSocket.send({
      modelId: "sonic-2",
      voice: {
        mode: "id",
        id: "a0e99841-438c-4a64-b679-ae501e7d6091",
      },
      transcript: text,
    });
    const chunks: Buffer[] = [];
    for await (const message of response.events("message")) {
      const json = JSON.parse(message);
      switch (json.type) {
        case "chunk":
          if (!gotFirstChunk) {
            gotFirstChunk = true;
            console.log("tts first chunk:", Date.now() - startTime);
          }
          const pcm = Buffer.from(json.data, "base64");
          chunks.push(pcm);
          break;
      }
    }
    console.log("tts:", Date.now() - startTime);
    return Buffer.from(await this.pcmToWav(Buffer.concat(chunks), 44100, 1).arrayBuffer());
  }

  async ttsStream(text: string, ws: any) {
    const startTime = Date.now();
    const response = await this.ttsSocket.send({
      modelId: "sonic-2",
      voice: {
        mode: "id",
        id: "a0e99841-438c-4a64-b679-ae501e7d6091",
      },
      transcript: text,
    });
    let firstChunk = true;
    for await (const message of response.events("message")) {
      const json = JSON.parse(message);
      switch (json.type) {
        case "chunk":
          if (firstChunk) {
            firstChunk = false;
            console.log("tts first chunk:", Date.now() - startTime);
          }
          const pcm = Buffer.from(json.data, "base64");
          const wav = this.pcmToWav(pcm, 44100, 1);
          ws.send(await wav.arrayBuffer());
          break;
      }
    }
    console.log("tts:", Date.now() - startTime);
  }
}
