import { cost } from "../providers/pricing.js";
import type { Bus } from "./bus.js";

// Running totals for the status line.
export class Stats {
  input = 0; // all prompt tokens sent, cached or not
  output = 0;
  cost = 0; // USD, for calls whose price is known
  unpriced = 0; // calls with no known price
  context = 0; // size of the most recent request plus its reply
  errors = 0; // a refusal another model answered is not one

  constructor(bus: Bus) {
    bus.on("usage", ({ provider, usage, priceKnown }) => {
      const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
      this.input += prompt;
      this.output += usage.output;
      this.context = prompt + usage.output;
      const c = priceKnown === false ? null : cost(provider, usage);
      if (c === null) this.unpriced++;
      else this.cost += c;
    });
    bus.on("error", (e) => {
      if (e.kind !== "fallback") this.errors++;
    });
  }

  get costUnknown(): boolean {
    return this.unpriced > 0;
  }
}
