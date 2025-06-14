import Pipeline from "~/pipeline.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createNodeWebSocket } from "@hono/node-ws";
import { serve } from "@hono/node-server";
import config from "./config.ts";

const app = new Hono();
app.use(cors());
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.get(
  "/ws",
  upgradeWebSocket(() => {
    const pipeline = new Pipeline();
    return {
      async onMessage(event, ws) {
        if (typeof event.data === "string") {
          try {
            const json = JSON.parse(event.data);
            if (json.event === "stopTts") {
              pipeline.stop();
            }
          } catch {}
          return;
        }
        const startTime = Date.now();
        pipeline.start();
        const text = await pipeline.stt(Buffer.from(event.data as ArrayBufferLike));
        const response = await pipeline.llm(text);
        await pipeline.tts(response, ws);
        console.log("Execution time", Date.now() - startTime);
      },
      onError(event) {
        // todo: handle error
        console.error("WebSocket error", event);
      },
    };
  }),
);

const server = serve({ ...app, port: config.port });
injectWebSocket(server);

server.on("error", (err) => console.error(err)).on("listening", () => console.log(`Listening on port ${config.port}`));
