// For tests/cli.test.ts: given to the real command with `--import`, it has the command's input and output, pipes to and
// from the test, pass for a terminal, so the window launches and Ink reads its keys (release 8c plan, Task 9): the
// launch's questions and the window's keys arrive as the test writes them, and raw mode does nothing, as a pipe has
// none. Ink takes a terminal as one only outside CI, which the test's variables say it is not.
Object.defineProperty(process.stdin, "isTTY", { value: true });
process.stdin.setRawMode = function () {
  return this;
};
// The size of tests/tui/app.test.tsx's own stand-in terminal: 100 columns, and Ink's default 24 rows (getWindowSize).
Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 24 });
