import React from "react";
import * as Style from "~/components/call/call.style";
import VAD from "~/components/call/vad";
import AudioPlayer from "~/components/call/audio-player";

export default function Call() {
  const [playing, setPlaying] = React.useState(false);
  const playerRef = React.useRef<AudioPlayer>(null);
  const wsRef = React.useRef<WebSocket | null>(null);

  // 1) One‐time AudioPlayer setup
  React.useEffect(() => {
    const p = new AudioPlayer(16000, 10);
    playerRef.current = p;
    p.init().catch(console.error);
    return () => {
      p.pause().catch(() => {});
    };
  }, []);

  // 2) Open WS once, stay open
  React.useEffect(() => {
    const ws = new WebSocket("ws://localhost:8080/ws");
    ws.binaryType = "arraybuffer";

    ws.onopen = () => console.log("WebSocket connected");
    ws.onmessage = (evt) => {
      if (typeof evt.data === "string") {
        // control message
        try {
          const msg = JSON.parse(evt.data);
          if (msg.event === "endOfTts") {
            // TTS is done
            setPlaying(false);
          }
        } catch {}
        return;
      }

      // it’s a PCM chunk
      const pcm16 = new Int16Array(evt.data);
      const f32 = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) {
        f32[i] = pcm16[i] / 0x8000;
      }

      const player = playerRef.current!;
      player.enqueue(f32);
      if (!playing) {
        player
          .play()
          .then(() => setPlaying(true))
          .catch(console.error);
      }
    };
    ws.onerror = (err) => console.error("WebSocket error", err);

    wsRef.current = ws;
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, []);

  return (
    <Style.Wrapper>
      <VAD
        onStart={() => {}}
        onStop={() => {
          console.log("call ended");
          playerRef.current?.pause().catch(console.error);
          wsRef.current?.send(JSON.stringify({ event: "endCall" }));
          setPlaying(false);
        }}
        onSpeechStart={() => {
          // user begins talking → interrupt TTS
          console.log("User started speaking — interrupting TTS");
          wsRef.current?.send(JSON.stringify({ event: "stopTts" }));
          playerRef.current?.stop().catch(console.error);
          setPlaying(false);
        }}
        onSpeechEnd={(recorded) => {
          // send the user’s speech as binary
          const pcm16 = new Int16Array(recorded.length);
          for (let i = 0; i < recorded.length; i++) {
            const s = Math.max(-1, Math.min(1, recorded[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          wsRef.current?.send(pcm16.buffer);
          // server will start streaming TTS back on the same WS
        }}
      />
    </Style.Wrapper>
  );
}
