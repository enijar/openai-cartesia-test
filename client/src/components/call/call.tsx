import React from "react";
import * as Style from "~/components/call/call.style";
import VAD from "~/components/call/vad";

export default function Call() {
  const [reconnectKey, setReconnectKey] = React.useState(0);
  const socket = React.useMemo(() => new WebSocket("/ws"), [reconnectKey]);
  const [started, setStarted] = React.useState(false);
  const audioContext = React.useMemo(() => new AudioContext(), [started]);

  React.useEffect(() => {
    const controller = new AbortController();
    socket.binaryType = "arraybuffer";
    socket.addEventListener(
      "open",
      () => {
        console.log("WebSocket connection established");
      },
      { signal: controller.signal },
    );
    const audioQueue: AudioBuffer[] = [];
    let playing = false;
    const playNext = () => {
      if (playing) return;
      const buffer = audioQueue.shift();
      if (buffer === undefined) return;
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContext.destination);
      source.onended = () => {
        playing = false;
        playNext();
      };
      source.start();
      playing = true;
    };
    socket.addEventListener(
      "message",
      (event) => {
        // Assume PCM 16-bit little-endian, 1 channel, 44.1kHz
        const pcm16 = new Int16Array(event.data);
        const float32 = new Float32Array(pcm16.length);
        for (let i = 0; i < pcm16.length; i++) {
          float32[i] = pcm16[i] / 0x8000;
        }
        const frameCount = float32.length;
        const audioBuffer = audioContext.createBuffer(1, frameCount, 44100);
        audioBuffer.copyToChannel(float32, 0, 0);
        audioQueue.push(audioBuffer);
        playNext();
      },
      { signal: controller.signal },
    );
    socket.addEventListener("error", console.error, { signal: controller.signal });
    let timeout: NodeJS.Timeout;
    socket.addEventListener(
      "close",
      () => {
        console.warn("WebSocket closed, reconnecting...");
        timeout = setTimeout(() => {
          setReconnectKey((key) => (key + 1) % 1000);
        }, 1000);
      },
      { signal: controller.signal },
    );
    return () => {
      controller.abort();
      audioQueue.length = 0;
      clearTimeout(timeout);
    };
  }, [socket, audioContext]);

  return (
    <Style.Wrapper>
      <VAD
        onStart={() => {
          setStarted(true);
        }}
        onStop={() => {
          audioContext.close().catch(console.error);
          setStarted(false);
        }}
        onSpeechStart={() => {
          console.log("Speech started");
        }}
        onSpeechEnd={(audio) => {
          if (socket.readyState !== WebSocket.OPEN) return;
          const int16 = new Int16Array(audio.length);
          for (let i = 0; i < audio.length; i++) {
            const s = Math.max(-1, Math.min(1, audio[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          socket.send(new Uint8Array(int16.buffer));
        }}
      />
    </Style.Wrapper>
  );
}
