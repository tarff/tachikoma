import type { ElicitRequestFormParams, ElicitRequestURLParams } from "@modelcontextprotocol/client";
import type { Bus } from "../core/bus.js";
import { type Owner, visible } from "../core/permissions.js";
import type { Hooks } from "../hooks/hooks.js";

// A form a server asks for (release 8c plan, Task 12; design, "Forms a server asks for"; choices 29 and 35): Elicitation
// hooks first, then the window's questions, a field at a time, then ElicitationResult hooks. -p declines every form.

export type Form = ElicitRequestFormParams | ElicitRequestURLParams;
type Value = string | number | boolean | string[];
export type Answer = { action: "accept" | "decline" | "cancel"; content?: Record<string, Value> };
// What a Server calls with each form it is sent: `owner`, the subagent whose call the form came in, if it was one's.
export type FormHandler = (form: Form, ctx: { owner?: Owner; signal: AbortSignal }) => Promise<Answer>;

// One field as it is asked: `question`, the plan's words for it, escaped; `note`, the server's description of it, escaped;
// `start`, what the field starts with, its default. A pick's labels are the server's own, which the menu escapes.
export type Field = { name: string; question: string; note?: string; required: boolean } & (
  | { kind: "text"; start: string }
  | { kind: "number"; integer: boolean; minimum?: number; maximum?: number; start: string }
  | { kind: "yes or no"; start: string }
  | { kind: "pick"; multi: boolean; options: { value: string; label: string }[]; start: string[] }
);

// The window's questions (App.tsx): `field` gives what was typed, or the values picked, or null for Esc or a stop of
// `signal`; `given`, what the field was last answered with, when it is asked again after a wrong answer. `visit` is the
// window's own yes or no.
export interface FormUI {
  field(field: Field, given: string | string[] | undefined, signal: AbortSignal): Promise<string | string[] | null>;
  visit(question: string, owner: Owner | undefined): Promise<boolean>;
}

// "Lines this plan adds", Forms.
const NOT_A_NUMBER = "That is not a number; type one, or Esc to decline the form.";
const NOT_YES_OR_NO = "That is not yes or no; type y or n, or Esc to decline the form.";
const NEEDED = "This field is needed; type an answer, or Esc to decline the form.";
const NOT_WHOLE = "That is not a whole number; type one, or Esc to decline the form.";
const under = (n: number) => `That is under ${n}; type ${n} or more, or Esc to decline the form.`;
const over = (n: number) => `That is over ${n}; type ${n} or less, or Esc to decline the form.`;

const shown = (text: string) => visible(text, { tabs: true });

// The fields of a form's schema, in its order, each kind MCP allows (the library's PrimitiveSchemaDefinition): a list of
// values (`enum`, with the old `enumNames` as labels, or `oneOf` with titles) is a pick, an array of them a pick of
// several; the library has checked the schema's shape before the form reaches here.
export function fieldsOf(schema: ElicitRequestFormParams["requestedSchema"]): Field[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, p]): Field => {
    const need = required.has(name);
    const marks = p.type === "number" || p.type === "integer" ? " (a number)" : p.type === "boolean" ? " (yes or no)" : "";
    const question = `${shown(p.title ?? name)}${marks}${need ? "" : " (optional)"}: `;
    const common = { name, question, required: need, ...(p.description && { note: shown(p.description) }) };
    if (p.type === "boolean") return { ...common, kind: "yes or no", start: p.default === undefined ? "" : p.default ? "y" : "n" };
    if (p.type === "number" || p.type === "integer") {
      const limits = { ...(p.minimum !== undefined && { minimum: p.minimum }), ...(p.maximum !== undefined && { maximum: p.maximum }) };
      return { ...common, kind: "number", integer: p.type === "integer", ...limits, start: p.default === undefined ? "" : String(p.default) };
    }
    if (p.type === "array") {
      const items = p.items;
      const options = "enum" in items ? items.enum.map((value) => ({ value, label: value })) : items.anyOf.map((o) => ({ value: o.const, label: o.title }));
      return { ...common, kind: "pick", multi: true, options, start: p.default ?? [] };
    }
    if ("oneOf" in p) {
      const options = p.oneOf.map((o) => ({ value: o.const, label: o.title }));
      return { ...common, kind: "pick", multi: false, options, start: p.default ? [p.default] : [] };
    }
    if ("enum" in p) {
      const labels = "enumNames" in p ? (p.enumNames ?? []) : [];
      const options = p.enum.map((value, i) => ({ value, label: labels[i] ?? value }));
      return { ...common, kind: "pick", multi: false, options, start: p.default ? [p.default] : [] };
    }
    return { ...common, kind: "text", start: typeof p.default === "string" ? p.default : "" };
  });
}

// An answer to one field: its value, none for an empty optional field, which is left out, and how its line shows it; or
// the line saying what is wrong.
export function check(field: Field, given: string | string[]): { value?: Value; shown: string } | { wrong: string } {
  if (field.kind === "pick") {
    const picked = Array.isArray(given) ? given : [given];
    if (!picked.length) return field.required ? { wrong: NEEDED } : { shown: "" };
    const label = (v: string) => field.options.find((o) => o.value === v)?.label ?? v;
    return { value: field.multi ? picked : picked[0]!, shown: picked.map(label).join(", ") };
  }
  const text = Array.isArray(given) ? given.join(", ") : given;
  const typed = field.kind === "text" ? text : text.trim();
  if (typed === "") return field.required ? { wrong: NEEDED } : { shown: "" };
  if (field.kind === "text") return { value: typed, shown: typed };
  if (field.kind === "yes or no") {
    const word = typed.toLowerCase();
    if (word === "y" || word === "yes") return { value: true, shown: typed };
    if (word === "n" || word === "no") return { value: false, shown: typed };
    return { wrong: NOT_YES_OR_NO };
  }
  const n = Number(typed);
  if (!Number.isFinite(n)) return { wrong: NOT_A_NUMBER };
  if (field.integer && !Number.isInteger(n)) return { wrong: NOT_WHOLE };
  if (field.minimum !== undefined && n < field.minimum) return { wrong: under(field.minimum) };
  if (field.maximum !== undefined && n > field.maximum) return { wrong: over(field.maximum) };
  return { value: n, shown: typed };
}

// The forms of every server (Servers holds one): the hooks they fire, the window's questions while it is open, and one
// form at a time there, so two servers' fields never mix. `headless` is -p, which says it declines; `openBrowser` opens a
// visit's address, the system's browser unless a test gives its own. Lines go out as MCP's grey lines, and a refused
// address red, as MCP's failures are (choice 26), `lead` naming the model leading, which every error carries.
export class Forms {
  readonly #bus: Bus;
  readonly #headless: boolean;
  readonly #openBrowser: (url: string) => void;
  readonly #lead: () => string;
  #hooks: Hooks | undefined;
  #ui: FormUI | undefined;
  #line: Promise<unknown> = Promise.resolve();

  constructor(opts: { bus: Bus; headless: boolean; openBrowser: (url: string) => void; lead: () => string }) {
    this.#bus = opts.bus;
    this.#headless = opts.headless;
    this.#openBrowser = opts.openBrowser;
    this.#lead = opts.lead;
  }

  // The user's hooks, the launch's (cli.tsx), as Hooks.useServers is given the servers.
  useHooks(hooks: Hooks): void {
    this.#hooks = hooks;
  }

  // The window's questions, from the App's start; the returned function lets them go as it ends, and a form after that
  // is declined, as nobody can answer it.
  bind(ui: FormUI): () => void {
    this.#ui = ui;
    return () => {
      if (this.#ui === ui) this.#ui = undefined;
    };
  }

  // Claude Code's input for both events (its hooks reference), matched on the server's name. An Elicitation hook's answer
  // is the form's, and no ElicitationResult hook runs then; otherwise the user's, which an ElicitationResult hook's answer
  // replaces, its content kept from the user's when an accept gives none (choice 35). A subagent's stop, or the server's
  // own cancel of its request, stops the hooks and the questions.
  async answer(name: string, form: Form, opts: { owner?: Owner; signal: AbortSignal }): Promise<Answer> {
    const signal = opts.owner ? AbortSignal.any([opts.signal, opts.owner.signal]) : opts.signal;
    const fields = {
      mcp_server_name: name,
      message: form.message,
      mode: form.mode ?? "form",
      ...(form.mode === "url" ? { url: form.url, elicitation_id: form.elicitationId } : { requested_schema: form.requestedSchema }),
    };
    const first = (await this.#hooks?.fire("Elicitation", fields, { match: name, signal }))?.elicitation;
    if (first) {
      if (first.action === "decline") this.#say(`An Elicitation hook declined ${visible(name)}'s form.`);
      return answerOf(first);
    }
    const run = this.#line.then(() => this.#ask(name, form, opts.owner, signal));
    this.#line = run.catch(() => {});
    const user = await run;
    const after = { ...fields, action: user.action, ...(user.content && { content: user.content }) };
    const then = (await this.#hooks?.fire("ElicitationResult", after, { match: name, signal }))?.elicitation;
    if (!then) return user;
    if (then.action === "decline") this.#say(`An ElicitationResult hook declined ${visible(name)}'s form.`);
    return answerOf(then.action === "accept" && !then.content && user.content ? { ...then, content: user.content } : then);
  }

  // The user's answer: -p and a window that has gone decline; a visit asks its question, only for a web address; a form
  // says its heading, a subagent's with its id first, as its other lines are (choice 29), then asks each field until it
  // takes the answer, saying each answer taken under its question.
  async #ask(name: string, form: Form, owner: Owner | undefined, signal: AbortSignal): Promise<Answer> {
    const ui = this.#ui;
    const who = visible(name);
    if (!ui) {
      if (this.#headless) this.#say(`MCP server ${who} asked for a form; -p declines every form.`);
      return { action: "decline" };
    }
    if (signal.aborted) return { action: "cancel" };
    if (form.mode === "url") {
      // The system's opener runs what it is given: on Windows url.dll's FileProtocolHandler starts a file:// program.
      if (!/^https?:$/i.test(URL.parse(form.url)?.protocol ?? "")) {
        const message = `MCP server ${who} asked to open ${shown(form.url)}, which is not an http or https address, so it was declined.`;
        this.#bus.emit("error", { kind: "mcp", attempted: `MCP server ${who}`, message, lead: this.#lead() });
        return { action: "decline" };
      }
      const yes = await ui.visit(`${who} asks you to open ${shown(form.url)} in your browser: ${shown(form.message)}. Open it`, owner);
      if (signal.aborted) return { action: "cancel" };
      if (yes) this.#openBrowser(form.url);
      return { action: yes ? "accept" : "decline" };
    }
    this.#say(`${owner ? `${visible(owner.name.split(" ", 1)[0]!)}: ` : ""}${who} asks: ${shown(form.message)}`);
    const content: Record<string, Value> = {};
    for (const field of fieldsOf(form.requestedSchema)) {
      let given: string | string[] | undefined;
      for (;;) {
        const typed = await ui.field(field, given, signal);
        if (typed === null) {
          if (signal.aborted) return { action: "cancel" };
          this.#say(`You declined ${who}'s form.`);
          return { action: "decline" };
        }
        const checked = check(field, typed);
        if ("wrong" in checked) {
          this.#say(checked.wrong);
          given = typed;
          continue;
        }
        this.#say(`${field.question}${checked.shown}`);
        if (checked.value !== undefined) content[field.name] = checked.value;
        break;
      }
    }
    return { action: "accept", content };
  }

  #say(line: string): void {
    this.#bus.emit("mcp-note", line);
  }
}

// A hook's answer as the server is sent it: content only with an accept. The library checks its values' types.
const answerOf = (a: { action: Answer["action"]; content?: Record<string, unknown> }): Answer =>
  a.action === "accept" && a.content ? { action: "accept", content: a.content as Record<string, Value> } : { action: a.action };
