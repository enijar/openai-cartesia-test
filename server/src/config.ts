import path from "node:path";
import { config as dotenv } from "dotenv";
import { z } from "zod";

const env = z
  .object({
    OPENAI_KEY: z.string().nonempty(),
    CARTESIA_KEY: z.string().nonempty(),
    ANTHROPIC_KEY: z.string().nonempty(),
    PORT: z.coerce.number().finite().gte(0).lte(65535),
  })
  .parse(dotenv({ path: path.join(import.meta.dirname, "..", ".env") }).parsed);

const config = {
  openaiKey: env.OPENAI_KEY,
  cartesiaKey: env.CARTESIA_KEY,
  anthropicKey: env.ANTHROPIC_KEY,
  port: env.PORT,
};

export default config;
