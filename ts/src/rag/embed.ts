// Sentence embeddings on the CPU through ONNX Runtime. The model is a 23 MB
// quantised MiniLM; no GPU and no network once the file is cached.
import { Embeddings } from "@langchain/core/embeddings";
import { config } from "../config.js";

export class LocalEmbeddings extends Embeddings {
  private extractor?: Promise<any>;

  constructor(private readonly model: string = config.embedModel) {
    super({});
  }

  private load(): Promise<any> {
    // Imported lazily: agents that never embed should not pay for ONNX
    // Runtime.
    this.extractor ??= import("@huggingface/transformers").then((t) =>
      t.pipeline("feature-extraction", this.model, { dtype: "q8" }),
    );
    return this.extractor;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.load();
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 16) {
      const tensor = await extractor(texts.slice(i, i + 16), {
        pooling: "mean",
        normalize: true,
      });
      out.push(...(tensor.tolist() as number[][]));
    }
    return out;
  }

  async embedQuery(text: string): Promise<number[]> {
    return (await this.embedDocuments([text]))[0] ?? [];
  }
}
