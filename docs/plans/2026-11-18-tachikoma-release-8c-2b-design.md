# Tachikoma release 8c-2, part B: the sandbox's allowed sites (design)

Part A ([2026-11-17 design](2026-11-17-tachikoma-release-8c-2a-design.md)) ran local MCP servers inside the box and
left "the box's list of allowed sites with its filtering proxy" to this part. With the network `on` today, the box
and its servers reach the whole web (README, known limits). Part B adds a third network setting, `sites`, that limits
the box, and remote MCP servers, to a list the user writes.

The rules come from the main design ([2026-10-22](2026-10-22-tachikoma-design.md), "How the network setting is
enforced" and "MCP tools"): an `--internal` Docker network with a filtering proxy written as part of Tachikoma; one
check shared by the proxy and the MCP client, "so the two can never disagree"; exact host and port; a lookup made at
connect time and the checked address used; local addresses never reached through an allowed name; nothing widening
the list; only web traffic; "not offered until proven"; and only the user grants network access. "Only web traffic"
narrows here to what the proxy can check: a TLS connection opened to a listed name and port, or a plain http request
to one. What is carried inside TLS is not checked (section 2, and the second design review).

## The user's choices (2026-11-18)

1. **The list covers the box and remote MCP servers, with one shared check** ("Box and remote (Recommended)"),
   remote servers' sign-in and redirect addresses included.
2. **A third network value and a list key** ("Third value + list key (Recommended)"): `--network sites` or
   `"network": "sites"`, with `"allowedSites": [...]` in `~/.tachikoma/settings.json`. `off` and `on` work as
   today; switching between `on` and `sites` keeps the list. `on` is how the user allows every site.
3. **Exact names only** ("Exact names only (Recommended)"), as the main design promised: `github.com` never allows
   `api.github.com`.
4. **No local addresses in part B** ("None in part B (Recommended)"): the box never reaches the user's computer or
   local network, and a remote MCP server at a local address is off while the list is in force. A local grant can
   come later if a real need shows up.
5. **`host` servers are off with the list in force** ("Off, as with network off (Recommended)"), as the main design
   said: nothing can hold a program on the user's computer to the list.
6. **In `never` mode a box server's call asks with the list in force** ("Asks, as with network on (Recommended)"):
   the list narrows where the box reaches but does not make what it changes there reviewable (part A, choice 4).
7. **No built-in sites; `sites` with no list still starts** ("Empty, launch refuses none (Recommended)"): it says
   once that no site is allowed and works as `off` does.
8. **The limits are checked at each launch** ("Check at each launch (Recommended)"): `sites` holds wherever it runs
   only if the box proves it cannot get out, before anything runs.
9. **The user's own `headersHelper` runs with `sites`** ((a), 2026-11-18), as with `on`: a short command the user
   wrote, whose server's requests are still checked. A project's helper still never runs with the sandbox on.

10. **A tunnel must open with a TLS greeting naming the checked site** (the design review's finding 3, "Check the TLS
    start (Recommended)").
11. **A refused entry is named by its position and the name part only** (the design review's finding 5, "Name and
    position only (Recommended)").
12. **No IP address entries** (the second design review, "Drop IP entries (Recommended)"): TLS forbids an IP
    address as a greeting's server name (RFC 6066, section 3), so under choice 10 no https client could use one.

The user approved each of the five sections below on 2026-11-18, the wording drafts in "What the user and the model
see" among them. The design reviews changed sections 1-5 the same day (see "After the design review").

## Measured (2026-11-18): name lookups on an `--internal` network

The main design's "Still to measure" 15, on Docker Desktop 29.9.2 (Windows 11, the box image
`tachikoma-sandbox:5879e9863c31`), from a container on a network made with `docker network create --internal`:

- `getent hosts example.com` exits 2 (not found), and so does `getent hosts host.docker.internal`. The container's
  resolver is Docker's own, `nameserver 127.0.0.11`.
- A direct TCP connection to `1.1.1.1:443` fails with `Network is unreachable`, and so does a DNS query sent straight
  to `8.8.8.8:53`.

A failed lookup does not show that the query stayed in (the design review's finding 2), and an `--internal` network
still has a gateway into Docker's host side (finding 1). Measured the same day, same Docker:

- **The gateway.** A listener on Docker's host side (a container with `--network host` on port 18080) is reached from
  an `--internal` network through its gateway (`172.23.0.1`): `REACHED: hello-from-host-side`. With
  `-o com.docker.network.bridge.gateway_mode_ipv4=isolated` the network has no gateway address (`invalid IP`), and
  the same listener is not reached (`.1` refused, `.254` timed out). A control from the default bridge reached it.
- **Where a lookup goes.** A logging listener on another network, which the box cannot reach, given to the box as its
  `--dns`, saw nothing from the box's query. A logging listener on the box's own isolated network, given as its
  `--dns`, saw the query (`control-b1.example.org`), forwarded by Docker from `172.31.251.1`. So Docker's resolver
  forwards a box's lookups to its given server when that server is on the box's network.

So the box's lookup server is the proxy (section 2), which refuses every name: no lookup reaches any server but the
proxy, by construction. Linux and Mac are not measured; the launch check (section 2) tests the limits on each machine
it runs on.

## 1. The setting

- **`--network sites`** or **`"network": "sites"`** in `~/.tachikoma/settings.json`; the list is
  **`"allowedSites"`** in the same file. Neither can come from a project, a skill or the model. As `network` is today,
  a change to either applies at the next launch.
- **An entry** is a name, with a port when it is not 443:
  - `github.com` allows `https://github.com` on port 443 only;
  - `api.example.com:8443` allows that port only;
  - plain `http://` needs its port written, such as `example.com:80`.
- **Letter case and a trailing dot are ignored**: `GitHub.com.` and `github.com` are one entry.
- **Refused entries:** a wildcard, a path, a scheme written in front (`https://`), a password, anything that is not
  a name and port, a local address, and an IP address (choice 12). Each is left out with one launch line naming it
  (below), and the launch goes on.
- **No list, or an empty one:** `sites` starts, its launch line says no site is allowed, and the box works as with
  the network off.
- **Elsewhere:** the launch line shows `network sites (3)`, the count of entries in force. A session saved with
  `sites` is a different setup from `on` and `off` on resume (src/core/setup.ts). A project server's answer is kept
  per setup, so `sites` adds a network value to part A's setup key (decision 11 there).

## 2. How the box is held to the list

- **A network per launch.** With `sites`, each launch makes its own Docker network with `--internal`, no route out,
  and `com.docker.network.bridge.gateway_mode_ipv4=isolated`, no gateway into Docker's host side (the design review's
  finding 1; measured above), with no IPv6. A Docker that refuses the option stops the launch (line 8), never a
  weaker network. It starts two containers on it:
  - **the box**, as today;
  - **the proxy**, a small program of Tachikoma's own, run from the box's image (it holds Node 24: sandbox/Dockerfile),
    so nothing new is downloaded. Only the proxy is also joined to an ordinary network, so it is the only way out.
- **The proxy's settings are its own.** The list reaches the proxy as a read-only file the box cannot see or change.
  The proxy, its network and the box carry Tachikoma's labels, so the cleanup of leftover boxes (`sweepBoxes`) removes
  them too.
- **The box's lookups go to the proxy** (`--dns`, the proxy's address on the network), which answers every name
  refused (the design review's finding 2). Docker's own upstream server is then never given a box's lookup.
- **Inside the box**, `HTTPS_PROXY`, `HTTP_PROXY` and their lowercase forms point at the proxy by its address, not a
  name. git over https, npm,
  pip, uv and curl use them. A program that ignores them has no route out, so it fails rather than slipping past.
  Node's own `fetch` ignores them unless told otherwise; whether Node 24 in the box can be told to by a setting is to
  be checked while building, not assumed.
- **Each connection, at the proxy:**
  1. the name and port are checked against the list, exactly;
  2. the proxy looks the name up itself and refuses when the address is local (section 3);
  3. it connects to the address it checked.
- **https** is a tunnel (CONNECT). Before passing any bytes, the proxy reads the tunnel's first message: it must be a
  TLS greeting (ClientHello) whose server name is the checked name, or the tunnel is refused (choice 10; the design
  review's finding 3). What is sent after the greeting is passed through unread. **Plain http** is checked per
  request, by its address. A redirect is a new request, checked again. So what passes is a TLS connection opened to a
  listed name and port, or a plain http request to one. Anything that does not open that way fails, `git` over SSH
  among them. A protocol carried inside TLS, such as mail over TLS to a listed name and port, is not checked and
  passes (a known limit).
- **The launch check.** Before anything runs:
  - the network is confirmed to have no gateway address (Docker's own description of it);
  - from the box, three things must fail: a direct connection to an outside address, a request through the proxy for
    a site that is not listed, and a tunnel to a listed site that does not open with its TLS greeting;
  - a lookup of a made-up name from the box must reach the proxy and be refused there, which shows the box's lookups
    go nowhere else.

  If any of these does not hold, the launch stops (line 8 below). Its time is measured while building before it is
  stated.

## 3. Remote MCP servers, and the one shared check

- **One module** holds the rules: reading the list, matching a name and port exactly, and whether an address is
  local, meaning:
  - the user's computer (`127.0.0.0/8`, `::1`);
  - a private network (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`);
  - link-local (`169.254.0.0/16`, `fe80::/10`);
  - IPv6's private range (`fc00::/7`);
  - the user's computer's own addresses, IPv4 and IPv6, public ones included, read from its network interfaces at
    launch and given to the proxy in its file (the design review's finding 4);
  - any of these in another form, such as an IPv4 address written as IPv6.

  The proxy runs it, and so does Tachikoma for remote MCP servers (`connectionFetch`, src/mcp/server.ts), so the two
  cannot disagree. Which further ranges count (for example `0.0.0.0/8`, `100.64.0.0/10`, multicast) is settled in the
  plan, from the address registries, not guessed.
- **A remote server, with the list in force:**
  - **Not listed:** a server whose address's name and port are not on the list does not start; `/mcp` shows it
    `off: not on the allowed sites`. A server at a local address, such as `http://localhost:…`, is off too:
    `off: a local address`.
  - **Listed:** each request checks the name again, looks it up, refuses a local address, and connects to the
    address it checked, so a name that later points somewhere local is caught then.
  - **Redirects:** as today, only to the same site (the library's `same-origin` policy), each checked again. A refused
    one fails the connection, naming the address.
  - **Sign-in:** the addresses Tachikoma itself contacts for it (the server's sign-in details and its token address,
    src/mcp/auth.ts) must be on the list too. A refused one fails the sign-in, naming the address to add. The page the
    user opens in a browser is not Tachikoma's request and is not checked.
- **The user's own `headersHelper` runs** (choice 9) and is not held to the list (a known limit).

## 4. What the user and the model see

**Which servers start:**

| | off | on | sites |
|---|---|---|---|
| box server | starts | starts | starts, reaching only the listed sites |
| `host` server | off | starts | off |
| remote server | off | starts | starts if listed |

**Approval:** `sites` follows `on`; in `never` mode a box server's call asks. The approval tables gain a `sites`
column matching `on`.

**The wording** (drafts the user approved, 2026-11-18):

1. A refused entry, at launch, one line each, naming its position and only the name part that could be read, never a
   password, path or query (choice 11): `allowedSites entry 3 (*.github.com) was left out: a wildcard; list each
   name`. With no readable name: `allowedSites entry 4 was left out: not a name and port`. The other reasons:
   `a path`, `a local address`, `a password`, `an IP address; list its name` (choice 12).
2. No site, at launch: `The sandbox's network allows no sites; add them to "allowedSites" in
   ~/.tachikoma/settings.json.`
3. `host` servers off, at launch: `MCP servers marked "host" are off: the sandbox's network is limited to its allowed
   sites.`
4. `/mcp` rows: `off: not on the allowed sites` and `off: a local address`.
5. What a command in the box gets from the proxy, as its error: `Tachikoma's sandbox refused github.io:443: not on the
   allowed sites`, or `…: it points at a local address`.
6. Added to a failed command, as the network-off line is today: `(The sandbox's network reaches only its allowed
   sites; the user can add one to "allowedSites".)`
7. The system prompt: `The sandbox's network reaches only these sites: github.com, pypi.org. Other sites and local
   addresses are refused, and only the user can add a site.` A long list is cut after the first few with `…and N
   more`; how many is measured while building, not guessed.
8. A failed launch check: `The sandbox's allowed sites cannot be held on this machine: <what got through>. Use
   --network off or --network on.`

## 5. Left out, tests, known limits

**Not in part B:** local addresses (a separate grant, later if needed); wildcards; built-in sites; publishing the
box's ports (background commands design, 2026-11-13, stays with port publishing later); host CLI workers (release 12,
with the worker servers).

**Tests:**

- **The shared check**, as plain unit tests:
  - exact matching;
  - the default port;
  - case and a trailing dot;
  - every refused entry form;
  - every local range, including IPv4 written as IPv6, decimal and other short forms (`2130706433`, `127.1`), and a
    name that resolves somewhere local.
- **The proxy**, against stand-in servers:
  - a listed site passes;
  - an unlisted one is refused with line 5;
  - a listed name that resolves somewhere local is refused;
  - only a tunnel opening with a TLS greeting that names the checked site, and a plain http request, pass;
  - a tunnel that opens with something other than a TLS greeting (an SSH greeting among them), or with a greeting
    naming another site, is refused;
  - a redirect is checked again.
- **Real Docker**, on the user's machine:
  - the launch check passes;
  - from the box, a direct connection, a lookup, an unlisted site and the Docker host all fail;
  - a listener on Docker's host side (`--network host`) is not reached through the network's would-be gateway, with a
    control that reaches it from an ordinary network (the design review's finding 1);
  - a lookup from the box reaches only the proxy, shown by a logging listener elsewhere seeing nothing (finding 2);
  - an allowed name pointing at one of the computer's own addresses is refused (finding 4);
  - a listed site works for git, pip and a curl-style request;
  - cleanup removes the proxy and its network.
- **Remote MCP servers:**
  - unlisted is off;
  - listed connects;
  - a sign-in address that is not listed fails the sign-in;
  - a name that changes where it points is caught.
- **The user's terminal check** at the end, in copy mode (live link is refused on Windows' case-insensitive folders,
  release 7).

**Known limits** (drafts for the README):

- A program in the box that ignores the proxy variables reaches nothing, listed sites included; that may include
  Node's own `fetch`, unless the box can turn it on (to be checked).
- The user's own `headersHelper` runs on the user's computer and is not held to the list.
- An https tunnel is checked by its name, its port and its TLS greeting's server name; what is sent after the greeting
  is not read, so a site that serves several names behind one greeting name is reached as that site chooses, and a
  protocol other than the web carried inside TLS to a listed name and port, such as mail over TLS, passes.
- The user's computer's own addresses are read at launch: one it gains later, and the router's public IPv4 address
  (which only an outside service could tell), are not counted as local.

## After the design review (2026-11-18)

A review of this design found five problems, all confirmed; findings 1 and 2 were measured (see "Measured").

1. **`--internal` does not block Docker's host side.** The gateway reached a host-side listener. Fixed: isolated
   gateway mode, a launch that stops when Docker refuses it, a launch check of the gateway, and a host-listener test.
2. **A failed lookup did not show the query stayed in,** and the design claimed the launch check proved it. Fixed: the
   box's lookup server is the proxy, which refuses every name, and the launch check shows a lookup reaches it; the
   known limit about lookups is gone.
3. **A blind tunnel carries any protocol, and another site's name inside it.** Fixed (choice 10): a tunnel must open
   with a TLS greeting naming the checked site; the claim narrows to TLS or plain http to a listed name and port.
4. **The local check missed the computer's own public addresses.** Fixed: the computer's interface addresses count
   as local, with a known limit for ones gained later and the router's public address.
5. **A refused entry's line could show a pasted password or token.** Fixed (choice 11): the line names the entry's
   position and only its readable name part.

A second review of the fixes (49fef4b) found that they hold, and two more problems:

1. **An IP address entry could never pass the TLS greeting rule,** as TLS forbids an IP address as the server name
   (RFC 6066, section 3). Fixed (choice 12): IP address entries are refused, with their own reason.
2. **"Only web traffic" still promised more than the check gives:** another protocol carried inside TLS, with a
   matching greeting, passes unchecked. Fixed: the opening, section 2, the tests and the known limits all say TLS
   opened to a listed name and port, or plain http to one.
