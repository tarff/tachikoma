// Clickable links (OSC 8): whether the terminal takes them (clickable links plan, Task 1).

// The terminals Claude Code 2.1.323's own check (`cw`) takes by TERM_PROGRAM or LC_TERMINAL.
const KNOWN = ["ghostty", "Hyper", "kitty", "alacritty", "iTerm.app", "iTerm2", "WarpTerminal"];

// A version as supports-hyperlinks v3.2.0 reads one: a 3-4 digit value with no dots is 0.<first 1-2>.<last 2> (VTE's
// `4601` is 0.46.1); anything else is split at dots, each part parseInt's.
function parseVersion(value = ""): { major: number; minor: number } {
  if (/^\d{3,4}$/.test(value)) {
    const m = /(\d{1,2})(\d{2})/.exec(value) ?? [];
    return { major: 0, minor: parseInt(m[1] ?? "", 10) };
  }
  const parts = value.split(".").map((n) => parseInt(n, 10));
  return { major: parts[0] ?? NaN, minor: parts[1] ?? NaN };
}

// supports-hyperlinks v3.2.0, from its NETLIFY check on, without its command-line flags (plan, decision 1); chalk's
// `level` stands in for its supports-color check. Only its yes is used: Claude Code's `cw` goes on after its no.
function supportsHyperlink(env: NodeJS.ProcessEnv, level: number, platform: NodeJS.Platform): boolean {
  if (env.NETLIFY) return true;
  if (level === 0) return false;
  if ("WT_SESSION" in env) return true;
  if (platform === "win32") return false;
  if (env.CI || env.TEAMCITY_VERSION) return false;
  if (env.TERM_PROGRAM) {
    const version = parseVersion(env.TERM_PROGRAM_VERSION);
    switch (env.TERM_PROGRAM) {
      case "iTerm.app":
        return version.major === 3 ? version.minor >= 1 : version.major > 3;
      case "WezTerm":
        return version.major >= 20200620;
      case "vscode":
        return version.major > 1 || (version.major === 1 && version.minor >= 72);
      case "ghostty":
        return true;
    }
  }
  if (env.VTE_VERSION) {
    if (env.VTE_VERSION === "0.50.0") return false; // supports-hyperlinks: "throws a segfault"
    const version = parseVersion(env.VTE_VERSION);
    return version.major > 0 || version.minor >= 50;
  }
  return env.TERM === "alacritty";
}

// Whether to draw links. FORCE_HYPERLINK as Claude Code 2.1.323 reads it (`t7e`, `ps`): unset or empty decides
// nothing; off when, lower-cased and trimmed, it is 0, false, no or off, or when parseInt gives 0 (`00`, `0abc`); on
// otherwise. Not forced, output that is not a TTY gets none (plan, decision 2). Then supports-hyperlinks' yes, then
// Claude Code's own list (`cw`, its steps after supports-hyperlinks), which still runs on Windows.
export function hyperlinks(env: NodeJS.ProcessEnv, tty: boolean, level: number, platform = process.platform): boolean {
  const forced = env.FORCE_HYPERLINK;
  if (forced) return !(["0", "false", "no", "off"].includes(forced.toLowerCase().trim()) || parseInt(forced, 10) === 0);
  if (!tty) return false;
  if (supportsHyperlink(env, level, platform)) return true;
  const program = env.TERM_PROGRAM;
  if (program && KNOWN.includes(program)) return true;
  if (env.TERMINAL_EMULATOR === "JetBrains-JediTerm") return true;
  if (env.WT_SESSION && program !== "tmux" && !env.TMUX) return true;
  if (program === "tmux") {
    // tmux 3.4 or later, each part parseInt's
    const [major = NaN, minor = NaN] = (env.TERM_PROGRAM_VERSION ?? "").split(".").map((n) => parseInt(n, 10));
    if (major > 3 || (major === 3 && minor >= 4)) return true;
  }
  if (env.LC_TERMINAL && KNOWN.includes(env.LC_TERMINAL)) return true;
  return env.TERM?.includes("kitty") === true;
}
