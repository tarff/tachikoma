import { readFileSync } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { type Instance, type RenderOptions, render } from "ink";
import type { ComponentProps, ReactElement } from "react";
import { fullPossible } from "../clilib.js";
import { KEYBINDINGS, settingsDir } from "../core/datadir.js";
import { type Protection, visible } from "../core/permissions.js";
import type { Row } from "../core/sessions.js";
import { readKeybindings } from "../keybindings.js";
import { loadSettings, type Settings } from "../settings.js";
import { App } from "./App.js";
import { Bindings, DEFAULTS, tableOf } from "./bindings.js";
import { Review, type ReviewCopy, type ReviewEnd } from "./Review.js";
import { SessionList } from "./SessionList.js";
import { restoreOnExit, restoreWhenInkEnds, Screen, writeBestEffort } from "./terminal.js";
import { type Theme, ThemeContext, themeOf } from "./theme.js";

// What cli.tsx draws: the window, the review that `tachi review <name>` opens and the list `tachi -r` picks from. cli.tsx
// loads this file only when it draws one of them, so a run without a screen loads none of the screen code (cleanup plan,
// step 14a).

// A screen drawn alone before the session (`tachi review <name>`'s review, `tachi -r`'s list): in full screen where it can
// draw, with the keys file's bindings as it reads at this moment (its problems said first, on the normal screen); the
// mouse stays off, as nothing reads its reports. `draw` is given the bindings and the screen's close. Resolves once Ink
// has ended and the terminal is back, so the lines printed after it come after. Drawn in the look from `settings`, as the
// App is, so NO_COLOR and the light look reach it too (TUI design pass, Task 13).
async function drawAlone(settings: Settings, draw: (bindings: Bindings, close: () => void) => ReactElement): Promise<void> {
  const screen = new Screen((s) => process.stdout.write(s), (s) => writeBestEffort(1, s));
  let ink: Instance | undefined;
  restoreOnExit(screen, () => ink?.unmount());
  const bindings = keysNow();
  if (fullPossible(process.env, process.stdout.isTTY === true)) screen.setSecond(true);
  const theme = themeOf(settings, process.env, chalk.level, process.stdout.isTTY === true);
  ink = render(<ThemeContext value={theme}>{draw(bindings, () => ink?.unmount())}</ThemeContext>, {
    exitOnCtrlC: false,
  });
  const exited = ink.waitUntilExit();
  restoreWhenInkEnds(screen, exited);
  await exited;
}

// `tachi review` runs before the launch reads the settings, so it reads them here for their theme, quietly: a file that is
// broken or cannot be read is the default look, and its warnings are not said, so the review says and stops for nothing it
// did not before (Task 13).
export async function drawReview(copy: ReviewCopy, protection: Protection): Promise<ReviewEnd> {
  let end: ReviewEnd | undefined;
  const read = loadSettings();
  await drawAlone("problem" in read ? {} : read.settings, (bindings, close) => (
    <Review
      copy={copy}
      bindings={bindings}
      protection={protection}
      onEnd={(e) => {
        end = e;
        close();
      }}
    />
  ));
  return end!;
}

// The session picked from the list (release 8a plan, choice 12), or none when it was closed; in the launch's settings' look.
export async function drawSessions(rows: Row[], name: string | undefined, settings: Settings): Promise<string | undefined> {
  let picked: string | undefined;
  await drawAlone(settings, (bindings, close) => (
    <SessionList
      rows={rows}
      {...(name === undefined ? {} : { name })}
      now={Date.now()}
      bindings={bindings}
      onPick={(id) => {
        picked = id;
        close();
      }}
      onClose={close}
    />
  ));
  return picked;
}

// The keys file laid over the defaults, as a session's start reads it (settingsWatch.ts); a file that cannot be read is
// none, and one with a problem keeps the defaults, as a session keeps the keys before it.
function keysNow(): Bindings {
  let text: string;
  try {
    text = readFileSync(path.join(settingsDir(), KEYBINDINGS), "utf8");
  } catch {
    return new Bindings(tableOf(DEFAULTS));
  }
  const got = readKeybindings(text);
  if ("problem" in got) {
    console.error(visible(got.problem));
    return new Bindings(tableOf(DEFAULTS));
  }
  for (const problem of got.problems) console.error(visible(problem));
  return got.table;
}

// The window (cli.tsx, the interactive session): the App, given `props`, in the launch's theme, drawn by Ink with
// `options`.
export function drawWindow(theme: Theme, props: ComponentProps<typeof App>, options: RenderOptions): Instance {
  return render(
    <ThemeContext value={theme}>
      <App {...props} />
    </ThemeContext>,
    options,
  );
}
