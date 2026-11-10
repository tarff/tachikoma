import type { Tool } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import type { Bus } from "../core/bus.js";
import { visible } from "../core/permissions.js";
import { errorText, type ToolSpec } from "../core/types.js";
import type { Answers } from "./answers.js";
import type { ServerConfig } from "./config.js";
import { Server, type State } from "./server.js";

// The MCP servers together, and one table of tool names over them all (release 8c plan, Task 5; design, "Tools for the
// model"; choices 7, 8 and 36).

// One length for every provider: OpenAI's Chat Completions takes a tool name of at most 64 characters (design, finding 1;
// "Numbers in this plan").
const MAX_NAME = 64;
// A tool's description as sent upfront, Claude Code's cut (choice 1; "Numbers in this plan"). Task 6b gives a tool loaded
// through tool_search its own longer cut of the same whole text.
const MAX_DESCRIPTION = 4_096;
// A top-level property name the providers take: 1 to 64 letters, digits, "_", "." or "-" (Claude Code's rule; choice 36).
const PROPERTY = /^[A-Za-z0-9_.-]{1,64}$/;

// A tool as a request offers it: the spec the model is shown, the server and the tool's own name it calls, the connection
// that offered it and its definition (design, finding 4; choice 9). `connection` is this object's own number, unique over
// every server: a live edit's restart is a new Server, whose numbers start again.
export interface Offered { spec: ToolSpec; server: string; tool: string; connection: number; definition: string }

// A tool's schema, flattened, with the sentence a flattened anyOf or oneOf puts before its description; or why it is left
// out (choice 36).
type Prepared = { schema: Record<string, unknown>; sentence?: string } | { reason: string };

interface Slot {
  config: ServerConfig;
  server?: Server; // started; otherwise `fixed` says why not
  fixed?: State;
  late?: boolean; // still starting when a wait gave up on it, so its ready line is said (design, "Starting and stopping servers")
  stopSaid?: number; // the connection whose stop has been said, so each stop is said once
}

export class Servers {
  readonly #root: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #bus: Bus;
  readonly #makeAnswers: () => Answers;
  readonly #network: "on" | "off" | "none";
  readonly #lead: () => string;
  readonly #startMs?: number;
  #slots: Slot[];
  #answers: Answers | null | undefined; // null: they could not be read; undefined: not read yet
  #unreadable: string | undefined; // why, until it is said
  #started = false;
  #offered = new Map<string, { server: string; tool: string }>(); // each name the last offer gave, with its owner (choice 7)
  #said = new Set<string>(); // the left-out lines in force, each said once
  #waiters = new Set<() => void>();
  #prepared = new WeakMap<Tool, Prepared>();
  #ids = new WeakMap<Server, Map<number, number>>();
  #lastId = 0;

  // `answers` makes the project's answers (answersFor), read only when a project's server needs one, since it throws on a
  // file it cannot read; that is caught here. `network` is the sandbox's: "none" when it is off. `lead` names the model
  // leading, which every error on the bus carries. `startMs` is a server's start limit, 30 s unless a test gives one.
  constructor(
    configs: ServerConfig[],
    opts: { root: string; env: NodeJS.ProcessEnv; bus: Bus; answers: () => Answers; network: "on" | "off" | "none"; lead: () => string; startMs?: number },
  ) {
    this.#root = opts.root;
    this.#env = opts.env;
    this.#bus = opts.bus;
    this.#makeAnswers = opts.answers;
    this.#network = opts.network;
    this.#lead = opts.lead;
    this.#startMs = opts.startMs;
    this.#slots = configs.map((c) => this.#slot(c));
  }

  // Every server at once, in the background (design, "Starting and stopping servers"). The answers' line is said here, once
  // the bus has its listeners.
  startAll(): void {
    this.#started = true;
    this.#sayUnreadable();
    for (const slot of this.#slots) this.#begin(slot);
  }

  // True once none is starting; false when the signal stops the wait first, and those still starting say when they are
  // ready (design: "Esc sends it without the late ones, whose tools join when they are ready").
  ready(signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.waitingFor().length) return;
        done();
        resolve(true);
      };
      const stop = () => {
        for (const slot of this.#slots) if (this.#state(slot).is === "starting") slot.late = true;
        done();
        resolve(false);
      };
      const done = () => {
        this.#waiters.delete(check);
        signal?.removeEventListener("abort", stop);
      };
      if (signal?.aborted) return stop();
      this.#waiters.add(check);
      signal?.addEventListener("abort", stop, { once: true });
      check();
    });
  }

  // The names still starting, escaped, for the waiting line (choice 25).
  waitingFor(): string[] {
    return this.#slots.filter((s) => this.#state(s).is === "starting").map((s) => visible(s.config.name));
  }

  // The tools a request carries (choice 9): every ready server's, each under its name in the table, which this offer
  // fixes for its owners (choice 7). `trustedOnly`: a subagent's, only the tools trusted as read-only.
  offer(opts: { trustedOnly?: boolean } = {}): Offered[] {
    const offered = this.#table();
    this.#offered = new Map(offered.map((o) => [o.spec.name, { server: o.server, tool: o.tool }]));
    return opts.trustedOnly ? offered.filter((o) => this.trust(o.server, o.tool)) : offered;
  }

  // An offered tool against its server now (design, finding 4): "restarted" when its connection is not the one that offered
  // it, "stopped" when its server no longer runs, "changed" when its name now gives another tool or another definition, or
  // its server's entry was removed or changed to one that does not start.
  current(o: Offered): "same" | "changed" | "stopped" | "restarted" {
    const server = this.#slots.find((s) => s.config.name === o.server)?.server;
    if (!server) return "changed";
    if (this.#connectionOf(server) !== o.connection) return "restarted";
    if (server.state.is !== "ready") return "stopped";
    const now = this.#table().find((n) => n.spec.name === o.spec.name);
    return now?.server === o.server && now.tool === o.tool && now.definition === o.definition ? "same" : "changed";
  }

  // Read from the entry in force, which a live edit's set() replaces (choice 16). A project's entry never carries trust.
  trust(server: string, tool: string): boolean {
    const config = this.#slots.find((s) => s.config.name === server)?.config;
    return config !== undefined && (config.trusted === "read-only" || config.trustedTools.includes(tool));
  }

  // A live edit: an entry whose place or entry changed is stopped and started again as a new Server, a new one started,
  // a removed one stopped; the others are untouched, their trust and alwaysLoad taken from the new config. A project's
  // entry as written counts too, as its answer holds it (choice 24): written another way, it is asked about again even
  // when the filled-in entry is the same. A user's is not compared, as it also holds the trust and alwaysLoad that change
  // in place. A stopped Server keeps the state it had, so it is forgotten, never read again. The live-edit line is said
  // by Task 10.
  set(configs: ServerConfig[]): void {
    const key = (c: ServerConfig) => JSON.stringify([c.where, c.entry, c.where === "project" ? c.written : ""]);
    const old = new Map(this.#slots.map((s) => [s.config.name, s]));
    const added: Slot[] = [];
    this.#slots = configs.map((config) => {
      const was = old.get(config.name);
      if (was && key(was.config) === key(config)) {
        old.delete(config.name);
        was.config = config;
        return was;
      }
      const slot = this.#slot(config);
      added.push(slot);
      return slot;
    });
    for (const slot of old.values()) void slot.server?.stop();
    if (this.#started) {
      this.#sayUnreadable();
      for (const slot of added) this.#begin(slot);
    }
    this.#wake();
  }

  // For /mcp (Task 10): each server, its file, its state, and its trust.
  list(): { name: string; where: "user" | "project"; state: State; trusted: ServerConfig["trusted"]; trustedTools: string[] }[] {
    return this.#slots.map((slot) => {
      const { name, where, trusted, trustedTools } = slot.config;
      return { name, where, state: this.#state(slot), trusted, trustedTools };
    });
  }

  // A server's connection, for Task 6's calls.
  server(name: string): Server | undefined {
    return this.#slots.find((s) => s.config.name === name)?.server;
  }

  // A dropped remote server's one new connection (choices 13, 33), for Task 6's run: through here, not the Server's own,
  // as a Server tells nothing of how a reconnect ended, and a failed one is when its stop is said.
  async reconnect(name: string): Promise<boolean> {
    const slot = this.#slots.find((s) => s.config.name === name);
    const server = slot?.server;
    if (!slot || !server) return false;
    const connected = await server.reconnect();
    this.#changed(slot, server);
    return connected;
  }

  // At Tachikoma's exit: every server stopped (choice 3), all forgotten.
  async stopAll(): Promise<void> {
    const slots = this.#slots;
    this.#slots = [];
    this.#wake();
    await Promise.all(slots.map((s) => s.server?.stop()));
  }

  // A project's server starts only on the user's yes for its entry as written (choice 24; Task 9 asks); with the sandbox's
  // network off none starts, as it would run on the user's machine with the web open (design, "Starting and stopping
  // servers").
  #slot(config: ServerConfig): Slot {
    if (this.#network === "off") return { config, fixed: { is: "off" } };
    if (config.where === "project") {
      const yes = this.#readAnswers()?.get(config.name, config.written);
      if (yes === undefined) return { config, fixed: { is: "waiting for your yes" } };
      if (!yes) return { config, fixed: { is: "you said no" } };
    }
    const slot: Slot = { config };
    const server = new Server(config, { root: this.#root, env: this.#env, startMs: this.#startMs, onChange: () => this.#changed(slot, server) });
    slot.server = server;
    return slot;
  }

  // Answers that cannot be read leave every project server unanswered, asked about again (the user approved these words,
  // 2026-11-10).
  #readAnswers(): Answers | null {
    if (this.#answers === undefined) {
      try {
        this.#answers = this.#makeAnswers();
      } catch (err) {
        this.#answers = null;
        this.#unreadable = visible(errorText(err), { tabs: true });
      }
    }
    return this.#answers;
  }

  #sayUnreadable(): void {
    if (this.#unreadable === undefined) return;
    this.#fail("MCP answers", `MCP answers for this project could not be read (${this.#unreadable}), so its servers are asked about again.`);
    this.#unreadable = undefined;
  }

  #begin(slot: Slot): void {
    const server = slot.server;
    if (server) void server.start().then(() => this.#changed(slot, server));
  }

  // A server started, failed, changed its list or stopped. One replaced or forgotten by set() or stopAll() is not read.
  #changed(slot: Slot, server: Server): void {
    if (slot.server !== server || !this.#slots.includes(slot)) return;
    const name = visible(slot.config.name);
    const state = server.state;
    const { offered, fresh } = this.#build();
    if (state.is === "failed") this.#fail(`MCP server ${name}`, `MCP server ${name} failed to start: ${visible(state.reason, { tabs: true })}`);
    // A dropped remote server is tried again at its next call (choices 13, 33), so its drop says nothing; its stop is said
    // when that new connection fails, with its reason (the user's choice, plan commit 25eca39, "A server stopped").
    else if (state.is === "stopped" && !state.retry && slot.stopSaid !== server.connection) {
      slot.stopSaid = server.connection;
      this.#fail(`MCP server ${name}`, `MCP server ${name} stopped: ${visible(state.reason, { tabs: true })}; reconnect it from /mcp.`);
    } else if (state.is === "ready" && slot.late) {
      const n = offered.filter((o) => o.server === slot.config.name).length;
      this.#bus.emit("mcp-note", `MCP server ${name} is ready: ${n} ${n === 1 ? "tool" : "tools"}.`);
    }
    if (state.is !== "starting") slot.late = false;
    this.#note(fresh);
    this.#wake();
  }

  // The table now, its new left-out lines said.
  #table(): Offered[] {
    const { offered, fresh } = this.#build();
    this.#note(fresh);
    return offered;
  }

  // The table of names, rebuilt from every ready server's list (choice 7): `mcp__<safe server>__<safe tool>`, each name
  // with one owner, given first to the owner the last offer gave it while that tool is still offered, then in the order
  // the configs are given and each list's order; a later tool with a name in force is left out (design, finding 2).
  // Schemas are flattened or left out before a name is given (choice 36). `fresh`: the left-out lines not in force before.
  #build(): { offered: Offered[]; fresh: string[] } {
    const lines: string[] = [];
    const candidates: { slot: Slot; server: Server; tool: Tool; full: string; prepared: Extract<Prepared, { schema: unknown }>; who: string }[] = [];
    for (const slot of this.#slots) {
      const server = slot.server;
      if (server?.state.is !== "ready") continue;
      for (const tool of server.state.tools) {
        const who = `MCP server ${visible(slot.config.name)}: "${visible(tool.name, { tabs: true })}" was left out: `;
        const prepared = this.#prepare(tool);
        if ("reason" in prepared) {
          lines.push(`${who}its input schema ${prepared.reason}`);
          continue;
        }
        const full = `mcp__${slot.config.safe}__${tool.name.replace(/[^A-Za-z0-9_-]/g, "_")}`;
        if (full.length > MAX_NAME) lines.push(`${who}its name ${full} is ${full.length} characters, over the ${MAX_NAME} every provider takes`);
        else candidates.push({ slot, server, tool, full, prepared, who });
      }
    }
    const owners = new Map<string, (typeof candidates)[number]>();
    for (const c of candidates) {
      const was = this.#offered.get(c.full);
      if (!owners.has(c.full) && was?.server === c.slot.config.name && was.tool === c.tool.name) owners.set(c.full, c);
    }
    for (const c of candidates) {
      const owner = owners.get(c.full);
      if (!owner) owners.set(c.full, c);
      else if (owner !== c) {
        lines.push(`${c.who}its name ${c.full} is already ${visible(owner.slot.config.name)}'s "${visible(owner.tool.name, { tabs: true })}"`);
      }
    }
    const offered = candidates
      .filter((c) => owners.get(c.full) === c)
      .map((c) => ({
        spec: { name: c.full, description: describe(c.tool, c.prepared.sentence, MAX_DESCRIPTION), inputSchema: c.prepared.schema },
        server: c.slot.config.name,
        tool: c.tool.name,
        connection: this.#connectionOf(c.server),
        // The server's whole description and its own schema, never a cut view (choice 8).
        definition: JSON.stringify({ description: c.tool.description, inputSchema: c.tool.inputSchema }),
      }));
    const fresh = [...new Set(lines)].filter((l) => !this.#said.has(l));
    this.#said = new Set(lines);
    return { offered, fresh };
  }

  // Each list's tools are kept until the list changes, so each schema is checked once.
  #prepare(tool: Tool): Prepared {
    let prepared = this.#prepared.get(tool);
    if (!prepared) this.#prepared.set(tool, (prepared = prepare(tool.inputSchema)));
    return prepared;
  }

  #connectionOf(server: Server): number {
    let ids = this.#ids.get(server);
    if (!ids) this.#ids.set(server, (ids = new Map()));
    let id = ids.get(server.connection);
    if (id === undefined) ids.set(server.connection, (id = ++this.#lastId));
    return id;
  }

  #state(slot: Slot): State {
    return slot.server?.state ?? slot.fixed!;
  }

  #fail(attempted: string, message: string): void {
    this.#bus.emit("error", { kind: "mcp", attempted, message, lead: this.#lead() });
  }

  #note(lines: string[]): void {
    for (const line of lines) this.#bus.emit("mcp-note", line);
  }

  #wake(): void {
    for (const waiter of [...this.#waiters]) waiter();
  }
}

// The sentence a flattened anyOf or oneOf puts before the server's description, then that text, cut at `max`.
function describe(tool: Tool, sentence: string | undefined, max: number): string {
  const text = tool.description ?? "";
  return (sentence ? (text ? `${sentence} ${text}` : sentence) : text).slice(0, max);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const names = (v: unknown): v is string[] => Array.isArray(v) && v.every((n) => typeof n === "string");
// An object schema: of type "object" where a type is given, its properties an object and its required a list of names.
const objectSchema = (v: unknown): v is Record<string, unknown> & { properties?: Record<string, unknown>; required?: string[] } =>
  isObject(v) &&
  (v.type === undefined || v.type === "object") &&
  (v.properties === undefined || isObject(v.properties)) &&
  (v.required === undefined || names(v.required));

const NOT_OBJECT = { reason: "is not an object schema" };

// Choice 36, as Claude Code's MCP page says ("Tool input schemas with a root-level combinator", "Tools with invalid input
// schemas"): a root-level anyOf, oneOf or allOf is flattened into one object schema, the branches' properties merged, the
// first of a name kept; allOf keeps every branch's required, anyOf and oneOf none, and a sentence says which go together.
// Then the schema must be an object schema, its top-level property names ones the providers take, and compile in the
// library's checker, or the tool is left out.
function prepare(input: Tool["inputSchema"]): Prepared {
  const { anyOf, oneOf, allOf, ...root } = input as Record<string, unknown>;
  let schema: Record<string, unknown> = input;
  let sentence: string | undefined;
  if (anyOf !== undefined || oneOf !== undefined || allOf !== undefined) {
    if (!objectSchema(root)) return NOT_OBJECT;
    const properties = new Map(Object.entries(root.properties ?? {}));
    const required = [...(root.required ?? [])];
    const sets: string[][] = [];
    for (const [combinator, branches] of [["allOf", allOf], ["anyOf", anyOf], ["oneOf", oneOf]] as const) {
      if (branches === undefined) continue;
      if (!Array.isArray(branches) || !branches.every(objectSchema)) return NOT_OBJECT;
      for (const branch of branches) {
        for (const [p, s] of Object.entries(branch.properties ?? {})) if (!properties.has(p)) properties.set(p, s);
        if (combinator === "allOf") required.push(...(branch.required ?? []));
        else sets.push(branch.required ?? []);
      }
    }
    const { required: _, ...rest } = root;
    const needed = [...new Set(required)];
    schema = { ...rest, type: "object", ...(needed.length ? { required: needed } : {}), properties: Object.fromEntries(properties) };
    if (sets.length) {
      const said = sets.map((set) => (set.length ? set.join(", ") : "(none needed)"));
      const list = said.length > 1 ? `${said.slice(0, -1).join("; ")}; or ${said.at(-1)}` : said[0];
      sentence = `This tool takes one of these sets of parameters: ${list}.`;
    }
  }
  if (!objectSchema(schema) || schema.type !== "object") return NOT_OBJECT;
  const bad = Object.keys(schema.properties ?? {}).find((p) => !PROPERTY.test(p));
  if (bad !== undefined) {
    return { reason: `has the property name "${visible(bad, { tabs: true })}", which providers do not take (1 to 64 letters, digits, "_", "." or "-")` };
  }
  // The library's own JSON Schema checker (choice 36), a new one for each schema: one checker keeps every schema it
  // compiled, by its $id, so a broken schema reusing an earlier one's $id would pass, and a long session's list changes
  // would pile up. A new one costs little: 180 schemas took 83 ms on this machine (measured 2026-11-10, Task 5's review),
  // once per list, as each list's checks are kept until it changes.
  try {
    new AjvJsonSchemaValidator().getValidator(schema as Parameters<AjvJsonSchemaValidator["getValidator"]>[0]);
  } catch (err) {
    return { reason: `could not be read (${visible(errorText(err), { tabs: true })})` };
  }
  return { schema, ...(sentence && { sentence }) };
}
