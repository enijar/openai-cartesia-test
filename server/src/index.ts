import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createNodeWebSocket } from "@hono/node-ws";
import { serve } from "@hono/node-server";
import { z } from "zod";
import config from "./config.ts";
import Pipeline from "~/pipeline.js";

const app = new Hono();
app.use(cors());
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

const callInstructions = await fs.promises.readFile(
  path.join(import.meta.dirname, "..", "prompts", "call.md"),
  "utf-8",
);

const jsonSchema = z.object({
  event: z.enum(["stopTts", "endCall"]),
});

app.get(
  "/ws",
  upgradeWebSocket(() => {
    const pipeline = new Pipeline(callInstructions);
    return {
      async onMessage(event, ws) {
        if (typeof event.data === "string") {
          try {
            console.log("event.data", event.data);
            const data = jsonSchema.parse(JSON.parse(event.data));
            console.log("data", data);
            switch (data.event) {
              case "stopTts":
                pipeline.stop();
                break;
              case "endCall":
                console.log("call ended");
                pipeline.stop();
                await fs.promises.writeFile(
                  path.join(import.meta.dirname, "..", "data", "call.wav"),
                  await pipeline.getCombinedAudioWav(),
                );
                pipeline.end();
                break;
            }
          } catch (err) {
            console.error(err);
          }
          return;
        }
        const startTime = Date.now();
        pipeline.start();
        const aiModel = "openai"; // "claude", "openai" or "gemini"
        await pipeline.run(
          ws,
          Buffer.from(event.data as ArrayBufferLike),
          await fs.promises.readFile(path.join(import.meta.dirname, "..", "prompts", "example-persona.md"), "utf-8"),
          aiModel,
        );
        console.log("Execution time", Date.now() - startTime);
        // const text = await pipeline.stt(Buffer.from(event.data as ArrayBufferLike));
        // const response = await pipeline.llm(text);
        // await pipeline.tts(response, ws);
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
