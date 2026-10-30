import { describe, expect, it } from "vitest";
import { type Shell, shellOf, split } from "../../src/safety/split.js";

// Each line: the shell, the command line, and each command's words in the order they are found, or why the line cannot be read.
const TABLE: [Shell, string, string[][] | string][] = [
  ["bash", "", []],
  ["powershell", "", []],
  ["bash", "ls -la", [["ls", "-la"]]],
  ["bash", "a; a", [["a"]]], // each command once

  // Every separator
  ["bash", "a; b", [["a"], ["b"]]],
  ["bash", "a && b || c", [["a"], ["b"], ["c"]]],
  ["bash", "a | b |& c", [["a"], ["b"], ["c"]]],
  ["bash", "a & b", [["a"], ["b"]]],
  ["bash", "a\nb\r\nc", [["a"], ["b"], ["c"]]],
  ["bash", "a;b&&c||d|e", [["a"], ["b"], ["c"], ["d"], ["e"]]],
  ["powershell", "a; b", [["a"], ["b"]]],
  ["powershell", "a && b || c", [["a"], ["b"], ["c"]]],
  ["powershell", "a | b", [["a"], ["b"]]],
  ["powershell", "a\nb", [["a"], ["b"]]],
  ["powershell", "a & b", [["a"], ["b"]]],

  // $(...), backticks, ( ) and { ...; }, nested
  ["bash", "echo $(date)", [["echo", "$(date)"], ["date"]]],
  ["bash", "echo $(a $(b c))", [["echo", "$(a $(b c))"], ["a", "$(b c)"], ["b", "c"]]],
  ["bash", "echo `date`", [["echo", "`date`"], ["date"]]],
  ["bash", 'echo "today: $(date; whoami)"', [["echo", "today: $(date; whoami)"], ["date"], ["whoami"]]],
  ["bash", 'echo "`whoami`"', [["echo", "`whoami`"], ["whoami"]]],
  ["bash", "(cd x && rm -rf y)", [["cd", "x"], ["rm", "-rf", "y"]]],
  ["bash", "{ a; b; } > log", [["a"], ["b"]]],
  ["bash", "(a; (b)) | c", [["a"], ["b"], ["c"]]],
  ["bash", "echo $((1 + 2))", [["echo", "$((1 + 2))"]]],
  ["bash", "echo $(( $(a) + 1 ))", [["echo", "$(( $(a) + 1 ))"], ["a"]]],
  ["bash", "echo ${x:-$(b)}", [["echo", "${x:-$(b)}"], ["b"]]],
  ["powershell", "Write-Output $(Get-Date)", [["Write-Output", "$(Get-Date)"], ["Get-Date"]]],
  ["powershell", 'echo "now $(Get-Date; whoami)"', [["echo", "now $(Get-Date; whoami)"], ["Get-Date"], ["whoami"]]],
  ["powershell", "echo @(a; b) (c)", [["echo", "@(a; b)", "(c)"], ["a"], ["b"], ["c"]]],
  [
    "powershell",
    "Get-ChildItem | ForEach-Object { Remove-Item -Recurse $_ }",
    [["Get-ChildItem"], ["ForEach-Object", "{ Remove-Item -Recurse $_ }"], ["Remove-Item", "-Recurse", "$_"]],
  ],
  ["powershell", "if (Test-Path x) { rm -r x }", [["if", "(Test-Path x)", "{ rm -r x }"], ["Test-Path", "x"], ["rm", "-r", "x"]]],
  ["powershell", "& 'C:\\Program Files\\Git\\bin\\git.exe' status", [["C:\\Program Files\\Git\\bin\\git.exe", "status"]]],
  ["powershell", "& { a; b }", [["{ a; b }"], ["a"], ["b"]]],
  ["powershell", ". .\\setup.ps1", [[".\\setup.ps1"]]],

  // Quotes and escapes, holding separators
  ["bash", 'echo "a; rm -rf /"', [["echo", "a; rm -rf /"]]],
  ["bash", "echo 'a && b | c'", [["echo", "a && b | c"]]],
  ["bash", "echo a\\;b a\\ b", [["echo", "a;b", "a b"]]],
  ["bash", "echo \"a\\\"b\" 'a\\b'", [["echo", 'a"b', "a\\b"]]],
  ["bash", 'r"m" -rf x', [["rm", "-rf", "x"]]],
  ["bash", "$'\\x72\\155' -rf x", [["rm", "-rf", "x"]]],
  ["bash", "a \\\n  b", [["a", "b"]]],
  ["powershell", "echo 'a; b' \"c | d\"", [["echo", "a; b", "c | d"]]],
  ["powershell", "echo 'it''s' \"say \"\"hi\"\"\"", [["echo", "it's", 'say "hi"']]],
  ["powershell", 'echo a`;b "a`"b"', [["echo", "a;b", 'a"b']]],
  ["powershell", "echo \u2018a; b\u2019 \u201Cc; d\u201D", [["echo", "a; b", "c; d"]]], // PowerShell reads curly quotes as quotes
  ["powershell", '& "r`u{6d}" x', [["rm", "x"]]],

  // Comments
  ["bash", "ls # ; rm -rf ~", [["ls"]]],
  ["bash", "echo a#b", [["echo", "a#b"]]],
  ["powershell", "ls # ; rm", [["ls"]]],
  ["powershell", "<# rm -rf ~ #> ls", [["ls"]]],

  // Redirections (choice 32)
  ["bash", "npm test > out.txt 2>&1", [["npm", "test"]]],
  ["bash", "a >> log < in 2>/dev/null &> all >|x", [["a"]]],
  ["bash", "> out a", [["a"]]],
  ["powershell", "npm test *> out.txt", [["npm", "test"]]],
  ["powershell", "a 2>&1 > log 3> x *>&1 >> y", [["a"]]],

  // NAME=value (choice 33), and PowerShell's $x = <command>
  ["bash", "FOO=1 rm -rf ~", [["rm", "-rf", "~"]]],
  ["bash", 'FOO="a b" BAR+=2 make', [["make"]]],
  ["bash", "FOO=$(a)", [["a"]]],
  ["bash", '"FOO=1" x', [["FOO=1", "x"]]],
  ["powershell", "$x = Remove-Item -Recurse ~", [["Remove-Item", "-Recurse", "~"]]],
  ["powershell", "$x=rm a", [["rm", "a"]]],

  // bash's own words before a command
  ["bash", 'for f in *.log; do rm "$f"; done', [["for", "f", "in", "*.log"], ["rm", "$f"]]],
  ["bash", "if [ -d x ]; then rm -r x; else ! y; fi", [["[", "-d", "x", "]"], ["rm", "-r", "x"], ["y"]]],
  ["bash", "f() { rm x; }; function g { y; }", [["rm", "x"], ["y"]]],
  ["bash", "echo done", [["echo", "done"]]],

  // Here-documents and here-strings are text (choice 35): their commands are added only where the shell expands them
  [
    "bash",
    "git commit -m \"$(cat <<'EOF'\nmsg; rm -rf ~\nEOF\n)\" && git log",
    [["git", "commit", "-m", "$(cat <<'EOF'\nmsg; rm -rf ~\nEOF\n)"], ["cat"], ["git", "log"]],
  ],
  ["powershell", "git commit -m @'\nmsg; rm -rf ~\n'@; git log", [["git", "commit", "-m", "msg; rm -rf ~"], ["git", "log"]]],
  ["bash", "cat <<EOF > out.txt\nhi $(rm -rf ~) `whoami`\nEOF\nls", [["cat"], ["rm", "-rf", "~"], ["whoami"], ["ls"]]],
  ["bash", "cat <<-EOF\n\thi $(rm -rf ~)\n\tEOF", [["cat"], ["rm", "-rf", "~"]]],
  ["bash", "cat <<'EOF'\nhi $(rm -rf ~) `whoami`\nEOF", [["cat"]]],
  ["bash", 'cat <<"EOF"\nhi $(rm -rf ~)\nEOF', [["cat"]]],
  ["bash", "cat <<\\EOF\nhi $(rm -rf ~)\nEOF", [["cat"]]],
  ["bash", "cat <<A; cat <<'B'\n$(a)\nA\n$(b)\nB", [["cat"], ["cat"], ["a"]]],
  ["bash", 'cat <<< "hi $(rm -rf ~)"', [["cat"], ["rm", "-rf", "~"]]],
  ["bash", "cat <<< hi$(rm -rf ~)", [["cat"], ["rm", "-rf", "~"]]],
  ["bash", "cat <<< 'hi $(rm -rf ~)'", [["cat"]]],
  ["powershell", 'echo @"\nhi $(Remove-Item -Recurse ~)\n"@', [["echo", "hi $(Remove-Item -Recurse ~)"], ["Remove-Item", "-Recurse", "~"]]],
  ["powershell", "echo @'\nhi $(Remove-Item -Recurse ~)\n'@", [["echo", "hi $(Remove-Item -Recurse ~)"]]],

  // A shell's text, read in that shell's grammar
  ["bash", "bash -c 'a && b'", [["bash", "-c", "a && b"], ["a"], ["b"]]],
  ["bash", 'sh -c "x; y" name', [["sh", "-c", "x; y", "name"], ["x"], ["y"]]],
  ["bash", "/bin/zsh -lc 'a | b'", [["/bin/zsh", "-lc", "a | b"], ["a"], ["b"]]],
  ["bash", "bash -o pipefail -c 'a'", [["bash", "-o", "pipefail", "-c", "a"], ["a"]]],
  ["bash", "bash script.sh", [["bash", "script.sh"]]],
  ["powershell", "bash -c 'a && b'", [["bash", "-c", "a && b"], ["a"], ["b"]]],
  ["powershell", 'cmd /c "a & b"', [["cmd", "/c", "a & b"], ["a"], ["b"]]],
  ["bash", 'cmd /c "a & b"', [["cmd", "/c", "a & b"], ["a"], ["b"]]],
  ["powershell", 'cmd.exe /S /C "a && b || c | d"', [["cmd.exe", "/S", "/C", "a && b || c | d"], ["a"], ["b"], ["c"], ["d"]]],
  ["powershell", 'cmd /k "(a & b) > out"', [["cmd", "/k", "(a & b) > out"], ["a"], ["b"]]],
  ["bash", "cmd /c '@echo \"a & b\" ^& c'", [["cmd", "/c", '@echo "a & b" ^& c'], ["echo", "a & b", "&", "c"]]],
  ["powershell", "cmd --% /c a & b", [["cmd", "/c", "a", "&", "b"], ["a"], ["b"]]],
  ["powershell", 'powershell -Command "x; y"', [["powershell", "-Command", "x; y"], ["x"], ["y"]]],
  [
    "powershell",
    "pwsh -NoProfile -ExecutionPolicy Bypass -c 'Remove-Item a; b'",
    [["pwsh", "-NoProfile", "-ExecutionPolicy", "Bypass", "-c", "Remove-Item a; b"], ["Remove-Item", "a"], ["b"]],
  ],
  [
    "powershell",
    "powershell -Command { Remove-Item a }",
    [["powershell", "-Command", "{ Remove-Item a }"], ["{ Remove-Item a }"], ["Remove-Item", "a"]],
  ],
  ["powershell", "powershell -File x.ps1", [["powershell", "-File", "x.ps1"]]],
  ["bash", "pwsh -c 'a; b'", [["pwsh", "-c", "a; b"], ["a"], ["b"]]],

  // Commands that run the rest of their words (choice 34)
  ["bash", "env rm -rf ~", [["env", "rm", "-rf", "~"], ["rm", "-rf", "~"]]],
  ["bash", "env -i -u X - FOO=1 rm x", [["env", "-i", "-u", "X", "-", "FOO=1", "rm", "x"], ["rm", "x"]]],
  [
    "bash",
    "nohup nice -n 5 time -p rm x",
    [["nohup", "nice", "-n", "5", "time", "-p", "rm", "x"], ["nice", "-n", "5", "time", "-p", "rm", "x"], ["time", "-p", "rm", "x"], ["rm", "x"]],
  ],
  ["bash", "nice -10 a", [["nice", "-10", "a"], ["a"]]],
  ["bash", "timeout -s KILL 10 make test", [["timeout", "-s", "KILL", "10", "make", "test"], ["make", "test"]]],
  [
    "bash",
    "stdbuf -oL exec command rm x",
    [["stdbuf", "-oL", "exec", "command", "rm", "x"], ["exec", "command", "rm", "x"], ["command", "rm", "x"], ["rm", "x"]],
  ],
  ["bash", "command -v rm", [["command", "-v", "rm"]]],
  [
    "bash",
    "find . -name '*.tmp' -print0 | xargs -0 -n 1 rm -f",
    [["find", ".", "-name", "*.tmp", "-print0"], ["xargs", "-0", "-n", "1", "rm", "-f"], ["rm", "-f"]],
  ],
  ["bash", "xargs -I{} sh -c 'rm \"$1\"' _ {}", [["xargs", "-I{}", "sh", "-c", 'rm "$1"', "_", "{}"], ["sh", "-c", 'rm "$1"', "_", "{}"], ["rm", "$1"]]],
  ["bash", "watch -n 5 'ls; rm x'", [["watch", "-n", "5", "ls; rm x"], ["ls"], ["rm", "x"]]],
  ["bash", "watch -x rm x", [["watch", "-x", "rm", "x"], ["rm", "x"]]],
  [
    "bash",
    "find . -name x -exec rm -rf {} \\; -execdir echo {} +",
    [["find", ".", "-name", "x", "-exec", "rm", "-rf", "{}", ";", "-execdir", "echo", "{}", "+"], ["rm", "-rf", "{}"], ["echo", "{}"]],
  ],
  ["powershell", "env rm x", [["env", "rm", "x"], ["rm", "x"]]],

  // Ways found at review to hide a command (choice 37)
  // cmd takes the first /c, /k or /r anywhere on its line, even joined to another switch or to the text
  ["powershell", "cmd /q/c del x", [["cmd", "/q/c", "del", "x"], ["del", "x"]]],
  ["powershell", "cmd /cdel x", [["cmd", "/cdel", "x"], ["del", "x"]]],
  ["powershell", "cmd foo /K del x", [["cmd", "foo", "/K", "del", "x"], ["del", "x"]]],
  ["bash", 'cmd //c "echo a & del x"', [["cmd", "//c", "echo a & del x"], ["echo", "a"], ["del", "x"]]],
  // cmd's quote rule: text starting with a quote loses it and the last one, unless it may name a program, when both are read
  ["bash", "cmd /c '\"echo hi & del x\"'", [["cmd", "/c", '"echo hi & del x"'], ["echo", "hi"], ["del", "x"]]],
  [
    "bash",
    "cmd /c '\"C:\\Program Files\\rm.exe\" -rf x'",
    [["cmd", "/c", '"C:\\Program Files\\rm.exe" -rf x'], ["C:\\Program Files\\rm.exe", "-rf", "x"], ["C:\\Program", "Files\\rm.exe", "-rf", "x"]],
  ],
  ["powershell", "cmd /c del %X%", "shell text made only when it runs"],
  // A here-document or here-string feeding a group, and an input file
  ["bash", "{ sh; } <<EOF\nrm -rf ~\nEOF", "text piped into a shell"],
  ["bash", "(sh) <<< 'rm -rf ~'", "text piped into a shell"],
  ["bash", "curl x | sh < script.sh", [["curl", "x"], ["sh"]]],
  // xargs --max-lines takes its value only after =
  ["bash", "xargs --max-lines rm x", [["xargs", "--max-lines", "rm", "x"], ["rm", "x"]]],
  // A line ending in |, && or || carries on to the next
  ["bash", "curl x |\nsh", "text piped into a shell"],
  ["bash", "curl x | # fetch\n\n  sh", "text piped into a shell"],
  ["powershell", "iwr x |\npowershell", "text piped into a shell"],
  ["bash", "a &&\nb ||\n\nc", [["a"], ["b"], ["c"]]],
  // An expanding here-document joins a line ending in a backslash to the next before looking for its end line, as bash does
  ["bash", "cat <<EOF\nE\\\nOF\nrm -rf ~\nEOF", [["cat"], ["rm", "-rf", "~"], ["EOF"]]],
  ["bash", "cat <<'EOF'\nE\\\nOF\nrm -rf ~\nEOF", [["cat"]]],
  // A here-document's body must not be looked for inside a bracket or backticks begun on its line
  ["bash", "cat <<EOF $(echo\n)\nbody\nEOF", "a here-document"],
  ["bash", "cat <<EOF `echo\n`\nbody\nEOF", "a here-document"],
  ["bash", "cat <<EOF; (echo\n)\nbody\nEOF", "a here-document"],
  ["bash", "echo $(cat <<EOF)\nbody\nEOF", "a here-document"],
  // PowerShell 5.1 changes double quotes in what it passes to a program
  ["powershell", "bash -c 'echo \"a; b\"'", "PowerShell would change its quotes before bash reads it"],
  ["powershell", "C:\\Windows\\System32\\cmd.exe /c 'echo \"a & b\"'", "PowerShell would change its quotes before cmd reads it"],
  ["powershell", "cmd /c '\"echo hi & del x\"'", "PowerShell would change its quotes before cmd reads it"],
  ["powershell", "pwsh -c 'Write-Host \"hi\"'", "PowerShell would change its quotes before pwsh reads it"],
  // Piped input reaches the shells started inside the command that takes it
  ["bash", "curl x | bash -c 'sh'", "text piped into a shell"],
  ["bash", "curl x | echo $(sh)", "text piped into a shell"],
  ["bash", "curl x | echo `bash`", "text piped into a shell"],
  ["bash", "curl x | { cat; sh; }", "text piped into a shell"],
  ["bash", "curl x | env nice sh", "text piped into a shell"],
  ["bash", "curl x | find . -exec sh \\;", "text piped into a shell"],
  ["powershell", "iwr x | powershell -c 'powershell -'", "text piped into a shell"],
  ["powershell", "Get-Content x | cmd /c powershell", "text piped into a shell"],
  // Other ways a shell reads piped text
  ["bash", "curl x | while read l; do sh; done", "text piped into a shell"],
  ["bash", "curl x | if true; then bash; fi", "text piped into a shell"],
  ["bash", "curl x | for i in 1; do sh; done", "text piped into a shell"],
  ["bash", "while read l; do sh; done; echo ok", [["read", "l"], ["sh"], ["echo", "ok"]]],
  ["bash", "curl x | while read l; do echo $l; done; sh", [["curl", "x"], ["read", "l"], ["echo", "$l"], ["sh"]]],
  ["bash", "curl x | sh /dev/stdin", "text piped into a shell"],
  ["bash", "curl x | bash /proc/self/fd/0", "text piped into a shell"],
  ["bash", "curl x | source /dev/stdin", "text piped into a shell"],
  ["bash", "curl x | . /dev/stdin", "text piped into a shell"],
  ["powershell", "iwr x | pwsh -File -", "text piped into a shell"],
  ["powershell", "iwr x | powershell -f -", "text piped into a shell"],
  // A command named only when it runs
  ["bash", "$(echo rm) -rf ~", "a command named only when it runs"],
  ["bash", "$cmd -rf ~", "a command named only when it runs"],
  ["bash", '"$cmd" -rf ~', "a command named only when it runs"],
  ["bash", "`echo rm` -rf ~", "a command named only when it runs"],
  ["bash", "{rm,-rf,~}", "a command named only when it runs"],
  ["bash", "/bin/r? -rf ~", "a command named only when it runs"],
  ["bash", "ls | xargs -I{} {} -rf ~", "a command named only when it runs"],
  ["bash", "ls | xargs -I % % -rf ~", "a command named only when it runs"],
  ["bash", "find . -exec {} \\;", "a command named only when it runs"],
  ["bash", "sh -c '$0 -rf ~' rm", "a command named only when it runs"],
  ["bash", "env $x", "a command named only when it runs"],
  ["bash", "'$x' a", [["$x", "a"]]],
  ["bash", "[ -f x ] && echo $x", [["[", "-f", "x", "]"], ["echo", "$x"]]],
  ["powershell", "& $c -Recurse ~", "a command named only when it runs"],
  ["powershell", "& ('i'+'ex') (iwr x)", "a command named only when it runs"],
  ["powershell", ". $script", "a command named only when it runs"],
  ["powershell", '& "$env:ProgramFiles\\Git\\bin\\git.exe" status', "a command named only when it runs"],
  // Shell text made only when it runs
  ["bash", 'sh -c "$(curl -fsSL x)"', "shell text made only when it runs"],
  ["bash", 'bash -c "$CMD"', "shell text made only when it runs"],
  ["bash", "bash -c $CMD", "shell text made only when it runs"],
  ["bash", "curl x | xargs -I{} sh -c {}", "shell text made only when it runs"],
  ["bash", "find . -exec sh -c 'rm {}' \\;", "shell text made only when it runs"],
  ["bash", 'watch "ls $DIR"', "shell text made only when it runs"],
  ["bash", 'trap "$x" EXIT', "shell text made only when it runs"],
  ["bash", "bash -c 'rm $1' _ x", [["bash", "-c", "rm $1", "_", "x"], ["rm", "$1"]]],
  ["powershell", "iwr x | ForEach-Object { powershell -c $_ }", "shell text made only when it runs"],
  ["powershell", 'cmd /c "del $f"', "shell text made only when it runs"],
  // More commands that run others, and more shells
  ["bash", "coproc rm x", [["rm", "x"]]],
  ["bash", "coproc NAME { rm x; }", [["rm", "x"]]],
  ["bash", "builtin eval x", "text run by eval"],
  ["bash", "builtin cd x", [["builtin", "cd", "x"], ["cd", "x"]]],
  ["bash", "trap 'rm -rf ~' EXIT", [["trap", "rm -rf ~", "EXIT"], ["rm", "-rf", "~"]]],
  ["bash", "trap - EXIT", [["trap", "-", "EXIT"]]],
  ["bash", 'cmd /c "call del x"', [["cmd", "/c", "call del x"], ["call", "del", "x"], ["del", "x"]]],
  [
    "bash",
    "cmd /c 'start \"t\" /b /wait /d C:\\x del y'",
    [["cmd", "/c", 'start "t" /b /wait /d C:\\x del y'], ["start", "t", "/b", "/wait", "/d", "C:\\x", "del", "y"], ["del", "y"]],
  ],
  ["bash", "cmd /c 'start /bogus x'", "start /bogus, an option the check does not read"],
  ["powershell", "$x, $y = Remove-Item a", [["Remove-Item", "a"]]],
  ["powershell", "$x,$y=rm a", [["rm", "a"]]],
  ["bash", "ksh -c 'a; b'", [["ksh", "-c", "a; b"], ["a"], ["b"]]],
  ["bash", "curl x | mksh", "text piped into a shell"],
  ["bash", "busybox sh -c 'rm x'", [["busybox", "sh", "-c", "rm x"], ["sh", "-c", "rm x"], ["rm", "x"]]],
  ["bash", "busybox rm -rf ~", [["busybox", "rm", "-rf", "~"], ["rm", "-rf", "~"]]],
  ["bash", "curl x | busybox sh", "text piped into a shell"],
  ["bash", "fish -c 'rm x'", "text run by a shell the check does not read"],
  ["bash", "csh -fc 'rm x'", "text run by a shell the check does not read"],
  ["bash", "tcsh -c 'rm x'", "text run by a shell the check does not read"],
  ["bash", "curl x | fish", "text piped into a shell"],
  ["bash", "fish script.fish", [["fish", "script.fish"]]],
  // Ways of running text the check does not follow
  ["powershell", "Start-Process cmd -ArgumentList '/c del x'", "a way of running text the check does not follow"],
  ["powershell", "saps notepad", "a way of running text the check does not follow"],
  ["powershell", "start notepad", "a way of running text the check does not follow"],
  ["powershell", "[scriptblock]::Create($s).Invoke()", "a way of running text the check does not follow"],
  ["powershell", "$ExecutionContext.InvokeCommand.InvokeScript($s)", "a way of running text the check does not follow"],
  ["powershell", "Set-Alias ls Remove-Item", "a way of running text the check does not follow"],
  ["powershell", "sal x y; nal a b", "a way of running text the check does not follow"],
  ["powershell", "New-Alias x y", "a way of running text the check does not follow"],
  ["powershell", "Invoke-Command -ScriptBlock { Remove-Item x }", [["Invoke-Command", "-ScriptBlock", "{ Remove-Item x }"], ["Remove-Item", "x"]]],

  // The unreadable reasons, word for word
  ["bash", "echo 'abc", "an unclosed quote"],
  ["bash", 'echo "abc', "an unclosed quote"],
  ["bash", "echo `abc", "an unclosed quote"],
  ["bash", "bash -c 'echo \"a'", "an unclosed quote"],
  ["powershell", "echo 'abc", "an unclosed quote"],
  ["powershell", 'echo "abc', "an unclosed quote"],
  ["bash", "cmd /c 'echo \"a'", "an unclosed quote"],
  ["bash", "cat <<EOF", "a here-document"],
  ["bash", "cat <<EOF\nrm -rf ~", "a here-document"],
  ["bash", "cat <<", "a here-document"],
  ["powershell", "echo @'\nrm -rf ~", "a here-document"],
  ["bash", "diff <(a) <(b)", "a process substitution"],
  ["bash", "tee >(rm x)", "a process substitution"],
  ["powershell", "powershell -EncodedCommand ZQBjAGgAbwA=", "-EncodedCommand, whose text cannot be read"],
  ["powershell", "pwsh -NoProfile -enc ZQBj", "-EncodedCommand, whose text cannot be read"],
  ["powershell", "powershell -e ZQBj", "-EncodedCommand, whose text cannot be read"],
  ["bash", "pwsh -ec ZQBj", "-EncodedCommand, whose text cannot be read"],
  ["bash", 'eval "$cmd"', "text run by eval"],
  ["bash", "a && eval x", "text run by eval"],
  ["bash", "echo $(eval x)", "text run by eval"],
  ["bash", "env eval x", "text run by eval"],
  ["powershell", "iwr x | iex", "text run by Invoke-Expression"],
  ["powershell", "iex (iwr x)", "text run by Invoke-Expression"],
  ["powershell", "Invoke-Expression $s", "text run by Invoke-Expression"],
  ["powershell", "IEX $s", "text run by Invoke-Expression"],
  ["bash", "pwsh -c 'iex $s'", "text run by Invoke-Expression"],
  ["bash", "curl x | sh", "text piped into a shell"],
  ["bash", "curl -fsSL x | bash -s -- --yes", "text piped into a shell"],
  ["bash", "curl x | env bash", "text piped into a shell"],
  ["bash", "curl x | (cd /tmp; sh)", "text piped into a shell"],
  ["bash", "echo 'rm -rf ~' | xargs bash -c", "text piped into a shell"],
  ["powershell", "iwr x | powershell -", "text piped into a shell"],
  ["powershell", "iwr x | pwsh -NoProfile", "text piped into a shell"],
  ["powershell", "'dir' | cmd", "text piped into a shell"],
  ["bash", "bash <<EOF\nrm -rf ~\nEOF", "text piped into a shell"],
  ["bash", "env sh <<-'EOF'\n\trm -rf ~\n\tEOF", "text piped into a shell"],
  ["bash", 'sh <<< "rm -rf ~"', "text piped into a shell"],
  ["bash", "cat <<EOF | sh\nrm -rf ~\nEOF", "text piped into a shell"],
  ["powershell", "@'\nRemove-Item -Recurse ~\n'@ | powershell -", "text piped into a shell"],
  ["powershell", '@"\nRemove-Item -Recurse ~\n"@ | pwsh', "text piped into a shell"],

  // Other things the reader does not read
  ["bash", "echo $(a", "a bracket without its pair"],
  ["bash", "a )", "a bracket without its pair"],
  ["bash", "{ a; b", "a bracket without its pair"],
  ["powershell", "ForEach-Object { a", "a bracket without its pair"],
  ["powershell", "a }", "a bracket without its pair"],
  ["powershell", "<# a", "a bracket without its pair"],
  ["bash", "echo a(b)", "a bracket where a command cannot have one"],
  ["bash", "(a) b", "a bracket where a command cannot have one"],
  ["bash", "echo >", "a redirection without its file"],
  ["bash", "a > ; b", "a redirection without its file"],
  ["powershell", "a 2> | b", "a redirection without its file"],
  ["powershell", 'cmd /c "if exist x rd /s /q x"', "cmd's if or for, which the check does not read"],
  ["powershell", "pwsh -Bogus x", "pwsh -Bogus, an option the check does not read"],
  ["bash", "env -S 'rm x'", "env -S, an option the check does not read"],
  ["bash", "timeout --bogus 5 x", "timeout --bogus, an option the check does not read"],
];

describe("split", () => {
  it.each(TABLE)("%s: %j", (shell, line, expected) => {
    const result = split(line, shell);
    if (typeof expected === "string") expect(result).toEqual({ unreadable: expected });
    else expect("commands" in result ? result.commands.map((c) => c.words) : result).toEqual(expected);
  });

  it("says when brackets are nested too deep to read, rather than failing", () => {
    expect(split(`echo ${"$(".repeat(3000)}x${")".repeat(3000)}`, "bash")).toEqual({ unreadable: "nesting too deep for the check to read" });
  });

  it("gives each command's text as written, so a warning can show it", () => {
    const texts = (line: string, shell: Shell) => {
      const result = split(line, shell);
      return "commands" in result ? result.commands.map((c) => c.text) : result;
    };
    expect(texts("FOO=1 rm -rf ~ > out.txt && ls", "bash")).toEqual(["FOO=1 rm -rf ~ > out.txt", "ls"]);
    expect(texts("echo $(date  -u)", "bash")).toEqual(["echo $(date  -u)", "date  -u"]);
    expect(texts("bash -c 'a  x && b'", "bash")).toEqual(["bash -c 'a  x && b'", "a  x", "b"]);
    expect(texts("env -i rm -rf  ~ 2>&1", "bash")).toEqual(["env -i rm -rf  ~ 2>&1", "rm -rf  ~"]);
    expect(texts('for f in x; do rm "$f"; done', "bash")).toEqual(["for f in x", 'rm "$f"']);
    expect(texts("& 'git' status", "powershell")).toEqual(["'git' status"]);
  });
});

describe("shellOf", () => {
  it.each([
    ["host", "win32", "powershell"],
    ["host", "linux", "bash"],
    ["host", "darwin", "bash"],
    ["box", "win32", "bash"],
    ["box", "linux", "bash"],
  ] as const)("%s on %s -> %s", (where, platform, shell) => {
    expect(shellOf(where, platform)).toBe(shell);
  });

  it("reads this machine's platform when none is given", () => {
    expect(shellOf("host")).toBe(process.platform === "win32" ? "powershell" : "bash");
  });
});
