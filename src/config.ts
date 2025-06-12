import path from "node:path";
import { config as dotenv } from "dotenv";
import { z } from "zod";

const env = z
  .object({
    OPENAI_KEY: z.string().nonempty(),
    CARTESIA_KEY: z.string().nonempty(),
  })
  .parse(dotenv({ path: path.join(import.meta.dirname, "..", ".env") }).parsed);

const config = {
  openaiKey: env.OPENAI_KEY,
  cartesiaKey: env.CARTESIA_KEY,
};

export default config;
