import fs from "node:fs";
import path from "node:path";
import Pipeline from "~/pipeline.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createNodeWebSocket } from "@hono/node-ws";
import { serve } from "@hono/node-server";
import config from "./config.ts";

const app = new Hono();
app.use(cors());
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

const dataDir = path.join(import.meta.dirname, "..", "data");

app.get(
  "/ws",
  upgradeWebSocket(() => {
    const pipeline = new Pipeline();
    return {
      onOpen(event, ws) {
        console.log("WebSocket connection opened", event);
      },
      async onMessage(event, ws) {
        const startTime = Date.now();
        const arrayBuffer = event.data as ArrayBuffer;
        const base64Audio = Buffer.from(arrayBuffer);
        const text = await pipeline.stt(base64Audio);
        const response = await pipeline.llm(text);
        await pipeline.ttsStream(response, ws);
        console.log("Execution time", Date.now() - startTime);
      },
      onClose(event, ws) {
        console.log("WebSocket connection closed", event);
      },
      onError(event, ws) {
        console.error("WebSocket error", event);
      },
    };
  }),
);

const server = serve({ ...app, port: config.port });
injectWebSocket(server);

server.on("error", (err) => console.error(err)).on("listening", () => console.log(`Listening on port ${config.port}`));
