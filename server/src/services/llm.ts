import { OpenAI } from "openai";
import { Anthropic } from "@anthropic-ai/sdk";
import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from "@google/genai";
import { injectVariables } from "~/utils.js";

type LLMModel = "openai" | "claude" | "gemini";

export interface LLMConfig {
  openaiKey: string | undefined;
  anthropicKey: string | undefined;
  geminiKey: string | undefined;
  instructions: string;
  shouldStop: () => boolean;
}

export interface LLMMessage {
  role: "user" | "assistant" | "model";
  content: string;
}

interface GeminiMessage {
  role: "user" | "model";
  parts: { text: string }[];
}

type LLMProvider = (
  text: string,
  persona: string,
) => AsyncGenerator<{ type: "part" | "final"; data: string }, void, unknown>;

export class LLMService {
  private openai: OpenAI;
  private anthropic: Anthropic;
  private gemini: GoogleGenAI;
  private instructions: string;
  private input: Array<LLMMessage> = [];

  constructor(private config: LLMConfig) {
    this.openai = new OpenAI({ apiKey: this.config.openaiKey });
    this.anthropic = new Anthropic({ apiKey: this.config.anthropicKey });
    this.gemini = new GoogleGenAI({ apiKey: this.config.geminiKey });
    this.instructions = this.config.instructions;
  }

  getLLM(model: LLMModel): LLMProvider {
    switch (model) {
      case "openai":
        return this.llmOpenAi.bind(this);
      case "claude":
        return this.llmnAnthropic.bind(this);
      case "gemini":
        return this.llmnGemini.bind(this);
      default:
        return this.llmOpenAi.bind(this);
    }
  }

  async *llmOpenAi(text: string, persona: string) {
    console.log("llm->input", text);
    this.input.push({ role: "user", content: text });
    const startTime = Date.now();
    const chunks = await this.openai.responses.create({
      model: "gpt-4.1-nano-2025-04-14",
      instructions: injectVariables(this.instructions, {
        knowledgeCutoff: "2025-04-14",
        currentDate: new Date().toISOString().slice(0, 10),
        difficulty: "Easy",
        persona,
      }),
      input: [
        { role: "system", content: "" },
        ...this.input
          .filter((msg) => msg.role === "user" || msg.role === "assistant")
          .map((msg) => ({
            role: msg.role as "user" | "assistant",
            content: msg.content,
          })),
      ],
      stream: true,
    });

    const index = this.input.push({ role: "assistant", content: "" }) - 1;
    let parts = 0;
    for await (const chunk of chunks) {
      if (this.config.shouldStop()) break;
      if (chunk.type !== "response.output_text.delta") continue;
      if (parts === 0) {
        console.log("llm (first chunk):", Date.now() - startTime);
      }
      parts++;
      yield { type: "part", data: chunk.delta } as const;
      this.input[index].content += chunk.delta;
    }
    console.log("llm:", Date.now() - startTime);
    console.log("llm->output", this.input[index].content);
    yield { type: "final", data: this.input[index].content } as const;
  }

  async *llmnAnthropic(text: string, persona: string) {
    console.log("llm->input", text);
    this.input.push({ role: "user", content: text });
    const startTime = Date.now();

    const claudeMessages = [
      {
        role: "user" as const,
        content: injectVariables(this.instructions, {
          knowledgeCutoff: "2025-04-14",
          currentDate: new Date().toISOString().slice(0, 10),
          difficulty: "Easy",
          persona,
        }),
      },
      ...this.input.map(({ role, content }) => ({
        role: role as "user" | "assistant",
        content,
      })),
    ];
    const chunks = await this.anthropic.messages.stream({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 1024,
      messages: claudeMessages,
    });

    const index = this.input.push({ role: "assistant", content: "" }) - 1;
    let parts = 0;
    for await (const chunk of chunks) {
      if (this.config.shouldStop()) break;
      let delta: string | undefined;
      if (
        chunk.type === "content_block_delta" &&
        chunk.delta &&
        typeof chunk.delta === "object" &&
        "text" in chunk.delta
      ) {
        delta = chunk.delta.text;
      }
      if (!delta) continue;

      if (parts === 0) {
        console.log("llm (first chunk):", Date.now() - startTime);
      }
      parts++;
      yield { type: "part", data: delta } as const;
      this.input[index].content += delta;
    }
    console.log("llm:", Date.now() - startTime);
    console.log("llm->output", this.input[index].content);
    yield { type: "final", data: this.input[index].content } as const;
  }

  async *llmnGemini(text: string, persona: string) {
    console.log("llm->input", text);
    this.input.push({ role: "user", content: text });
    const startTime = Date.now();
    const config = {
      maxOutputTokens: 4096,
      temperature: 0.35,
      topP: 1,
      seed: 0,
      safetySettings: [
        {
          category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
          threshold: HarmBlockThreshold.BLOCK_NONE,
        },
        {
          category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
          threshold: HarmBlockThreshold.BLOCK_NONE,
        },
        {
          category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
          threshold: HarmBlockThreshold.BLOCK_NONE,
        },
        {
          category: HarmCategory.HARM_CATEGORY_HARASSMENT,
          threshold: HarmBlockThreshold.BLOCK_NONE,
        },
      ],
      systemInstruction: {
        role: "model",
        parts: [
          {
            text: injectVariables(this.instructions, {
              knowledgeCutoff: "2025-04-14",
              currentDate: new Date().toISOString().slice(0, 10),
              difficulty: "Easy",
              persona,
            }),
          },
        ],
      },
    };

    const contents: GeminiMessage[] = [
      ...this.input.map(
        (msg) =>
          ({
            role: msg.role as "user" | "model",
            parts: [{ text: msg.content }],
          }) as GeminiMessage,
      ),
    ];

    const chunks = await this.gemini.models.generateContentStream({
      model: "gemini-2.0-flash-lite-001", // or gemini-2.5-pro-preview-06-05
      contents: contents,
      config: config,
    });

    const index = this.input.push({ role: "model", content: "" }) - 1;
    let parts = 0;
    for await (const chunk of chunks) {
      if (this.config.shouldStop()) break;

      if (parts === 0) {
        console.log("llm (first chunk):", Date.now() - startTime);
      }

      if (typeof chunk.text !== "string") continue;

      parts++;
      yield { type: "part", data: chunk.text } as { type: "part"; data: string };
      this.input[index].content += chunk.text;
    }
    console.log("llm:", Date.now() - startTime);
    console.log("llm->output", this.input[index].content);
    yield { type: "final", data: this.input[index].content } as const;
  }
}
