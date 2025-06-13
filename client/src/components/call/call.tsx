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
      async (event) => {
        const blob = new Blob([event.data], { type: "audio/wav" });
        try {
          audioQueue.push(await audioContext.decodeAudioData(await blob.arrayBuffer()));
          playNext();
        } catch (err) {
          console.error("Decode failed:", err);
        }
      },
      { signal: controller.signal },
    );
    // todo: handle error
    socket.addEventListener("error", console.error, { signal: controller.signal });
    let timeout: NodeJS.Timeout;
    socket.addEventListener(
      "close",
      () => {
        console.warn("WebSocket closed, try reconnecting...");
        timeout = setTimeout(() => {
          setReconnectKey((reconnectKey) => (reconnectKey + 1) % 1000);
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
          console.log("onStart");
          setStarted(true);
        }}
        onStop={() => {
          console.log("onStop");
          audioContext.close().catch(console.error);
          setStarted(false);
        }}
        onSpeechStart={() => {
          console.log("onSpeechStart");
        }}
        onSpeechEnd={(audio) => {
          console.log("onSpeechEnd->audio", audio);
          if (socket.readyState !== WebSocket.OPEN) return;
          const int16 = new Int16Array(audio.length);
          for (let i = 0; i < audio.length; i++) {
            const s = Math.max(-1, Math.min(1, audio[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          const pcm = new Uint8Array(int16.buffer);
          console.log("Sending data via WebSocket");
          socket.send(pcm);
        }}
      />
    </Style.Wrapper>
  );
}
