import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { API_KEYS, commandEnv } from "../../src/exec/env.js";
import { hubEnv, uvEnv } from "../../src/memory/env.js";
import { memoryPaths } from "../../src/memory/paths.js";

// The two environments of Tachikoma's own memory (8d plan, step 16), on made-up environments only: nothing is started.
const data = path.join(tmpdir(), "tachi-data-not-made");
const paths = (platform: NodeJS.Platform) => memoryPaths(data, "0123456789ab", platform);

// A user's environment holding the API keys, the user's own MemPalace and uv settings, the user's home and Temp in
// two spellings, and settings that would let the hub fetch or report.
const user: NodeJS.ProcessEnv = {
  Path: "C:\\Windows\\System32",
  ANTHROPIC_API_KEY: "a",
  openai_api_key: "b",
  OPENROUTER_API_KEY: "c",
  MOONSHOT_API_KEY: "d",
  MEMPALACE_MCP_ALLOW_PEER_WRITER: "1",
  MEMPALACE_MCP_IDLE_HOURS: "8",
  mempalace_embedding_model: "embeddinggemma",
  MEMPALACE_PALACE_PATH: "C:\\Users\\someone\\.mempalace\\palace",
  UV_CACHE_DIR: "C:\\Users\\someone\\AppData\\Local\\uv\\cache",
  uv_index_url: "https://example.invalid/simple",
  UV_PYTHON_PREFERENCE: "system",
  UV_OFFLINE: "1",
  UV_INDEX_STRATEGY: "unsafe-best-match",
  VIRTUAL_ENV: "C:\\Users\\someone\\.venv",
  PYTHONPATH: "C:\\Users\\someone\\lib",
  PythonHome: "C:\\Python",
  USERPROFILE: "C:\\Users\\someone",
  userprofile: "C:\\Users\\someone",
  HOME: "/home/someone",
  TEMP: "C:\\Users\\someone\\AppData\\Local\\Temp",
  tmp: "C:\\Users\\someone\\AppData\\Local\\Temp",
  TMPDIR: "/tmp",
  APPDATA: "C:\\Users\\someone\\AppData\\Roaming",
  localappdata: "C:\\Users\\someone\\AppData\\Local",
  XDG_DATA_HOME: "/home/someone/.local/share",
  xdg_state_home: "/home/someone/.local/state",
  XDG_CACHE_HOME: "/home/someone/.cache",
  XDG_CONFIG_HOME: "/home/someone/.config",
  HF_HOME: "C:\\Users\\someone\\.cache\\huggingface",
  HF_HUB_OFFLINE: "0",
  HF_HUB_CACHE: "C:\\Users\\someone\\.cache\\huggingface\\hub",
  huggingface_hub_cache: "C:\\Users\\someone\\.cache\\huggingface\\hub",
  TRANSFORMERS_OFFLINE: "0",
  ANONYMIZED_TELEMETRY: "true",
  CHROMA_OTEL_COLLECTION_ENDPOINT: "https://example.invalid/otel",
  chroma_otel_granularity: "all",
};

const THREE = ["MEMPALACE_EMBEDDING_MODEL", "MEMPALACE_MCP_WRITER_WAIT_SECONDS", "MEMPALACE_MCP_IDLE_HOURS"];
const PLATFORMS = ["win32", "linux", "darwin"] as const;
const names = (env: NodeJS.ProcessEnv) => Object.keys(env).map((k) => k.toUpperCase());
const inside = (file: string, folder: string) => {
  const rel = path.relative(folder, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

describe("the memory environments", () => {
  it("hold no API key, in any case", () => {
    for (const platform of PLATFORMS) {
      for (const env of [uvEnv(paths(platform), user, platform), hubEnv(paths(platform), user, platform)]) {
        for (const key of API_KEYS) expect(names(env)).not.toContain(key);
      }
    }
  });

  it("give Windows USERPROFILE and the others HOME, the memory folder's home, in one spelling", () => {
    for (const make of [uvEnv, hubEnv]) {
      const win = make(paths("win32"), user, "win32");
      expect(win.USERPROFILE).toBe(paths("win32").home);
      expect(names(win).filter((k) => k === "USERPROFILE")).toHaveLength(1);
      for (const platform of ["linux", "darwin"] as const) {
        const env = make(paths(platform), user, platform);
        expect(env.HOME).toBe(paths(platform).home);
        expect(names(env).filter((k) => k === "HOME")).toHaveLength(1);
      }
    }
  });

  // Python's tempfile looks at TMPDIR, then TEMP, then TMP on every system, so all three are set.
  it("put the temp folder inside memory/: TEMP, TMP and TMPDIR, in one spelling each", () => {
    for (const make of [uvEnv, hubEnv]) {
      for (const platform of PLATFORMS) {
        const env = make(paths(platform), user, platform);
        for (const name of ["TEMP", "TMP", "TMPDIR"]) expect(env[name], name).toBe(paths(platform).tmp);
        expect(names(env).filter((k) => ["TEMP", "TMP", "TMPDIR"].includes(k))).toHaveLength(3);
      }
    }
  });

  // The user's choice after the final review, "Redirect AppData too": on Windows, AppData in memory/'s home, laid out
  // as tests/memory/real.test.ts's real run had it (appData there). The user's own program keeps the user's.
  it(
    "give Windows APPDATA and LOCALAPPDATA inside memory/'s home, in one spelling each; the \"use\" program the user's",
    () => {
      const p = paths("win32");
      for (const make of [uvEnv, hubEnv]) {
        const env = make(p, user, "win32");
        expect(env.APPDATA).toBe(path.join(p.home, "AppData", "Roaming"));
        expect(env.LOCALAPPDATA).toBe(path.join(p.home, "AppData", "Local"));
        for (const name of ["APPDATA", "LOCALAPPDATA"]) {
          expect(names(env).filter((k) => k === name), name).toHaveLength(1);
        }
      }
      const use = commandEnv(user, "win32");
      expect(use.APPDATA).toBe(user.APPDATA);
      expect(use.localappdata).toBe(user.localappdata);
    });

  // The user's choice after the final review's re-check, "Fix both": HOME on Windows too, and the four XDG base
  // folders on every system, each where the XDG spec puts it under a home. The user's own program keeps the user's.
  const XDG: Record<string, string[]> = {
    XDG_DATA_HOME: [".local", "share"],
    XDG_STATE_HOME: [".local", "state"],
    XDG_CACHE_HOME: [".cache"],
    XDG_CONFIG_HOME: [".config"],
  };

  it("give Windows HOME too, memory/'s home, in one spelling; the \"use\" program the user's", () => {
    const p = paths("win32");
    for (const make of [uvEnv, hubEnv]) {
      const env = make(p, user, "win32");
      expect(env.HOME).toBe(p.home);
      expect(names(env).filter((k) => k === "HOME")).toHaveLength(1);
    }
    expect(commandEnv(user, "win32").HOME).toBe(user.HOME);
  });

  it(
    "put the four XDG folders inside memory/'s home on every system, one spelling each; the \"use\" program the user's",
    () => {
      for (const platform of PLATFORMS) {
        const p = paths(platform);
        for (const make of [uvEnv, hubEnv]) {
          const env = make(p, user, platform);
          for (const [name, parts] of Object.entries(XDG)) {
            expect(env[name], `${platform} ${name}`).toBe(path.join(p.home, ...parts));
            expect(names(env).filter((k) => k === name), name).toHaveLength(1);
          }
        }
        const use = commandEnv(user, platform);
        for (const name of ["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) expect(use[name]).toBe(user[name]);
        expect(use.xdg_state_home).toBe(user.xdg_state_home);
      }
    });

  it("let none of the user's own MemPalace or uv settings through", () => {
    for (const platform of PLATFORMS) {
      const uv = uvEnv(paths(platform), user, platform);
      const hub = hubEnv(paths(platform), user, platform);
      for (const env of [uv, hub]) {
        expect(env.MEMPALACE_MCP_ALLOW_PEER_WRITER).toBeUndefined();
        expect(env.MEMPALACE_PALACE_PATH).toBeUndefined();
        expect(env.mempalace_embedding_model).toBeUndefined();
        expect(env.UV_OFFLINE).toBeUndefined();
        expect(env.UV_INDEX_STRATEGY).toBeUndefined();
        expect(env.VIRTUAL_ENV).toBeUndefined();
        expect(names(env).filter((k) => k.startsWith("PYTHON"))).toEqual([]);
      }
      expect(names(uv).filter((k) => k.startsWith("MEMPALACE_"))).toEqual([]);
      expect(names(hub).filter((k) => k.startsWith("UV_"))).toEqual([]);
    }
  });

  // The user's choice at step 16's review, "Keep download ones": uv's settings that only decide where and how it
  // downloads (uv's own list, https://docs.astral.sh/uv/reference/environment/, read 2026-11-20): certificates and
  // Python mirrors.
  const DOWNLOADS: NodeJS.ProcessEnv = {
    UV_NATIVE_TLS: "1",
    UV_SYSTEM_CERTS: "1",
    UV_PYTHON_INSTALL_MIRROR: "https://example.invalid/python",
    UV_ASTRAL_MIRROR_URL: "https://example.invalid/astral",
  };
  // The package indexes and their log-ins, no longer passed (the user's choice at step 19, "Drop the mirror
  // settings"): with one set, uv refuses a --locked install (uv issue #6349), and a locked install downloads from the
  // lock's own addresses.
  const INDEXES: NodeJS.ProcessEnv = {
    UV_INDEX: "company=https://example.invalid/index",
    UV_DEFAULT_INDEX: "https://example.invalid/default",
    UV_INDEX_URL: "https://example.invalid/simple",
    UV_EXTRA_INDEX_URL: "https://example.invalid/extra",
    UV_INDEX_COMPANY_USERNAME: "someone",
    UV_INDEX_COMPANY_PASSWORD: "secret",
    UV_KEYRING_PROVIDER: "subprocess",
  };

  it("pass the user's download settings through to uv unchanged, and none of them to the hub", () => {
    for (const platform of PLATFORMS) {
      const uv = uvEnv(paths(platform), { ...user, ...DOWNLOADS }, platform);
      for (const [name, value] of Object.entries(DOWNLOADS)) expect(uv[name], name).toBe(value);
      const hub = hubEnv(paths(platform), { ...user, ...DOWNLOADS }, platform);
      expect(names(hub).filter((k) => k.startsWith("UV_"))).toEqual([]);
    }
  });

  it("pass none of the user's package indexes or their log-ins to uv", () => {
    for (const platform of PLATFORMS) {
      const uv = uvEnv(paths(platform), { ...user, ...DOWNLOADS, ...INDEXES }, platform);
      for (const name of Object.keys(INDEXES)) expect(names(uv), name).not.toContain(name);
      expect(Object.keys(uv)).not.toContain("uv_index_url");
    }
  });

  it("still drop every other uv setting of the user's, and override the user's UV_CACHE_DIR", () => {
    for (const platform of PLATFORMS) {
      const p = paths(platform);
      const uv = uvEnv(p, { ...user, ...DOWNLOADS, UV_INDEX_STRATEGY: "unsafe-best-match" }, platform);
      expect(names(uv)).not.toContain("UV_INDEX_STRATEGY");
      expect(names(uv)).not.toContain("UV_OFFLINE");
      expect(uv.UV_CACHE_DIR).toBe(p.uvCache);
      expect(Object.values(uv)).not.toContain(user.UV_CACHE_DIR);
    }
  });

  // Names are compared without regard to case, as for every other name here: a kept name in another spelling is
  // kept, under its own spelling.
  it("keep a download setting written in lowercase, as it is", () => {
    for (const platform of PLATFORMS) {
      const uv = uvEnv(paths(platform), { ...user, uv_native_tls: "1" }, platform);
      expect(uv.uv_native_tls).toBe("1");
      expect(names(uv).filter((k) => k === "UV_NATIVE_TLS")).toHaveLength(1);
    }
  });

  it("give uv its cache and Python folders inside memory/, no config file, and only its own Pythons", () => {
    for (const platform of PLATFORMS) {
      const p = paths(platform);
      const uv = uvEnv(p, user, platform);
      expect(uv.UV_CACHE_DIR).toBe(p.uvCache);
      expect(uv.UV_PYTHON_INSTALL_DIR).toBe(p.python);
      expect(uv.UV_PYTHON_CACHE_DIR).toBe(p.pythonCache);
      expect(uv.UV_PYTHON_BIN_DIR).toBe(p.pythonBin);
      expect(uv.UV_NO_CONFIG).toBe("1");
      expect(uv.UV_PYTHON_PREFERENCE).toBe("only-managed");
      const set = Object.entries(uv).filter(([k]) => k.startsWith("UV_") && k.endsWith("_DIR"));
      expect(set).toHaveLength(4);
      for (const [k, v] of set) expect(inside(v!, p.root), k).toBe(true);
      expect(names(uv).filter((k) => k === "UV_CACHE_DIR")).toHaveLength(1);
    }
  });

  it("give the hub its config and model cache inside memory/, and the settings that keep it from fetching", () => {
    for (const platform of PLATFORMS) {
      const p = paths(platform);
      const hub = hubEnv(p, user, platform);
      expect(hub.MEMPALACE_CONFIG_DIR).toBe(path.join(p.home, ".config", "mempalace"));
      expect(hub.HF_HOME).toBe(path.join(p.home, ".cache", "huggingface"));
      expect(hub.HF_HUB_OFFLINE).toBe("1");
      expect(names(hub).filter((k) => k === "HF_HOME" || k === "HF_HUB_OFFLINE")).toHaveLength(2);
      // Hugging Face's library reads HF_HUB_CACHE, then HUGGINGFACE_HUB_CACHE, before HF_HOME
      // (huggingface_hub/constants.py:173-181).
      for (const gone of ["TRANSFORMERS_OFFLINE", "ANONYMIZED_TELEMETRY", "CHROMA_OTEL_COLLECTION_ENDPOINT",
        "CHROMA_OTEL_GRANULARITY", "HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE"]) {
        expect(names(hub)).not.toContain(gone);
      }
    }
  });

  it("start the hub with minilm, no wait for a writer and no idle exit; the \"use\" program gets none of the three",
    () => {
      for (const platform of PLATFORMS) {
        const hub = hubEnv(paths(platform), user, platform);
        expect(hub.MEMPALACE_EMBEDDING_MODEL).toBe("minilm");
        expect(hub.MEMPALACE_MCP_WRITER_WAIT_SECONDS).toBe("0");
        expect(hub.MEMPALACE_MCP_IDLE_HOURS).toBe("0");
        expect(names(hub).filter((k) => THREE.includes(k))).toHaveLength(3);
        const plain = { Path: user.Path, USERPROFILE: user.USERPROFILE };
        const use = commandEnv(plain, platform);
        for (const name of THREE) expect(names(use)).not.toContain(name);
        expect(use).toEqual(plain);
      }
    });

  it("keep the rest of the user's environment, such as PATH", () => {
    for (const platform of PLATFORMS) {
      expect(uvEnv(paths(platform), user, platform).Path).toBe(user.Path);
      expect(hubEnv(paths(platform), user, platform).Path).toBe(user.Path);
    }
  });
});
