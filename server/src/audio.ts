import { spawn } from "node:child_process";

export default class Audio {
  async pcmToWav(pcmChunks: Buffer[], sampleRate = 16_000, channels = 1): Promise<Buffer> {
    const pcmBuffer = Buffer.concat(pcmChunks);
    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-f",
        "s16le",
        "-ar",
        sampleRate.toString(),
        "-ac",
        channels.toString(),
        "-sample_fmt",
        "flt",
        "-i",
        "pipe:0",
        "-c:a",
        "pcm_f32le",
        "-ar",
        `${sampleRate}`,
        "-ac",
        `${channels}`,
        "-f",
        "wav",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    ffmpeg.stdin.write(pcmBuffer);
    ffmpeg.stdin.end();
    const out: Buffer[] = [];
    ffmpeg.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    await new Promise<void>((resolve, reject) => {
      ffmpeg.on("error", reject);
      ffmpeg.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg exited with ${code ?? "unknown"}`));
        }
      });
    });
    return Buffer.concat(out);
  }
}
