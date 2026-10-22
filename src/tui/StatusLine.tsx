import { Box, Text } from "ink";

export type Segment = "lead" | "context" | "tokens" | "cost" | "mode" | "errors";
export const SEGMENTS: Segment[] = ["lead", "context", "tokens", "cost", "mode", "errors"];

export interface StatusInfo {
  lead: string;
  context: number;
  contextWindow: number | null;
  input: number;
  output: number;
  cost: number;
  costUnknown: boolean;
  mode: string;
  errors: number;
}

// The unit is picked after rounding, so 999,999 shows as 1.0M, not 1000.0k.
const k = (n: number) => {
  if (n < 1000) return String(n);
  const thousands = (n / 1000).toFixed(1);
  return Number(thousands) < 1000 ? `${thousands}k` : `${(n / 1_000_000).toFixed(1)}M`;
};

export function formatSegment(s: Segment, i: StatusInfo): string {
  switch (s) {
    case "lead":
      return `lead ${i.lead}`;
    case "context":
      return i.contextWindow ? `ctx ${Math.round((100 * i.context) / i.contextWindow)}%` : `ctx ${k(i.context)}`;
    case "tokens":
      return `${k(i.input)} in / ${k(i.output)} out`;
    case "cost":
      return `$${i.cost.toFixed(2)}${i.costUnknown ? " + ?" : ""}`;
    case "mode":
      return `perm ${i.mode}`;
    case "errors":
      return `${i.errors} errors`;
  }
}

export function StatusLine({ info, segments }: { info: StatusInfo; segments: Segment[] }) {
  return (
    <Box>
      {segments.map((s, n) => (
        <Text key={n} inverse color={s === "errors" && info.errors > 0 ? "red" : undefined}>
          {n === 0 ? " " : " | "}
          {formatSegment(s, info)}
          {n === segments.length - 1 ? " " : ""}
        </Text>
      ))}
    </Box>
  );
}
