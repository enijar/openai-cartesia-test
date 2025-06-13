import React from "react";
import { MicVAD } from "@ricky0123/vad-web";
import * as Style from "~/components/call/call.style";

// Remove annoying ONNX warnings
const warn = console.warn;
console.warn = (...data: any[]) => {
  warn(...data.filter((item) => !item.includes("W:onnxruntime")));
};

type Props = {
  onStart(): void;
  onStop(): void;
  onSpeechStart(): void;
  onSpeechEnd(audio: Float32Array<ArrayBufferLike>): void;
};

export default function VAD(props: Props) {
  const [loading, setLoading] = React.useState(true);
  const [started, setStarted] = React.useState(false);
  const vadRef = React.useRef<MicVAD>(null);
  React.useEffect(() => {
    MicVAD.new({
      model: "v5",
      onSpeechStart() {
        props.onSpeechStart();
      },
      onSpeechEnd(audio) {
        props.onSpeechEnd(audio);
      },
    })
      .then((vad) => {
        vadRef.current = vad;
        setLoading(false);
      })
      // todo: show an error in the UI, informing the user to allow microphone access
      .catch(console.error);
  }, []);

  // Clean-up memory
  React.useEffect(() => {
    return () => vadRef.current?.destroy();
  }, []);

  if (loading) {
    return <>Waiting for microphone access...</>;
  }

  return (
    <Style.Buttons>
      {started ? (
        <button
          onClick={() => {
            vadRef.current?.pause();
            setStarted(false);
            props.onStop();
          }}
        >
          Stop
        </button>
      ) : (
        <button
          onClick={() => {
            vadRef.current?.start();
            setStarted(true);
            props.onStart();
          }}
        >
          Start
        </button>
      )}
    </Style.Buttons>
  );
}
