import { cost } from "../providers/pricing.js";
import type { Bus } from "./bus.js";

// Running totals for the status line.
export class Stats {
  input = 0; // all prompt tokens sent, cached or not
  output = 0;
  cost = 0; // USD, for calls whose price is known
  costUnknown = false; // true once any call had no known price
  context = 0; // size of the most recent request plus its reply
  errors = 0;
  fallbacks = 0; // refusals another model answered; shown, but not counted as errors

  constructor(bus: Bus) {
    bus.on("usage", ({ provider, usage }) => {
      const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
      this.input += prompt;
      this.output += usage.output;
      this.context = prompt + usage.output;
      const c = cost(provider, usage);
      if (c === null) this.costUnknown = true;
      else this.cost += c;
    });
    bus.on("error", (e) => (e.kind === "fallback" ? this.fallbacks++ : this.errors++));
  }
}
