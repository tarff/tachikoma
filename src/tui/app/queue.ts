import { lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Prompt } from "@modelcontextprotocol/client";
import { withLock } from "../../auth/lock.js";
import { leadGone, type Opened } from "../../clilib.js";
import type { ErrorEvent } from "../../core/bus.js";
import { summarize } from "../../core/errorlog.js";
import { exportText } from "../../core/exportText.js";
import { type Protection, visible } from "../../core/permissions.js";
import { cannot, truncate } from "../../core/session.js";
import { listSessions } from "../../core/sessions.js";
import { CANCELLED } from "../../core/shorten.js";
import type { Task } from "../../core/tasks.js";
import { errorText, type Part, type Picture, type Provider } from "../../core/types.js";
import { hookName } from "../../hooks/answer.js";
import { limitOf } from "../../hooks/hooks.js";
import { KEYBINDINGS } from "../../keybindings.js";
import { NotReached, type Server } from "../../mcp/server.js";
import { until } from "../../mcp/tools.js";
import { dropIfNothing } from "../../sandbox/copies.js";
import { copyLock } from "../../sandbox/snapshot.js";
import { SETTINGS, shownFile } from "../../settings.js";
import type { Fns } from "../App.js";
import { typeOf, unquoted } from "../clipboard.js";
import { callLines, type Line } from "../describe.js";
import { conversationLines } from "../fold.js";
import { offers } from "../menus.js";
import { type Draft, joined, trimmed } from "../pictures.js";
import { type Action, stateText } from "../McpList.js";
import { kept, type ReviewEnd } from "../Review.js";
import { taskRow } from "../TaskPanel.js";
import { FOLLOWING } from "../view.js";
import {
  characters, COMMANDS, EXPORT_WORDS, FROM, gray, isCommand, names, NOT_GONE, reviewUnopened, SESSION_WORDS, SHORTEN_WORDS,
} from "./constants.js";
import type { UI } from "./state.js";

export const queue = (ui: UI, fns: Fns) => {
  // Called without await, so nothing may escape: an unhandled rejection ends the program. The queue
  // goes on after a turn, however it ended, and after `/model` once the list is closed. `answers`: a
  // turn with nothing typed, to read the background answers waiting.
  const submit = async (raw: Draft, answers = false) => {
    if (!(await fns.perform(raw, answers))) fns.next();
  };

  // Background answers waiting go first, in a turn of their own (release 4 design, "Background
  // subagents"). Then the queue's entries, taken from the front: a command alone, as if typed then;
  // prompts next to each other as one message, separated by blank lines. Not while something runs (a
  // command that finished after a turn started, both typed in one read of the terminal, leaves the
  // queue to that turn), nor while a question or the model list is open. While the detail view is printed out, a
  // subagent's record waits for it to come back, and what is queued after it, as it would take the printed view's place
  // unseen; the model list waits in perform, below (the user's choices, release 5). So does /screen, which would change
  // the screen under the printed view, and could not suspend Ink, suspended already. Messages and other commands go on.
  // Nothing starts once Ink has ended, a turn going on paying with no screen to show it. While the terminal is handed
  // over (owner.ts, busy), to an editor too, /screen, /settings and /keybindings wait, as each would hand it over
  // again; messages and other commands go on (release 6 plan, Task 12).
  // A lead or screen the settings file set waits here as `/lead` and `/screen` would in the queue, the screen also
  // while the terminal is handed over (release 6 design, "When a live change applies").
  const next = () => {
    const h = ui.happening();
    if (h.phase.kind === "ended" || h.phase.kind === "review" || h.working || h.waiting) return;
    const w = ui.waiting.current;
    if (w.lead !== undefined) fns.fileLead(w.lead);
    w.lead = undefined;
    if (w.screen && !ui.owner.busy) {
      const to = w.screen;
      w.screen = undefined;
      if (to === "full" && !ui.fullNow.current && !ui.fullPossible) fns.note(gray("Full screen needs a terminal (the output is not one, or CI is set)"));
      else if ((to === "full") === ui.fullNow.current) fns.note(gray(`screen is now ${to}${FROM}`));
      else {
        // As perform runs /screen: what goes wrong is said, and the queue goes on after.
        void fns.switchScreen(true)
          .catch((err) => fns.say({ text: errorText(err), color: "red" }))
          .then(fns.next);
        return;
      }
    }
    if (ui.tasks.wakes()) return void fns.submit({ text: "", spans: [] }, true);
    const q = ui.queue.current;
    const command = q.findIndex((d) => isCommand(d.text));
    if (!h.queued) return;
    // /resume's list too, which would open under the printed view (release 8a plan, Task 7), and /mcp's (release 8c plan,
    // Task 10).
    if (h.phase.kind === "printed" && command === 0 && (fns.recordToOpen(q[0]!.text) || /^\/(screen|resume|mcp)$/i.test(q[0]!.text))) return;
    if (ui.owner.busy && command === 0 && /^\/(screen|settings|keybindings)$/i.test(q[0]!.text)) return;
    ui.view.current = FOLLOWING; // sending a prompt goes to the bottom (release 5 design, "Scrolling")
    void fns.submit(joined(q.splice(0, command === 0 ? 1 : command === -1 ? q.length : command), "\n\n"));
  };
  // The subagent whose record `text` opens in the detail view: in full screen, `/tasks t3` with a subagent of that id
  // (perform, below).
  const recordToOpen = (text: string) => {
    const [first = "", ...words] = text.split(/\s+/);
    return ui.fullNow.current && first.toLowerCase() === "/tasks" && words.length === 1 ? ui.tasks.all.find((t) => t.id === words[0]) : undefined;
  };

  // True when it opened the model list.
  const perform = async (raw: Draft, answers = false): Promise<boolean | void> => {
    const message = trimmed(raw);
    const { text } = message;
    if (!text && !answers) return;
    // Commands ignore case; a message is sent as typed.
    const [first = "", ...words] = text.split(/\s+/);
    const command = first.toLowerCase();
    const alone = (name: string) => command === name && !words.length;
    // `/lead` alone opens the model list, as `/model` does, in every respect (release 6 plan, choice 34, the user's:
    // "can we have lead list the models?"); `/lead <provider:model>` switches as before.
    const listing = alone("/model") || alone("/lead");
    try {
      if (alone("/exit")) {
        ui.queue.current = [];
        return fns.leave();
      }
      if (alone("/errors")) return fns.say(...summarize(ui.errorFile).map((row) => ({ text: row, oneLine: true })));
      if (alone("/hooks")) return fns.say(...hooksList());
      if (alone("/mcp")) return mcpOpen();
      // Not to full screen where it can't draw: classic, as at the start (clilib.ts, screenMode).
      if (alone("/screen") && !ui.fullNow.current && !ui.fullPossible)
        return fns.say({ text: "Full screen needs a terminal (the output is not one, or CI is set)", color: "gray" });
      if (alone("/screen")) return await fns.switchScreen();
      if (alone("/settings")) return await fns.openFile(SETTINGS, {});
      if (alone("/keybindings")) return await fns.openFile(KEYBINDINGS, { bindings: [] });
      // /vim switches vim mode, /vim on and /vim off set it (choice 6), this window only, saving nothing (choice 26).
      if (command === "/vim") {
        const [word = "", ...rest] = words.map((w) => w.toLowerCase());
        const on = word ? word === "on" : ui.vim.current === null;
        if (!rest.length && ["", "on", "off"].includes(word)) return fns.setVim(on);
        return fns.say({ text: "Usage: /vim, /vim on, /vim off", color: "red" });
      }
      // In full screen a subagent's record opens in the detail view (release 5 plan, Task 12); the list, stopping and
      // mistakes print.
      if (command === "/tasks") {
        const t = fns.recordToOpen(text);
        return t ? fns.openDetail(fns.recordOf(t)) : fns.say(...fns.tasksCommand(words));
      }
      if (command === "/lead" && !listing) return await leadTo(words.join(" "));
      // The window's saved sessions (release 8a plan, Task 7). A name is the rest of the first line as typed, and so is
      // /export's file, so none holds a line break.
      const rest = text.slice(first.length).trim().split(/\r?\n/)[0]!.trim();
      if (command === "/rename") return fns.rename(rest);
      // /export's write may be slow, as to a network share: what is typed meanwhile waits in the queue, as during a turn.
      if (command === "/export") {
        ui.working.current = true;
        try {
          return await fns.exportTo(rest);
        } finally {
          ui.working.current = false;
        }
      }
      // Release 8a plan, Task 13: /compact's words are all that follows it, line breaks and all.
      if (command === "/compact") return await compact(text.slice(first.length).trim());
      if (command === "/autocompact") return autoCompact(words);
      if (alone("/clear") || alone("/resume") || command === "/branch") {
        const refused = fns.subagentsRunning(command);
        if (refused) return fns.say(refused);
        if (command === "/resume") return fns.resume();
        // The instruction files are read again meanwhile (/clear), and SessionEnd's hooks run (both; release 8b plan, Task
        // 10): what is typed waits in the queue, as during a turn.
        ui.working.current = true;
        try {
          return await (command === "/branch" ? fns.branch(rest) : fns.startFresh());
        } finally {
          ui.working.current = false;
        }
      }
      const account = command === "/login" ? "login" : command === "/logout" ? "logout" : undefined;
      // A mistyped command must not become a paid turn.
      // A slash and a bare word on its own is a command; "/tmp is full" is a message, "/exit now" is not.
      if (!account && !listing && /^\/[a-z]+$/i.test(text)) return fns.say({ text: `Unknown command: ${text}. Commands: ${COMMANDS}`, color: "red" });
      if (words.length && ["/exit", "/errors", "/model", "/screen", "/settings", "/keybindings", "/clear", "/resume", "/hooks", "/mcp"].includes(command))
        return fns.say({ text: `${command} takes nothing after it.`, color: "red" });
      ui.abort.current = new AbortController();
      const turn = !account && !listing;
      const label = account === "login" ? "Waiting for the browser" : account ? "Signing out" : answers ? `Reading ${names(ui.tasks.answering())}` : turn ? "Working" : "Reading the model lists";
      ui.doing.current = { label, at: Date.now(), from: turn ? { output: ui.stats.output, cost: ui.stats.cost, unpriced: ui.stats.unpriced } : null };
      if (turn) {
        ui.calls.current = [];
        ui.summary.current = null; // Ctrl+O shows this turn's calls (App.tsx, onShortened)
      }
      ui.setNow(ui.doing.current.at);
      ui.setBusy(true);
      ui.working.current = true;
      // Finished subagents leave the panel at the user's next turn; after `working`, since the change
      // it reports would otherwise start the queue.
      if (turn && !answers) ui.tasks.clearFinished();
      try {
        // Signing in waits on the browser; Ctrl-C stops it, as it stops a turn.
        if (account) await ui.login(account, words, (line) => fns.say({ text: line, color: "magenta" }), ui.abort.current.signal, "/");
        else if (listing) {
          const { signal } = ui.abort.current; // this command's own, read before the wait
          const groups = await ui.listModels(signal, (line) => fns.say({ text: line, color: "magenta" }));
          if (!signal.aborted) {
            ui.listOpen.current = true;
            // A list read while the detail view is printed out, sent before `[` or from the queue, waits for it to come back
            // (the user's choice, release 5): opening, it would end the paste hook (usePaste, App.tsx), and Ink would
            // turn bracketed paste off at once, suspended or not, so a paste would come as keys. listOpen holds the
            // queue meanwhile.
            if (ui.printed.current) ui.waitingList.current = groups;
            else ui.setPicker(groups);
            return true;
          }
        } else {
          const { signal } = ui.abort.current;
          // The message's pictures sent before it, which a blocked prompt's words do not take back (promptKeys.ts, giveBack).
          const before = new Set(message.spans.flatMap((s) => (ui.pictures.sent(s.id) ? [s.id] : [])));
          const read = await fns.readsEnded(message, signal);
          // What the MCP servers supply goes after the typed words, marked the server's (choice 34), got by the session once
          // the first prompt's wait and UserPromptSubmit are done (Task 13's fix round). One that cannot be got stops the
          // send, its line said; a stop meanwhile says nothing. Either way the words and their pictures come back into the
          // prompt box (choices 30, 31).
          let refused: Refused | undefined;
          const got = async (): Promise<Part[] | null> => {
            const supplied = await supply(read.draft.text, signal);
            if (Array.isArray(supplied)) return supplied;
            if (!signal.aborted) refused = supplied;
            return null;
          };
          const ended = await ui.session.send(read.parts, signal, ui.mcp ? got : undefined);
          if (ended && "unsupplied" in ended) {
            if (refused) fns.say({ text: refused.line, color: "red" });
            fns.giveBack(read.draft, before, refused?.said ?? false);
          }
          // A prompt a UserPromptSubmit hook blocked or stopped was not sent (approved by the user, 2026-11-09).
          else if (ended && ("blocked" in ended || ended.unsent)) fns.giveBack(read.draft, before);
        }
      } finally {
        fns.endRun(); // the turn's end, Esc's among them, says the open run of quiet calls (release 8c plan, choice 65)
        ui.setBusy(false);
        ui.working.current = false;
        // The model may have switched branches. Through the Workspace, so it lands just after the turn ends (release 7
        // plan, Task 14).
        void ui.workspace.branch().then(ui.setBranch, (err) => fns.say({ text: errorText(err), color: "red" }));
      }
    } catch (err) {
      fns.say({ text: errorText(err), color: "red" });
    }
  };

  // The MCP servers' parts for a prompt being sent (release 8c plan, Task 13), each marked the server's (choice 34): a
  // prompt command's messages, each text and picture, an assistant's headed `(assistant)` (choice 31); then each resource
  // picked in the words, `@<name>:<uri>` as `@` completes it, once, in the order picked: its text headed `Resource
  // @<name>:<uri>:` and cut as a tool's answer is (choice 30; "Numbers in this plan"), then its pictures, numbered as
  // pasted ones are once every one has been got, so a send that stops takes no numbers. A picture's type is read from its
  // first bytes, as a tool answer's is; any other content is left out. A name and what follows it match in their letter
  // case first, then in any, as the menus narrow in any (the fix round).
  // The server named is made ready if it can be: a remote one whose connection dropped is connected again first, and a
  // request that never reached it connects again and goes once more, as a tool call's does (choices 13, 33); it is safe,
  // as reading changes nothing. A configured server that is still not ready stops the send, saying so in /mcp's words
  // for its state (the user's words, the fix round). A ready one whose list lacks what was typed leaves it plain words.
  // The red line instead, for the first that cannot be got, the reason escaped; `said`: whether the grey line saying the
  // words are back is said after it, as the missing argument's line does not say so. Whatever else goes wrong meanwhile,
  // as a server a live edit removed, gives the red line of the read or prompt being got, so the words always come back.
  // The servers named are readied first, then the offers built once, as building them reads every server's lists.
  const supply = async (text: string, signal: AbortSignal): Promise<Part[] | Refused> => {
    const servers = ui.mcp!.servers;
    const why = (err: unknown) => visible(errorText(err), { tabs: true });
    const back = "Your words are back in the prompt box.";
    // A server gone from the settings has no state to say, so it is said as Server says one it has no connection to.
    const notReady = (name: string) => {
      const s = servers.list().find((x) => x.name === name);
      if (!s) throw new Error("Not connected");
      return `${visible(name)} is not ready (${visible(stateText(s.state), { tabs: true })})`;
    };
    // The configured server `typed` names, ready if it can be made so; each name once.
    const ready = new Map<string, string | undefined>();
    const readied = async (typed: string): Promise<string | undefined> => {
      if (ready.has(typed)) return ready.get(typed);
      const s = named(servers.list(), typed, (x) => x.name);
      ready.set(typed, s?.name);
      if (!s) return undefined;
      if (s.state.is === "stopped" && s.state.retry) await reconnect(s.name, signal);
      const server = servers.server(s.name);
      if (server?.state.is === "ready") await until(server.listed, signal);
      return s.name;
    };
    const ask = async <T>(name: string, send: (server: Server) => Promise<T>): Promise<T> => {
      const ready = () => {
        const server = servers.server(name);
        if (server?.state.is !== "ready") throw new Error(notReady(name));
        return server;
      };
      try {
        return await send(ready());
      } catch (err) {
        if (!(err instanceof NotReached) || signal.aborted || !(await reconnect(name, signal))) throw err;
        return await send(ready());
      }
    };
    const pending: (Part | Picture)[] = [];
    const pictured = (base64: string): Picture[] => {
      const data = Buffer.from(base64, "base64");
      const mediaType = typeOf(data);
      return mediaType ? [{ mediaType, data }] : [];
    };
    const [first = ""] = text.split(/\s+/);
    // The red line for what is being got now, given its reason, set at each step.
    let fail = (reason: string): Refused => ({ line: `Could not get the prompt ${visible(first)}: ${reason}. ${back}`, said: false });
    try {
      const command = /^\/([^\s/:]+):\S/.exec(first);
      const typedKeys = [...new Set([...text.matchAll(/(?:^|\s)@(\S+)/g)].map((m) => m[1]!))];
      const server = command && (await readied(command[1]!));
      const picks: { typed: string; server: string }[] = [];
      for (const typed of typedKeys) {
        const colon = typed.indexOf(":");
        fail = (reason) => ({ line: `Could not read @${visible(typed)}: ${reason}. ${back}`, said: false });
        const owner = colon > 0 ? await readied(typed.slice(0, colon)) : undefined;
        if (owner) picks.push({ typed, server: owner });
      }
      const o = offers(servers);
      if (server) {
        fail = (reason) => ({ line: `Could not get the prompt ${visible(first)}: ${reason}. ${back}`, said: false });
        const p = named(o.prompts, first, (x) => x.command);
        if (!p && servers.server(server)?.state.is !== "ready") return fail(notReady(server));
        if (p) {
          const filled = argumentsOf(p.prompt, text.slice(first.length));
          if ("missing" in filled) {
            const usage = [p.command, ...(p.prompt.arguments ?? []).map((a) => a.name)].map((w) => visible(w)).join(" ");
            return { line: `${visible(p.command)} needs ${visible(filled.missing)}: ${usage}`, said: true };
          }
          fail = (reason) => ({ line: `Could not get the prompt ${visible(p.command)}: ${reason}. ${back}`, said: false });
          const got = await ask(p.server, (s) => s.getPrompt(p.prompt.name, filled.args, { signal }));
          for (const m of got.messages) {
            const head = m.role === "assistant" ? "(assistant)" : undefined;
            const c = m.content;
            if (c.type === "text") pending.push({ type: "text", text: head ? `${head}\n${c.text}` : c.text, from: "server" });
            else if (c.type === "image") {
              const picture = pictured(c.data);
              if (head && picture.length) pending.push({ type: "text", text: head, from: "server" });
              pending.push(...picture);
            }
          }
        }
      }
      const done = new Set<string>();
      for (const { typed, server } of picks) {
        fail = (reason) => ({ line: `Could not read @${visible(typed)}: ${reason}. ${back}`, said: false });
        const r = named(o.resources, typed, (x) => x.key);
        if (!r && servers.server(server)?.state.is !== "ready") return fail(notReady(server));
        if (!r || done.has(r.key)) continue;
        done.add(r.key);
        fail = (reason) => ({ line: `Could not read @${visible(r.key)}: ${reason}. ${back}`, said: false });
        const got = await ask(r.server, (s) => s.readResource(r.uri, { signal }));
        const texts = got.contents.flatMap((c) => ("text" in c ? [c.text] : []));
        const head = `Resource @${r.key}:`;
        pending.push({ type: "text", text: texts.length ? `${head}\n${truncate(texts.join("\n\n"))}` : head, from: "server" });
        for (const c of got.contents) if ("blob" in c) pending.push(...pictured(c.blob));
      }
    } catch (err) {
      if (signal.aborted) return { line: "", said: false }; // the caller says nothing for a stop
      return fail(why(err));
    }
    return pending.map((p): Part => {
      if ("type" in p) return p;
      const id = ui.pictures.next();
      ui.pictures.set(id, p);
      return { type: "image", id, ...p, from: "server" };
    });
  };
  // A dropped remote server's one new connection (choices 13, 33), with the grey line a tool call's says, once for each new
  // connection; false when it did not connect, or a stop ended the wait.
  const reconnected = new WeakSet<Promise<boolean>>();
  const reconnect = async (name: string, signal: AbortSignal): Promise<boolean> => {
    const trying = ui.mcp!.servers.reconnect(name);
    if (!(await until(trying, signal))) return false;
    if (!reconnected.has(trying)) {
      reconnected.add(trying);
      ui.bus.emit("mcp-note", `MCP server ${visible(name)} was connected again.`);
    }
    return true;
  };

  // `/tasks` lists the session's subagents, `/tasks t3` prints one's tool calls and answer in full,
  // and `/tasks stop` stops all of them, or with a number one (release 4 design, "Background subagents").
  const tasksCommand = (words: string[]): Line[] => {
    const none = (id: string): Line => ({ text: `No subagent ${id}. /tasks lists them.`, color: "red" });
    const [verb, id, ...rest] = words;
    if (verb === undefined) {
      if (!ui.tasks.all.length) return [gray("No subagents yet.")];
      const now = Date.now();
      return [gray(`Subagents: ${ui.tasks.all.length}`), ...ui.tasks.all.flatMap((t) => taskRow(t, now)).map((r) => ({ ...gray(`${r.mark} ${r.text}`), oneLine: true }))];
    }
    if (verb === "stop" && !rest.length) {
      if (id === undefined) return [gray(ui.tasks.stop() ? "Stopped every subagent." : "No subagent is running.")];
      if (!ui.tasks.all.some((t) => t.id === id)) return [none(id)];
      return [gray(ui.tasks.stop(id) ? `Stopped ${id}.` : `${id} is not running.`)];
    }
    if (id !== undefined) return [{ text: "Usage: /tasks, /tasks <number>, /tasks stop [<number>]", color: "red" }];
    const t = ui.tasks.all.find((x) => x.id === verb);
    return t ? fns.recordOf(t) : [none(verb)];
  };
  // `/hooks`: the hooks in force, read-only, by event in the file's order, each by its name (answer.ts, hookName), then
  // its matcher when not every value, its own timeout when it sets one and `async` for an async one (the user's choice,
  // 2026-11-10, terminal checklist), then the ones left out, in the approved words, each hook in them by its name too
  // (settings.ts, hooksOf; release 8b plan, choice 25 and "Lines this plan adds"). Hook text is escaped as the question
  // escapes a command; the file is named as the launch names it (settings.ts, shownFile).
  const hooksList = (): Line[] => {
    const { hooks, off, leftOut } = ui.hooks?.config ?? { hooks: [], off: false, leftOut: [] };
    if (off) return [gray(`Hooks are off: "disableAllHooks" is true in ${shownFile()}.`)];
    const events = new Map<string, string[]>();
    for (const h of hooks) {
      const matcher = "all" in h.matcher ? "" : ` · ${visible("names" in h.matcher ? h.matcher.names.join("|") : h.matcher.regex.source)}`;
      const row = `  ${visible(hookName(h))}${matcher}${h.timeout === undefined ? "" : ` · ${limitOf(h)} s`}${h.async ? " · async" : ""}`;
      events.set(h.event, [...(events.get(h.event) ?? []), row]);
    }
    const listed = hooks.length
      ? [`Hooks in force, from ${shownFile()}:`, ...[...events].flatMap(([event, rows]) => [event, ...rows])]
      : [`No hooks in force. They go in "hooks" in ${shownFile()}.`];
    return [...listed, ...(leftOut.length ? ["Left out:", ...leftOut.map((w) => `  ${visible(w)}`)] : [])].map(gray);
  };
  // `/mcp` (release 8c plan, Task 10; choice 27): the servers' list (McpList.tsx), holding the queue until it closes, as
  // /resume's does; with none, where they go, the file named as the launch names it (settings.ts, shownFile). True when
  // it opened.
  const mcpOpen = (): boolean | void => {
    if (!ui.mcp?.servers.list().length) return fns.say(gray(`No MCP servers. They go in "mcpServers" in ${shownFile()}, or in a project's .mcp.json.`));
    ui.listOpen.current = true;
    ui.setMcpList(true);
    return true;
  };
  const closeMcp = () => {
    ui.listOpen.current = false;
    ui.setMcpList(false);
    fns.next();
  };
  // A server's action, picked in /mcp's list. Reconnect keeps the list open, which redraws as the server starts, then as
  // its start ends (McpList.tsx); Show tools prints the server's tools into the conversation, as /hooks prints its list,
  // then the ones left out, in their lines' words (Servers, tools); Reset my answer writes the reset (choice 24) and says
  // so, or, when it cannot be written, that the answer still holds (choice 52). What is said is asked for, shown at the
  // bottom, as the model list's pick says (pick, below).
  const mcpAction = (name: string, action: Action) => {
    const servers = ui.mcp!.servers;
    if (action === "Reconnect") return void servers.restart(name);
    ui.view.current = FOLLOWING;
    if (action === "Sign in" || action === "Sign out") return void account(name, action);
    const shown = visible(name);
    if (action === "Show tools") {
      const { names, leftOut } = servers.tools(name); // each tool's own name (release 8c plan, Task 16; choice 66)
      fns.say(...[`${shown}'s tools:`, ...names.map((n) => `  ${visible(n)}`), ...(leftOut.length ? ["Left out:", ...leftOut.map((w) => `  ${visible(w)}`)] : [])].map(gray));
    } else {
      try {
        servers.reset(name);
        fns.say(gray(`Your answer for ${shown} was reset; Tachikoma asks again at the next launch.`));
      } catch (err) {
        fns.say({ text: `Your answer for ${shown} could not be reset (${visible(errorText(err), { tabs: true })}); the next launch still uses it.`, color: "red" });
      }
    }
    closeMcp();
  };
  // /mcp's Sign in and Sign out (Task 11), run as /login and /logout are: their working line, what is typed waiting in the
  // queue, Esc stopping a sign-in through its own signal, which also cancels its question, the window's own yes/no. The
  // lines are the plan's; Esc says nothing more, as the user stopped it; a sign-out that cannot be written says so, and the
  // sign-in stays (choice 56).
  const account = async (name: string, action: "Sign in" | "Sign out") => {
    const servers = ui.mcp!.servers;
    const shown = visible(name);
    const { signal } = (ui.abort.current = new AbortController());
    ui.doing.current = { label: action === "Sign in" ? "Waiting for the browser" : "Signing out", at: Date.now(), from: null };
    ui.setNow(ui.doing.current.at);
    ui.setBusy(true);
    ui.working.current = true;
    closeMcp(); // the queue waits for this, as it works
    try {
      if (action === "Sign out") {
        await servers.signOut(name);
        fns.say(gray(`Signed out of ${shown}.`));
      } else {
        const ask = (question: string) => ui.asking.current?.(question, undefined, undefined, true) ?? Promise.resolve(false);
        if (await servers.signIn(name, { ask, say: (line) => fns.say(gray(line)), signal })) fns.say(gray(`Signed in to ${shown}.`));
      }
    } catch (err) {
      const why = visible(errorText(err), { tabs: true });
      if (action === "Sign out") fns.say({ text: `Sign-out of ${shown} failed: ${why}`, color: "red" });
      else if (!signal.aborted) fns.say({ text: `Sign-in to ${shown} failed: ${why}`, color: "red" });
    } finally {
      ui.setBusy(false);
      ui.working.current = false;
      fns.next();
    }
  };
  // `/tasks t3`'s record: the subagent's tool calls and answer in full.
  const recordOf = (t: Task): Line[] => {
    const calls = callLines(t.messages);
    const end = t.state === "done" ? `Answer:\n${t.answer}` : t.state === "failed" ? `Failed: ${t.answer}` : t.answer ?? "(still running)";
    return [gray(`${t.id} (${t.description}), ${t.state}: ${calls.length} tool call${calls.length === 1 ? "" : "s"}`), ...calls, gray(end)];
  };

  // Picking does what `/lead <provider:model>` does. What it says ("lead is now ...", from the bus, or why not) is asked-for
  // output, shown at the bottom (release 5 design, "Scrolling"), as the wheel can scroll the view while the list is open.
  const pick = (spec: string) => {
    ui.listOpen.current = false;
    ui.setPicker(null);
    ui.view.current = FOLLOWING;
    // The pick comes after any edit of the file's lead made while the list was open, so it wins, as a /lead typed
    // then would.
    ui.waiting.current.lead = undefined;
    void leadTo(spec)
      .catch((err) => fns.say({ text: errorText(err), color: "red" }))
      .finally(fns.next);
  };
  // A shortening between turns, for /lead and /compact, run as a turn is: the working line and its spinner, what is typed
  // waiting in the queue, and Ctrl-C stopping it through its own signal, handed back with what it gave.
  const between = async <T>(run: (signal: AbortSignal) => Promise<T>) => {
    const { signal } = (ui.abort.current = new AbortController());
    ui.doing.current = { label: "Working", at: Date.now(), from: { output: ui.stats.output, cost: ui.stats.cost, unpriced: ui.stats.unpriced } };
    ui.setNow(ui.doing.current.at);
    ui.setBusy(true);
    ui.working.current = true;
    try {
      return { got: await run(signal), signal };
    } finally {
      ui.setBusy(false);
      ui.working.current = false;
    }
  };
  // `/lead <provider:model>` and the model list's pick, this window only, saving nothing (choice 26, the user's). A
  // conversation that will not fit the new lead's smaller window is shortened first, by the lead leading now, and the
  // switch is refused if it cannot be (release 8a design, "When to shorten"). Meanwhile it works as a turn does: what is
  // typed waits in the queue, and Ctrl-C stops it, quietly, the lead staying as it was, as a stopped turn says nothing.
  const leadTo = async (spec: string) => {
    const provider = fns.make(spec);
    // With nothing to shorten, or no window to look up, no check can be needed: the switch is made at once, so a prompt
    // typed straight after /lead waits for it in the queue as one of its own (Task 13's spec review).
    if (!ui.session.messages.length || !provider.contextWindow) return ui.session.setLead(provider);
    const { got: problem, signal } = await between((signal) => ui.session.makeRoom(provider, signal));
    if (signal.aborted) return;
    if (problem === undefined) return ui.session.setLead(provider);
    fns.say({ text: `${spec} was not made the lead: the conversation does not fit its window and could not be shortened (${problem}).`, color: "red" });
  };
  // /compact [words]: the whole conversation shortened now, the words its summary's focus (release 8a plan, Task 13). It
  // works as leadTo does: what is typed waits in the queue, and Ctrl-C stops it. A failure's red line comes from the
  // session (session.ts, compact); a stop's is said here, as the user asked for the shortening, drawn as onError draws
  // the session's (App.tsx).
  const compact = async (focus: string) => {
    if (!ui.session.messages.length) return fns.say(gray(SHORTEN_WORDS.nothing));
    const { got: problem } = await between((signal) => ui.session.compact(focus, signal));
    if (problem === CANCELLED) fns.say({ text: `✗ ${cannot(CANCELLED)}`, color: "red" });
  };
  // /autocompact <tokens> or off (choice 26): digits with an optional k or m, k 1,000 and m 1,000,000 as Claude Code's
  // `/autocompact 500k` (plan, "Numbers in this plan"); this window only, saving nothing, as /vim.
  const autoCompact = (words: string[]) => {
    const [word = "", ...more] = words.map((w) => w.toLowerCase());
    const m = /^(\d+)([km]?)$/.exec(word);
    const n = m ? Number(m[1]) * (m[2] === "k" ? 1_000 : m[2] === "m" ? 1_000_000 : 1) : NaN;
    if (more.length || (word !== "off" && !(Number.isSafeInteger(n) && n >= 1))) return fns.say({ text: SHORTEN_WORDS.usage, color: "red" });
    ui.session.autoCompact = word === "off" ? null : n;
    fns.say(gray(word === "off" ? SHORTEN_WORDS.off : SHORTEN_WORDS.passes(n)));
  };
  const closePicker = () => {
    ui.listOpen.current = false;
    ui.setPicker(null);
    fns.next();
  };
  // Leaving the session (/exit, and Ctrl-C or Ctrl-D twice): Ink ends, as ever. No turn runs then, as /exit waits for it in
  // the queue and the exit keys do nothing during one (keyRouting.ts), so only the subagents are stopped, first, in every
  // mode. In copy mode the box is stopped next, and once Docker reports it gone the review (Review.tsx) opens in the App's
  // place, Ink still mounted, under the lock beside the copy's folder, so two reviews of one copy take turns; its lines are
  // handed back, to print once Ink has ended (release 7 plan, Task 21). From the first step the App's own keys, pastes
  // and mouse are off (phase.ts, review), and nothing more starts. A view printed out comes back first, so the review
  // can draw. A copy with nothing to review is removed instead, its line printed (choice 121; copies.ts, dropIfNothing).
  // Then, in every mode, SessionEnd fires (endSession, below) before Ink ends (release 8b plan, Task 10).
  const leave = () => {
    if (ui.leaving.current) return;
    ui.leaving.current = true;
    ui.tasks.stop();
    ui.rerender((n) => n + 1);
    const c = ui.copy;
    void (c ? review(c) : Promise.resolve())
      .then(endSession)
      .finally(() => ui.exit());
  };
  // SessionEnd as the user leaves, once copy mode's review is done: the screen stays as it is meanwhile, its keys off
  // (phase.ts, review), and its hooks have 1.5 s, or a hook's own longer timeout up to 60 s (hooks.ts). Its lines are said
  // in the window as any hook's are. Where the window cannot show them, in full screen, which takes them away with the
  // second screen, and in copy mode, whose review or leaving line is drawn in place of everything, they are handed back
  // too, the same words escaped as hook lines are, to print once Ink has ended, so none is lost (approved by the user,
  // 2026-11-09; Task 10's spec review).
  const endSession = async () => {
    const said: string[] = [];
    // As App.tsx's onError draws a hook's failure, the line alone; the window shows a hook's note so too (Task 12).
    const onError = (e: ErrorEvent) => void (e.kind === "hook" && e.attempted === "SessionEnd hook" && said.push(`✗ ${e.message}`));
    const onNote = (line: string) => void (line.startsWith("SessionEnd hook: ") && said.push(line));
    ui.bus.on("error", onError);
    ui.bus.on("hook-note", onNote);
    try {
      await ui.session.end("prompt_input_exit");
    } catch {
      // Only a listener of its lines that throws gets here; the window closes all the same.
    } finally {
      ui.bus.off("error", onError);
      ui.bus.off("hook-note", onNote);
    }
    if (!said.length) return;
    if (ui.fullNow.current || ui.copy) ui.leftLines?.(said.map((l) => visible(l, { tabs: true })));
    // In plain classic mode they stay in the terminal: React commits them before Ink ends, as /screen waits for it
    // (handover.tsx).
    else await new Promise((resolve) => setTimeout(resolve, 0));
  };
  // Copy mode's part of leaving (leave, above). Its failures are its own lines, so it never rejects.
  const review = (c: NonNullable<UI["copy"]>) =>
    (async () => {
      await fns.comeBack();
      if (!(await c.stop())) return c.ended([NOT_GONE, kept(c.copy.session)]);
      await withLock(copyLock(c.copy.folder), async () => {
        // Nothing to review: no review, and the copy is removed (choice 121), before git's settings are read, as they
        // only matter to a review.
        const read = await dropIfNothing(c.copy, (line) => {
          ui.leavingLine.current = line;
          ui.rerender((n) => n + 1);
        }, c.remove);
        if (typeof read === "string") return c.ended([read]);
        // Without git's settings a hooks folder they name is not marked protected, so a file in it could be applied
        // unseen: no review, and the copy is kept (Task 21's review).
        let protection: Protection;
        try {
          protection = await c.protection();
        } catch (err) {
          return c.ended([visible(reviewUnopened(errorText(err))), kept(c.copy.session)]);
        }
        const end = await new Promise<ReviewEnd>((onEnd) => ui.setReviewing({ protection, onEnd, read }));
        c.ended(end.lines);
      });
    })().catch((err) => c.ended([visible(errorText(err)), kept(c.copy.session)]));
  // /clear, /resume and /branch are refused while a subagent runs, so no answer can arrive in the wrong session (release 8a
  // design, "Resuming"); during a turn they wait in the queue, as every command does. Null when none runs.
  const subagentsRunning = (command: string): Line | null => {
    const ids = ui.tasks.all.filter((t) => t.state === "running" || t.state === "waiting").map((t) => t.id).join(", ");
    return ids ? { text: `${command} waits until no subagent is running: ${ids} still running. /tasks stop stops them.`, color: "red" } : null;
  };
  // The window takes another session (release 8a plan, choice 15): the last one's shown calls, to-do list, answers and
  // tool line go, and the gauge's context, 0 until the next request. The subagents' waiting text is dropped: an answer
  // that wakes the lead was read in a turn of its own before this command ran (next), so what is left is a stopped
  // subagent's note, which belongs to the last conversation. The conversation is loaded first: a load refused, as one is
  // while a turn runs (a prompt read with /resume in one read of the terminal starts its turn under the list), lets the
  // next session go and leaves the turn's state as it was. Then the last session is let go, and the conversation drawn
  // as the launch draws a resumed one, and its lines said, so a saving failure the load reports comes first (Task 7). The
  // window's sandbox carries on: a copy-mode box is not started afresh, so its review at exit covers both sessions'
  // changes (Task 7). Another conversation's finished subagents leave /tasks and the panel. A branch is the same
  // conversation, so it keeps them, its waiting text, shown calls, to-do list, answers and gauge, and is not drawn again
  // (release 8a final review, user, 2026-11-07: "Clear them", "Drop the reprint", "Keep them too"). The session left ends
  // first, with SessionEnd's `end` reason, and the one opened starts last, with SessionStart's `start` source, once its saved
  // lead leads (release 8b plan, Task 10 and choice 18). Meanwhile what is typed waits in the queue (`working`, set by the
  // callers), as during a turn.
  // While SessionEnd's hooks run the working line shows, and Esc, or Ctrl-C, stops them through its own signal, as it stops
  // a turn, and the switch goes ahead (the user's choice, 2026-11-09: "Esc stops it").
  const switchTo = async (next: Opened, lines: Line[], how: { end: "clear" | "resume" | "other"; start: "clear" | "resume" | "fork"; lead?: Provider }) => {
    const branched = how.start === "fork";
    const shown = ui.session.ends(how.end);
    let signal: AbortSignal | undefined;
    if (shown) {
      signal = (ui.abort.current = new AbortController()).signal;
      ui.doing.current = { label: "Working", at: Date.now(), from: null };
      ui.setNow(ui.doing.current.at);
      ui.setBusy(true);
    }
    try {
      await ui.session.end(how.end, signal);
      ui.session.load(next.conversation, { keepRuns: branched }); // a branch keeps its hook runs too (the user, 2026-11-10)
    } catch (err) {
      next.release();
      throw err;
    } finally {
      if (shown) ui.setBusy(false);
    }
    ui.saved.switched(next);
    if (!branched) {
      ui.tasks.take();
      ui.tasks.forgetFinished();
      ui.calls.current = [];
      ui.summary.current = null;
      ui.todos.current = { items: [], hidden: false };
      ui.answered.current.clear();
      ui.stats.context = 0;
    }
    // Folded by the window's rules, the session's asked calls now the loaded conversation's (release 8c plan, Task 15).
    fns.say(...(branched ? [] : conversationLines(next.conversation.messages, ui.run.options)), ...lines);
    ui.rerender((n) => n + 1);
    if (how.lead) {
      ui.waiting.current.lead = undefined; // it wins over a lead the settings file set meanwhile, as a /lead typed then would
      ui.session.setLead(how.lead);
    }
    ui.session.start(how.start);
  };
  // /clear: a new session, with the same lead and mode, its system prompt built afresh (design, "Resuming").
  const startFresh = async () => {
    const system = await ui.session.freshSystem();
    await switchTo(ui.saved.fresh(ui.session.lead.id, system), [gray("Started a new session; the last one is kept (tachi --resume lists it).")], {
      end: "clear",
      start: "clear",
    });
  };
  // /resume: the folder's other saved sessions, in the list `tachi -r` shows (choice 14). True when it opened, holding the
  // queue until a pick or Esc, as the model list does.
  const resume = (): boolean | void => {
    const rows = listSessions(ui.saved.dir, { print: false }).filter((r) => r.id !== ui.session.id);
    if (!rows.length) return fns.say(gray(SESSION_WORDS.noOther));
    ui.listOpen.current = true;
    ui.setSessions({ rows, now: Date.now() });
    return true;
  };
  // A pick opens the session as the launch opens it, a copy when another window holds it (Task 6); one that cannot be
  // read or copied is said in red, and the window stays in its session (design, "When something goes wrong"). It leads
  // with its saved lead, switched to as /lead switches, once its conversation is loaded; one that cannot be made leaves
  // the window's leading, with the launch's line (user, 2026-11-06: "The session's saved lead").
  const pickSession = async (id: string) => {
    ui.listOpen.current = false;
    ui.setSessions(null);
    ui.view.current = FOLLOWING; // what it says is asked for, as the model list's pick says (pick, above)
    // While SessionEnd's hooks run (switchTo), what is typed waits in the queue. A turn started under the list holds it
    // already, and is left alone: the switch is refused (Session.end).
    const hold = !ui.working.current;
    if (hold) ui.working.current = true;
    try {
      const now = ui.session.lead.id;
      let made: Provider | undefined;
      let gone: string | undefined;
      const next = ui.saved.resume(id, (saved) => {
        if (saved === now) return now;
        try {
          made = fns.make(saved);
          return saved;
        } catch (err) {
          gone = leadGone(saved, err, now);
          return now;
        }
      });
      if ("problem" in next) fns.say({ text: next.problem, color: "red" });
      else {
        const lines = [...next.lines, ...(gone ? [{ text: gone }] : [])].map((l) => ({ ...l, color: "gray" as const }));
        await switchTo(next, lines, { end: "resume", start: "resume", ...(made ? { lead: made } : {}) });
      }
    } catch (err) {
      fns.say({ text: errorText(err), color: "red" });
    } finally {
      if (hold) ui.working.current = false;
    }
    fns.next();
  };
  const closeSessions = () => {
    ui.listOpen.current = false;
    ui.setSessions(null);
    fns.next();
  };
  // /branch [name]: a copy of this session, named, which the window carries on in (design, "Names, branches and export").
  // Without a name it takes the first prompt's first line, as the resume line names a session. A session with no
  // prompt has nothing to copy, and one whose saving stopped would leave out what came after.
  const branch = async (name: string) => {
    const first = ui.session.prompts[0]?.split(/\r?\n/)[0];
    if (!first) return fns.say(gray(SESSION_WORDS.nothingToBranch));
    if (!ui.session.transcript || ui.session.transcript.failed !== null) return fns.say({ text: SESSION_WORDS.unsaved("/branch"), color: "red" });
    const original = ui.session.id;
    const named = name || first;
    const next = ui.saved.branch(original, ui.session.lead.id, named);
    if ("problem" in next) return fns.say({ text: next.problem, color: "red" });
    await switchTo(next, [gray(`Branched: this window is now ${named}; the original is kept as ${original}.`)], { end: "other", start: "fork" });
  };
  // /rename <name> names this session in its transcript, as the lists then show it (design, "Names, branches and export").
  const rename = (name: string) => {
    if (!name) return fns.say({ text: "Usage: /rename <name>", color: "red" });
    const t = ui.session.transcript;
    t?.write({ t: "name", name });
    fns.say(!t || t.failed !== null ? { text: SESSION_WORDS.unsaved("/rename"), color: "red" } : gray(`Session named ${name}.`));
  };
  // /export [file]: the conversation as text (core/exportText.ts), a reply saved without its lead headed by the one leading
  // now. To a file, from the project folder, made with `wx` so one already there is never written over (release 8a plan,
  // choice 27); alone, to the clipboard, whose own failure line follows in the hint row as a selection's copy's does
  // (clipboard.ts).
  const exportTo = async (file: string) => {
    const text = exportText(ui.session.messages, ui.session.lead.id);
    if (!file) {
      ui.board.current!.copy(text);
      return fns.say(gray(`Copied the conversation (${characters(text)} characters).`));
    }
    // A name in matching quotes, as a dropped path comes, is taken out of them: on Windows only ", as an apostrophe is
    // part of a name there (clipboard.ts, unquoted).
    const to = path.resolve(ui.root, unquoted(file, process.platform === "win32"));
    const there = () => fns.say({ text: `${to} already exists; nothing was written.`, color: "red" });
    try {
      // A link at the name counts as a file there: on Windows `wx` follows one, a junction to a missing folder making
      // that folder (Task 8's quality review). Links in the folders above are a known limit. Not sync, so a share that
      // does not answer holds no key.
      const taken = await lstat(to).catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return undefined;
        throw e;
      });
      if (taken) return there();
      await writeFile(to, text, { flag: "wx" });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "EEXIST") return there();
      // Node's code and words, without the path they end with, as the line names the file already.
      const why = e.syscall && e.path ? e.message.replace(`, ${e.syscall} '${e.path}'`, "") : errorText(err);
      return fns.say({ text: EXPORT_WORDS.unwritten(to, why), color: "red" });
    }
    fns.say(gray(`Exported to ${to}.`));
  };
  return {
    submit, next, recordToOpen, perform, tasksCommand, recordOf, pick, closePicker, leave, subagentsRunning, startFresh, resume,
    pickSession, closeSessions, branch, rename, exportTo, mcpAction, closeMcp,
  };
};

// Why what the MCP servers supply for a prompt was not got: its red line, and whether the grey line saying the words are
// back follows it (supply, above).
type Refused = { line: string; said: boolean };

// The item `typed` names: by its key in the same letter case first, then in any (Task 13's fix round).
const named = <T>(items: T[], typed: string, key: (t: T) => string): T | undefined =>
  items.find((t) => key(t) === typed) ?? items.find((t) => key(t).toLowerCase() === typed.toLowerCase());

// A prompt command's words as its arguments (release 8c plan, choice 31): split at blanks, each word the next argument's,
// the last argument taking the rest as typed, line breaks and all; or the first needed one that is not given.
function argumentsOf(prompt: Prompt, words: string): { args: Record<string, string> } | { missing: string } {
  const list = prompt.arguments ?? [];
  const args: Record<string, string> = {};
  let rest = words.trim();
  for (const [i, a] of list.entries()) {
    if (!rest) break;
    const word = i === list.length - 1 ? rest : /^\S+/.exec(rest)![0];
    args[a.name] = word;
    rest = rest.slice(word.length).trimStart();
  }
  const missing = list.find((a) => a.required && !Object.hasOwn(args, a.name));
  return missing ? { missing: missing.name } : { args };
}
