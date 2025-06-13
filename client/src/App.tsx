import React, { useEffect, useState, useRef } from "react";
import { getDefaultReactRealTimeVADOptions, useMicVAD, utils } from "@ricky0123/vad-react";

const vadOptions = {
  ...getDefaultReactRealTimeVADOptions("legacy"),
  positiveSpeechThreshold: 0.85, // ↑ sensitivity to human voice (default is 0.6)
  negativeSpeechThreshold: 0.15, // ↓ Lower tolerance for background noise  (default 0.4)
  minSpeechFrames: 2, // ↑ Require speech to last for x consecutive frames before detecting as speaking (default 5)
  redemptionFrames: 6, // ↑ Capture a few extra frames before ending speech detection to avoid flickering (default 10)
  userSpeakingThreshold: 0.8, // ↑ default 0.6
  startOnLoad: true,
  submitUserSpeechOnPause: true,
};

export default function App() {
  // const [segments, setSegments] = useState<string[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const lastAudioURLRef = useRef<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);

  interface AudioEvent extends Event {
    data: ArrayBuffer;
  }

  const vad = useMicVAD({
    ...vadOptions,
    onSpeechStart: () => {
      console.log("User is speaking");

      if (currentAudioRef.current) {
        currentAudioRef.current.pause();
        currentAudioRef.current.currentTime = 0;
        console.log("AI audio interrupted");
      }
    },
    onSpeechEnd: (audio) => {
      console.log("🛑 End");

      const int16 = new Int16Array(audio.length);
      for (let i = 0; i < audio.length; i++) {
        const s = Math.max(-1, Math.min(1, audio[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      const pcm = new Uint8Array(int16.buffer);

      if (wsRef.current) {
        console.log("Sending data via WebSocket");

        wsRef.current.send(pcm);
        setIsStreaming(true);
      } else {
        console.error("WebSocket not connected.");
      }
    },
  });

  useEffect(() => {
    vad.start(); //
    console.log("VAD started");

    wsRef.current = new WebSocket("ws://localhost:3000/ws");
    wsRef.current.binaryType = "arraybuffer";
    wsRef.current.onopen = async () => {
      console.log("WebSocket connection established");
    };

    const audioQueue: AudioBuffer[] = [];
    let isPlaying = false;
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();

    wsRef.current.onmessage = async (event) => {
      const blob = new Blob([event.data], { type: "audio/wav" });
      const arrayBuffer = await blob.arrayBuffer();
      try {
        const buffer = await audioContext.decodeAudioData(arrayBuffer);
        audioQueue.push(buffer);
        playNext();
      } catch (err) {
        console.error("Decode failed:", err);
      }
    };

    function playNext() {
      if (isPlaying || audioQueue.length === 0) return setIsStreaming(false);

      const buffer = audioQueue.shift()!;
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContext.destination);

      source.onended = () => {
        isPlaying = false;
        playNext();
      };

      source.start();
      isPlaying = true;
    }

    wsRef.current.onerror = (err) => {
      console.error("WebSocket error:", err);
    };

    wsRef.current.onclose = () => {
      console.warn("WebSocket closed, try reconnecting...");
      // TODO: Implement reconnection logic
    };

    return () => {
      vad.pause();
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  return (
    <div style={{ padding: 20 }}>
      <h1>VAD</h1>
      <p>Status: {isStreaming ? "Responding..." : "Listening"}</p>
      <button
        onClick={() => {
          vad.start();
          if (typeof AudioContext !== "undefined") {
            const ctx = new AudioContext();
            ctx.resume();
          }
        }}
      >
        Start
      </button>

      <button onClick={() => vad.pause()}>Pause</button>
    </div>
  );
}
