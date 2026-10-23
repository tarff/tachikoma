import { createRequire } from "node:module";
import { errorText } from "../core/types.js";

// Loaded only when the keychain is used, so a machine the package has no build for runs everything else.
type Keyring = typeof import("@napi-rs/keyring");
let keyring: Keyring | undefined;

// The operating system's credential store, for `tachi login chatgpt --keychain` (release 2 design,
// "The keychain option"): Windows Credential Manager, the macOS Keychain or the Linux secret service,
// through @napi-rs/keyring 2.1.0. It holds only the key the saved login is sealed with (store.ts),
// which is short enough for one entry everywhere.

// On Linux only the secret service: without this the package falls back to the kernel keyring, which
// "will not persist across reboots" (its README).
const OPTIONS = { linux: { store: "secret-service" as const } };

export class KeychainError extends Error {}

export interface Keychain {
  read(name: string): string | null;
  write(name: string, text: string): void;
  clear(name: string): void;
}

// Each call reports a store that cannot be used as a KeychainError, with the package's reason.
function use<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new KeychainError(`The system keychain could not be used (${errorText(err)}).`);
  }
}

export function systemKeychain(service = "tachikoma"): Keychain {
  // Loading the package can fail too, so it happens inside use().
  const entry = (name: string) => {
    keyring ??= createRequire(import.meta.url)("@napi-rs/keyring") as Keyring;
    return new keyring.Entry(service, name, OPTIONS);
  };
  return {
    read: (name) => use(() => entry(name).getPassword()),
    write: (name, text) => use(() => entry(name).setPassword(text)),
    clear: (name) => void use(() => entry(name).deletePassword()),
  };
}
