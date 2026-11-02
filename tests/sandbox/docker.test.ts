import { describe, expect, it } from "vitest";
import { type DockerRun, dockerState, lineSplitter } from "../../src/sandbox/docker.js";

// A stand-in for Docker (release 7 plan, choice 69): it records each call's arguments and gives a set answer. No file is
// written or run, and PATH is not changed.
function fakeDocker(answer: Awaited<ReturnType<DockerRun>>) {
  const calls: string[][] = [];
  const run: DockerRun = async (args) => {
    calls.push(args);
    return answer;
  };
  return { run, calls };
}

describe("dockerState", () => {
  it("asks for the server's OS, and is ready when it is Linux", async () => {
    const docker = fakeDocker({ code: 0, out: "linux\n", err: "" });
    expect(await dockerState(docker.run)).toBe("ready");
    expect(docker.calls).toEqual([["version", "--format", "{{.Server.Os}}"]]);
  });

  it("is windows when Docker is set to Windows containers (choice 78)", async () => {
    expect(await dockerState(fakeDocker({ code: 0, out: "windows\n", err: "" }).run)).toBe("windows");
  });

  it("is denied when this user is not allowed to use Docker (choice 78)", async () => {
    const err = "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: connect: Permission Denied\n";
    expect(await dockerState(fakeDocker({ code: 1, out: "\n", err }).run)).toBe("denied");
  });

  it("is missing when no docker program is found", async () => {
    expect(await dockerState(fakeDocker("missing").run)).toBe("missing");
  });

  it("is stopped when the client cannot reach the server", async () => {
    const err = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n";
    const docker = fakeDocker({ code: 1, out: "\n", err });
    expect(await dockerState(docker.run)).toBe("stopped");
  });
});

describe("lineSplitter", () => {
  it("gives each whole line as it comes, then what is left at the end", () => {
    const lines: string[] = [];
    const split = lineSplitter((line) => lines.push(line));
    split.add("#1 [internal] load");
    split.add(" build definition\r\n#2 done\n\n#3 ");
    expect(lines).toEqual(["#1 [internal] load build definition", "#2 done", ""]);
    split.add("last");
    split.end();
    expect(lines).toEqual(["#1 [internal] load build definition", "#2 done", "", "#3 last"]);
  });

  it("gives nothing at the end when the output ended with a new line", () => {
    const lines: string[] = [];
    const split = lineSplitter((line) => lines.push(line));
    split.add("one\n");
    split.end();
    expect(lines).toEqual(["one"]);
  });
});
