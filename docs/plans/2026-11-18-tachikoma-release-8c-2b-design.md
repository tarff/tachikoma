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
see" among them. The design reviews changed sections 1-5 the same day (see "After the design review"), and the user
approved the whole design after them ("approved", 2026-11-18).

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

## Measured while building (8c-2b plan, Step 1)

Measured on 2026-11-18 on the user's computer: Windows 11, Docker Desktop with Docker 29.9.3 (client and server; the
earlier measurement above said 29.9.2), the box's image `tachikoma-sandbox:5879e9863c31` (its Node is v24.22.2) and
this computer's Node v24.22.1. Unless said otherwise a box was run as the launch runs it: `--pull never --init --user
1000:1000 -e HOME=/tmp --cap-drop ALL --security-opt no-new-privileges`. Every network and container was named
`tachi-8c2b-measure-…`, labelled `tachi.8c2b.measure=1`, and removed by that name. The only use of the internet was
one lookup of `example.com` and one connection to it on port 443, from the proxy's container (the plan's question 1).
The scripts were throwaway files: `nl.py` (reads the routing rules and tables through Python's netlink socket),
`standin.js` (a stand-in proxy: it reads its mounted settings file, listens on a port the system gives and on port 53
over UDP and TCP, prints its port first, logs and refuses every lookup and request, and for the check's made-up name
answers 200 and then closes unless the tunnel opens with a TLS record), `tries.js` (timed TCP tries),
`check-script.js` (a stand-in for the launch check's script), `timing.mjs`, `programs.sh`, `host-proxy.mjs` and
`prompt-len.mjs`.

### In plain words

- **The isolated network holds on this computer.** Docker accepts the option, the network has no gateway, and a box
  on it has no route out: a connection to an outside address fails at once (1 to 5 ms) as "network is unreachable",
  and a listener on Docker's host side is not reached, while an ordinary container reaches it.
- **The proxy can stand on both networks.** Started on the isolated network and then joined to Docker's ordinary
  network, it looked up `example.com` and connected to it. The box reaches the proxy, and the proxy's settings file,
  mounted read-only from a folder under the system's temp folder, is readable by the box's user.
- **The box's lookups reach the proxy over UDP and over TCP**, each as the box sent it. So the proxy must answer on
  both (decision 8 left this to be measured). The box's user, with no capabilities, may listen on port 53.
- **Node in the box uses the proxy only with `NODE_USE_ENV_PROXY=1`**; without it, it looks the name up itself, which
  the proxy refuses. git, pip, uv, npm and Python's urllib all use the proxy variables. So decision 11's case holds:
  the box gets the variable.
- **On this computer, with `NODE_USE_ENV_PROXY=1` set, Node's shared connection pool sends a request through the
  proxy even when the request brings its own lookup;** a request with its own pool (`new https.Agent()`, or `agent:
  false`) goes straight to the address. Without that variable nothing goes through the proxy. So Step 8's checked
  `fetch` needs its own pool.
- **The route files differ in three ways from what the plan's question 3 expects** (see "Against the plan" below):
  every box's IPv6 list holds two "everything" entries that are the kernel's own refusals; the IPv4 list shows its
  main and local tables with the same entries; and the routing rules themselves can be read in the shipped image,
  with Python, as the box's user, with no capability.
- **Times** (ten runs each): the set-up takes about 1 s (slowest 1.06 s), the launch check about 0.5 s (slowest
  0.60 s), the cleanup after a failure about 1.1 s (slowest 1.13 s), and the sweep's network listing 0.1 s and one
  network removal 0.3 s. The box's own start, today's code, takes about 0.4 s beside them.
- **The prompt line** with 10 sites as long as `api.example.com` is 296 characters, beside a whole prompt of 1,054
  today with the network on; with 25 it is 551 and with 50 it is 976.

### The network

`docker network create --internal -o com.docker.network.bridge.gateway_mode_ipv4=isolated --label
tachi.8c2b.measure=1 tachi-8c2b-measure-net` exited 0, and so did the same with `--ipv6=false` added. `docker network
inspect` printed, in short:

```
"EnableIPv6": false, "IPAM": {"Config": [{"Subnet": "172.23.0.0/16"}]}, "Internal": true,
"Options": {"com.docker.network.bridge.gateway_mode_ipv4": "isolated", "com.docker.network.enable_ipv4": "true",
"com.docker.network.enable_ipv6": "false"}, "Labels": {"tachi.8c2b.measure": "1"}
```

The config has no `Gateway` key at all. For contrast, a plain `--internal` network printed
`[{"Subnet":"172.25.0.0/16","Gateway":"172.25.0.1"}]`, and `bridge` `[{"Subnet":"172.17.0.0/16",
"Gateway":"172.17.0.1"}]`. With no gateway, Docker gave the first container on the network the address `.1`.

`docker inspect --format '{{json .NetworkSettings.Networks}}'` of a box on it printed one network only, in short:
`{"tachi-8c2b-measure-net":{…,"Gateway":"","IPAddress":"172.23.0.1",…,"IPPrefixLen":16,"IPv6Gateway":"",…}}`.
Its `HostConfig.NetworkMode` was `"tachi-8c2b-measure-net"`.

`docker network rm tachi-8c2b-measure-net` with that box running exited 1: `Error response from daemon: error while
removing network: network tachi-8c2b-measure-net has active endpoints (name:"tachi-8c2b-measure-box"
id:"e6c88a0c24fc")`. `docker network ls --filter label=tachi.8c2b.measure=1 --format '{{.ID}}\t{{.Name}}\t{{.Label
"tachi.8c2b.measure"}}'` printed one line, `ecab4b7c18e5<tab>tachi-8c2b-measure-net<tab>1`.

So the network the design asks for can be made here, Docker's description shows it has no gateway, and the network
cannot be removed before its containers.

### The box's routes

Read inside a box on the isolated network (`cat` of each file, as the box's user): all three files could be read.
`/proc/net/fib_trie`, whole:

```
Main:
  +-- 0.0.0.0/0 2 0 2
     +-- 127.0.0.0/8 2 0 2
        +-- 127.0.0.0/31 1 0 0
           |-- 127.0.0.0
              /8 host LOCAL
           |-- 127.0.0.1
              /32 host LOCAL
        |-- 127.255.255.255
           /32 link BROADCAST
     +-- 172.23.0.0/16 2 0 2
        +-- 172.23.0.0/31 1 0 0
           |-- 172.23.0.0
              /16 link UNICAST
           |-- 172.23.0.1
              /32 host LOCAL
        |-- 172.23.255.255
           /32 link BROADCAST
Local:
  (the same 17 lines again, line for line)
```

`/proc/net/route` (tabs between fields; each line is padded with spaces to 127 characters in the file):

```
Iface	Destination	Gateway 	Flags	RefCnt	Use	Metric	Mask		MTU	Window	IRTT
eth0	000017AC	00000000	0001	0	0	0	0000FFFF	0	0	0
```

`/proc/net/ipv6_route`, three lines, each broken here at a space for width (one line each in the file):

```
00000000000000000000000000000000 00 00000000000000000000000000000000 00
  00000000000000000000000000000000 ffffffff 00000001 00000000 00200200       lo
00000000000000000000000000000001 80 00000000000000000000000000000000 00
  00000000000000000000000000000000 00000000 00000004 00000000 80200001       lo
00000000000000000000000000000000 00 00000000000000000000000000000000 00
  00000000000000000000000000000000 ffffffff 00000001 00000000 00200200       lo
```

The two `::/0` lines carry the flags `00200200`, a refusal with no "up" flag, metric `ffffffff`, on `lo`: these are
the kernel's built-in "unreachable" entries, not a way out. `::1/128` is loopback.
`/proc/sys/net/ipv6/conf/eth0/disable_ipv6` is `1` (IPv6 is off on the box's network card) and `0` for `all`,
`default` and `lo`, so the file exists; a box whose kernel has no IPv6, and so no such file, was not seen.
`/proc/net/if_inet6` lists `::1` only.

For contrast, a box on `bridge` shows the same files with a route out. Its `/proc/net/fib_trie` holds, under each of
`Main:` and `Local:`, a leaf `|-- 0.0.0.0` followed by `/0 universe UNICAST`; its `/proc/net/route` starts with
`eth0	00000000	010011AC	0003	…	00000000` (everything, through 172.17.0.1); its `/proc/net/ipv6_route` is the same
three lines. In the trie, lines such as `+-- 0.0.0.0/0 2 0 2` are the list's inner nodes and are in every box; only a
leaf (`|--`) followed by its `/<length> <scope> <type>` line is a route.

**Reading the rules.** The image has no `ip`, `ss`, `iptables`, `nft`, `route`, `netstat`, `curl` or `wget`; it has
`python3` and `node`. Python's netlink socket (`nl.py`, run with `docker exec -i <box> python3 -I - < nl.py`) read the
rules and every table's routes as the box's user with no capability:

```
ipv4 rule: priority 0 table 255 ...          ipv6 rule: priority 0 table 255 ...
ipv4 rule: priority 32766 table 254 ...      ipv6 rule: priority 32766 table 254 ...
ipv4 rule: priority 32767 table 253 ...
ipv4 route: table 254 172.23.0.0/16 dev eth0 type 1 scope 253
ipv4 route: table 255 127.0.0.0/8 dev lo type 2 scope 254       (and 127.0.0.1/32, 127.255.255.255/32,
ipv4 route: table 255 172.23.0.1/32 dev eth0 type 2 scope 254    172.23.255.255/32 in table 255)
ipv6 route: table 255 ::1/128 dev lo type 2 scope 0
```

On `bridge` the same, with `ipv4 route: table 254 0.0.0.0/0 via 172.17.0.1 dev eth0`. These are the kernel's three
standard IPv4 rules (local 255, main 254, default 253) and its two IPv6 ones. Node cannot open a netlink socket.

**A second table.** In one throwaway container of the box's image on the isolated network, run as `--user 0:0
--cap-drop ALL --cap-add NET_ADMIN`, `nl.py add` added `10.99.0.0/16 dev eth0` in table 100 (the image has no `ip`;
Python's netlink socket did it). `/proc/net/fib_trie` then began with a third table, before `Main:`:

```
Id 100:
  |-- 10.99.0.0
     /16 universe UNICAST
```

`/proc/net/route` did not show it (it shows the main table only), and `nl.py` showed `table 100 10.99.0.0/16`.

So: in a passing box the trie shows only the network's block, the box's own address, the block's broadcast and
loopback; a route out shows as a `0.0.0.0` leaf; and a route in another table is listed under its own `Id` heading.

### The proxy on two networks

**Started on the isolated network, then joined to `bridge`** (`docker run -d … --network tachi-8c2b-measure-net -v
<temp folder>:/proxy:ro … node /proxy/standin.js`, then `docker network connect bridge tachi-8c2b-measure-proxy`,
exit 0): its first output line was `{"port":40103,"sites":1}`; `/etc/resolv.conf` named `nameserver 127.0.0.11`
(Docker's own resolver, `ExtServers: [host(192.168.65.7)]`); its routes were a default route through `bridge`
(`eth1	00000000	010011AC	0003`) and the two networks' blocks. Its address on the isolated network was read with
`docker inspect --format '{{(index .NetworkSettings.Networks "tachi-8c2b-measure-net").IPAddress}}'`: `172.23.0.2`.
From inside it, one `dns.lookup("example.com", {all: true})` gave `104.20.23.154` and `172.66.147.243` in 22 ms, and
one connection to `104.20.23.154:443` opened at 36 ms (then closed at once).

**The other order** (started on `bridge`, then `docker network connect tachi-8c2b-measure-net …`, exit 0): it also
printed its port, read `nameserver 127.0.0.11`, had a default route through `bridge`, got `172.23.0.3`, and the box
reached its port. Its reach outside was not tried, so as to make only one lookup and one connection.

**The mounted file**: `ls -l /proxy` as the box's user showed `-rwxrwxrwx 1 root root` for both files, `cat` read
them, and `touch /proxy/x` failed with `Read-only file system`.

**A container that has exited**: the same `docker inspect` format printed `invalid IP`, not an empty line.

So the order of decision 10 (the isolated network first, then `bridge`) works here; the address is read by the
network's name.

### Lookups

The stand-in proxy, run as the box's user with no capability, listened on port 53 over UDP and TCP
(`/proc/sys/net/ipv4/ip_unprivileged_port_start` is `0` in the box). A box run with `--dns 172.23.0.2` (the proxy)
had `nameserver 127.0.0.11`. Then, from the box:

- `getent hosts udpq.m1check7f3a.invalid` exited 2 in 4 ms; the proxy logged that name four times, `via udp`, from
  `172.23.0.1` (the box's own address);
- a query sent by Python over TCP to `127.0.0.11:53` came back with answer code 2 in 10 ms; the proxy logged it
  `via tcp`;
- the same over UDP came back with answer code 2 in 1 ms; the proxy logged it `via udp`.

So Docker's resolver forwards a query the way it came, UDP or TCP, and to the box it turns the proxy's "refused"
(code 5) into "server failure" (code 2): Node's `dns.lookup` in the box gives `EAI_AGAIN`. The launch check therefore
reads the proxy's own log, as planned, not the code the box gets.

### The direct connection

`docker exec -i <box> node - 192.0.2.1:443 < tries.js`, three times: `error ENETUNREACH` after 4.6, 1.5 and 1.3 ms.
The proxy's `bridge` address `172.17.0.2` from the box: `ENETUNREACH` after 1.2 ms.

A listener in a container with `--network host` (Docker's host side; port 39857, given by the system) had the
addresses `127.0.0.1`, `192.168.65.6`, `192.168.65.3` and `172.17.0.1`, and none on the isolated network. From the
box: `172.17.0.1`, `192.168.65.6` and `192.168.65.3` each `ENETUNREACH` in about 1 ms; `172.23.0.254` (an unused
address in the network's block, where a gateway might be) no answer within the try's 3 s. The control, a container
on `bridge`: `172.17.0.1:39857` and `192.168.65.3:39857` both connected and got `hello-from-host-side`.

So an outside address is refused at once by the box's own system, and the host side cannot be reached.

### The limits' figures

`node timing.mjs 10`: ten runs of the set-up, a box, the check, the sweep's new part and the cleanup, each run with
its own names. Each figure is fastest, middle (the mean of the two middle runs) and slowest, in ms.

| What | fastest | middle | slowest |
|---|---|---|---|
| set-up: `network create` (with `--ipv6=false`) | 139 | 144 | 161 |
| set-up: the proxy's `run -d` | 402 | 423 | 459 |
| set-up: `network connect bridge` | 178 | 195 | 211 |
| set-up: `logs --follow` to the first line | 104 | 115 | 123 |
| set-up: `inspect` for the address | 116 | 121 | 133 |
| **set-up, whole, to the first line** | 850 | 872 | 925 |
| **set-up, whole, to the address read** (the set-up limit's span) | 970 | 996 | 1056 |
| for context: the box's `run -d` (today's code) | 391 | 412 | 443 |
| check: `network inspect` | 115 | 121 | 128 |
| check: the box's `inspect` | 112 | 115 | 139 |
| check: the script in the box (route reads and four tries) | 171 | 172 | 199 |
| check: `logs` of the proxy | 116 | 124 | 155 |
| **check, whole** | 516 | 535 | 601 |
| cleanup: `rm -f` the box | 330 | 351 | 375 |
| cleanup: `rm -f` the proxy | 447 | 462 | 498 |
| cleanup: `network rm` | 255 | 272 | 321 |
| **cleanup, whole** | 1073 | 1091 | 1132 |
| sweep: `network ls` with the label filter | 111 | 118 | 135 |
| sweep: `network rm` of one network | 244 | 258 | 292 |

In all ten runs the check's script saw `ENETUNREACH` for the direct connection, a 403 for the unlisted site, the
tunnel closed after its 200 when it opened with an SSH greeting, `EAI_AGAIN` for the lookup, and the proxy's log held
the check's name. The computer was otherwise idle; Docker Desktop waking from idle and a busier or smaller machine
were not measured.

### Programs and the proxy variables

`docker exec -i <box> bash -s http://172.23.0.2:40103 < programs.sh`, which sets `HTTPS_PROXY`, `HTTP_PROXY` and
their lowercase forms to the stand-in, whose log shows what each program sent (it refuses every request with a 403
whose reason is line 5):

| Program | What reached the stand-in | What the program said |
|---|---|---|
| `node --version` | | `v24.22.2` |
| Node `fetch`, the variables alone | two lookups of `example.com` | `EAI_AGAIN` |
| Node `fetch`, with `NODE_USE_ENV_PROXY=1` | `CONNECT example.com:443 HTTP/1.1` | `Request was cancelled.` |
| `https.get`, the variables alone | two lookups of `example.com` | `EAI_AGAIN` |
| `https.get`, with `NODE_USE_ENV_PROXY=1` | `CONNECT example.com:443 HTTP/1.1` | `ERR_PROXY_TUNNEL` |
| `git ls-remote https://github.com/git/git HEAD` | `CONNECT github.com:443 HTTP/1.1` | `CONNECT tunnel failed, …` |
| pip (from a venv), `download … idna` | `CONNECT pypi.org:443 HTTP/1.0`, no `Host` | `No matching distribution …` |
| `uv pip install --system --dry-run … idna` | four `CONNECT pypi.org:443 HTTP/1.1` | `tunnel error: unsuccessful` |
| `npm view idna version` | two `CONNECT registry.npmjs.org:443` | `403 Tachikoma's sandbox refused …` |
| Python `urllib`, https | `CONNECT pypi.org:443 HTTP/1.0`, no `Host` | `… 403 Tachikoma's sandbox refused …` |
| Python `urllib`, `http://example.com/` | `GET http://example.com/ …`, `Host: example.com` | `HTTP Error 403: …` |

In full: git said `fatal: unable to access 'https://github.com/git/git/': CONNECT tunnel failed, response 403`; pip
`ERROR: No matching distribution found for idna`; npm `npm error 403 403 Tachikoma's sandbox refused
registry.npmjs.org:443: not on the allowed sites - GET https://registry.npmjs.org/idna`; urllib `Tunnel connection
failed: 403 Tachikoma's sandbox refused pypi.org:443: not on the allowed sites`. So npm and urllib show the
proxy's reason; pip, uv and git do not.

Nothing reached any site: the box has no route out and the stand-in answers every request itself.

### This computer's Node and the proxy variables

`node host-proxy.mjs`: two listeners on 127.0.0.1, a "proxy" that logs and refuses and a "target" that logs the first
byte it gets (`0x16`, a TLS greeting), and each request made in a child process with only the variables named (none
were set in the shell). No name was looked up anywhere: the requests named `127.0.0.1`, or `site.test` with a lookup
of their own that answers `127.0.0.1`.

| Variables | `fetch` | `https.request`, shared pool | own lookup, shared pool | own lookup, own pool |
|---|---|---|---|---|
| `HTTPS_PROXY` alone | target | target | target | target |
| with `NODE_USE_ENV_PROXY=1` | proxy | proxy | proxy (`CONNECT site.test:…`) | target |
| and `NO_PROXY=127.0.0.1,site.test` | target | target | target | target |

"Own pool" is both `agent: new https.Agent()` and `agent: false`. So Node's global `fetch` and its shared pool follow
`HTTPS_PROXY` only with `NODE_USE_ENV_PROXY=1`, they honour `NO_PROXY`, and a request with a pool of its own goes to
its own lookup's address in every case.

### The prompt line

`node --import <the repo's tsx> prompt-len.mjs` (today's `systemPrompt`, on `win32`, the date 2026-11-18): the whole
prompt is 1,109 characters with no sandbox, 1,014 with the box's network off and 1,054 with it on (its web line is
107 of those). The design's line 7 with names of 15 characters, as `api.example.com`:

| Names | 2 | 5 | 10 | 25 | 50 |
|---|---|---|---|---|---|
| Line 7's length | 160 | 211 | 296 | 551 | 976 |

### Against the plan

- **Decision 6** holds: the stand-in's port came as its first line, `docker logs --follow` gave it in about 0.1 s, and
  the address is read by the network's name. A builder should know that an exited container's address reads
  `invalid IP`.
- **Decision 8** holds, and the measurement settles its open point: Docker forwards over UDP and over TCP, so the
  proxy answers on both. The box sees "server failure", not "refused", and one lookup can reach the proxy several
  times (four for one `getent`), so the proxy prints a few lines per check, not one.
- **Decision 10** holds: the isolated network first, then `bridge`, reaches outside.
- **Decision 11** holds: the box's Node uses the proxy with `NODE_USE_ENV_PROXY=1`, so the box gets that variable.
- **Decision 9a and question 3** do not hold as written, in three places:
  1. Every box's IPv6 list holds two `::/0` entries, the kernel's own refusals (flags `00200200`, metric `ffffffff`,
     on `lo`). The rule "nothing beyond loopback, link-local and multicast" would stop every launch unless such
     refusal entries are accepted. A box whose kernel has no IPv6 file was not seen, so under question 3 a missing
     file stops the launch.
  2. With the kernel's standard rules the trie lists `Main:` and `Local:` with the same entries, so the main table
     shows local entries too (the box's own address, loopback, the two broadcasts); the rule's "nothing beyond the
     network's own block, the box's own address and loopback" holds for them. A table that is not main or local
     shows as `Id <number>:`.
  3. The routing rules can be read inside the shipped image, with `python3`'s netlink socket, as the box's user with
     no capability; question 3's known limit says they cannot. A project's own image may have no `python3`, and Node
     cannot read them.

### Measured while building (8c-2b plan, Steps 5 to 7)

**The kernel's standard routing rules, in full** (Step 6, for the launch check's rules comparison): `rules.py` (the
same read as the check's own, src/sandbox/sitesNet.ts) run with `docker exec -i <box> python3 -I - < rules.py` in a
box on an isolated network, and in one on `bridge`, printed the same five rules, one per line:

```
{"family":4,"table":255,"action":1,"tos":0,"flags":0,"src_len":0,"dst_len":0,
  "attrs":{"14":"ffffffff","15":"ff000000","21":"02"}}
```

shown here as the fields that differ: IPv4 table 255 with no priority attribute; IPv4 table 254 with `"6":"fe7f0000"`
(priority 32766); IPv4 table 253 with `"6":"ff7f0000"` (32767); IPv6 table 255 with no priority; IPv6 table 254 with
`"6":"fe7f0000"`. Every one has action 1, tos 0, flags 0, no source or destination length, `"14":"ffffffff"` (no
suppress_prefixlen), `"15"` its own table and `"21":"02"` (made by the kernel). The check stops the launch on any
other rule or any change to one of these. (The first rule is one line in the output, broken here for width.)

**Removing what is not there** (Step 5): `docker rm -f tachi-8c2b-measure-nonesuch` exited 0;
`docker network rm tachi-8c2b-measure-nonesuch` exited 1 with
`Error response from daemon: network tachi-8c2b-measure-nonesuch not found`. So the cleanup counts a network Docker
says is not found as removed, and the proxy is named before its run.

**The real launch's time** (Step 7, `node --import <the repo's tsx> timing.mts 10`: the real code of Steps 5 and 6
with the sandbox's own image, everything labelled `tachikoma.test=1` and removed; ten runs each, in ms):

| What | fastest | middle | slowest | its limit |
|---|---|---|---|---|
| the set-up, `network create` to the proxy's address read | 997 | 1018 | 1061 | 10,000 |
| the launch check | 565 | 578 | 587 | 10,000 |
| the cleanup: the box, the proxy and the network | 1046 | 1084 | 1169 | 10,000 |
| `sandboxStart` with the network `off` | 1360 | 1391 | 1430 | |
| `sandboxStart` with `sites` (two sites) | 3049 | 3083 | 3125 | |

So a sites launch takes about 1.7 s more than one with the network off, on this computer with Docker awake.
**Real runs went over the set-up limit after Docker had been idle.** The first test of the first run of
tests/sandbox/sitesReal.test.ts ended with `The sandbox's network and proxy were not ready within 10 s.`, and so did
`timing.mts 1` run after six minutes with no Docker command (13:37). Then, after six more idle minutes (13:43), each
command timed alone (Step 1's `timing.mjs 1`): `docker version` 361 ms and `docker info` 643 ms, but the first
`docker network create` 7,891 ms, against 139 to 161 ms when Docker is awake; the proxy's run 568 ms, the join 204 ms,
the first line 127 ms, the address read 127 ms; the whole set-up 8,917 ms. So the first network Docker makes after a
rest takes about 8 s, and the set-up's 10 s limit is too close: it was crossed twice in three idle starts.

The user then picked 30 s for the set-up limit (8.9 s times CI's measured slowdown of 3.1 to 3.4, vitest.config.ts),
also for the cleanup and the sweep's network part; the check's stays 10 s. **The cleanup just after a rest**
(`idle-cleanup.mts`: a network, proxy and box made, six minutes with no Docker command, then the cleanup of decision
10a, 14:07 to 14:13): 1,117 ms, nothing left. So a rest slows the first network Docker makes, not its removals.

## As built

Where the build differs from this design, or settles what it left open. The build plan's decisions and questions are
cited by number; "the user's choice" marks an answer the user gave during the build, on 2026-11-18. Every number is
from the measured sections above. The README's "The allowed sites' limits" gathers the rarer cases left as limits.
Steps 1-11 are 80d98ce to 3ad2690, one commit each, with 653e8d4 for the user's choice on compressed answers.

- **What counts as local** (section 3's open item; decision 4): every block of IANA's IPv4 and IPv6 Special-Purpose
  Address Registries that is not globally reachable, multicast, an address in `64:ff9b::/96` whose last 32 bits are a
  local IPv4 address, and this computer's interface addresses read at launch. The table was checked against the two
  registries' files on 2026-11-18 (src/sandbox/sites.ts names them). Another network's own NAT64 prefix is not read,
  a known limit.
- **Entries** (decision 3; choice 11): read with Node's own URL host reader, so short IPv4 forms such as `127.1` are
  refused as local addresses. The reasons are tried in the order a password, a wildcard, a path, a scheme in front, a
  local address, an IP address, not a name and port. A value that is not a list stops the launch in the settings
  file's existing wrong-type form, which shows the value as written, `(got "github.com")` (the user's approval).
- **The network and the proxy** (section 2): the network is `tachikoma-sites-<id>`, made with `--internal
  --ipv6=false -o com.docker.network.bridge.gateway_mode_ipv4=isolated`; the proxy is `tachikoma-proxy-<id>`, run
  from the box's image with the box's user, limits and hardening, its code and settings mounted read-only from a new
  folder under the system's temp folder. It starts on the launch's network, then joins `bridge`, and says its port
  in its first output line. It answers lookups over UDP and over TCP, as Docker forwards both (measured), refuses
  every one, and prints only the check's made-up name.
- **The box's variables:** `HTTPS_PROXY`, `HTTP_PROXY` and their lowercase forms, by the proxy's address;
  `NODE_USE_ENV_PROXY=1`, as Node in the box uses the proxy only with it (section 2's open point, measured); and, a
  change to this design by the user's choice after Step 7, `NO_PROXY` and `no_proxy` set to
  `localhost,127.0.0.1,::1`, so a program reaches a server inside the box directly instead of being sent to the
  proxy and refused.
- **The launch check** (section 2; choice 8) does more than section 2 lists. Docker's description must show the box
  joined to the launch's network alone. The box's `/proc/net/fib_trie` must show only the main and local tables,
  holding only the network's block, the box's own address and loopback. Its `/proc/net/ipv6_route` may hold only
  loopback, link-local and multicast routes and exactly the kernel's own refusal entries for `::/0` (flags `00200200`,
  metric `ffffffff`, on `lo`), which every box has (the user's choice after Step 1). A route file that is missing or
  cannot be read stops the launch. The routing rules are read through `python3`'s netlink socket where the image has
  `python3`, and must be exactly the kernel's five standard ones (measured above); without `python3`, the route
  tables alone are checked (the user's choice after Step 1, a known limit). This replaces the plan's "cannot read the
  routing rules themselves". The direct connection must fail with `ENETUNREACH` and nothing else. The script in the
  box only reports what it found; Tachikoma judges it.
- **Line 8's endings** (the user's choice after the review): line 8 has a further ending,
  `the proxy did not answer as it should for a site that is not listed`, for an answer to the unlisted-site check
  that is neither a refusal nor a pass-through; `the proxy let through a site that is not listed` is kept for a 2xx
  answer only.
- **Time limits** (question 4): the set-up, from the network's creation to the proxy's address read, has 30 s, and so
  do a failed launch's cleanup and the leftover sweep's network part; the check has 10 s. The set-up's was 10 s after
  Step 1 and became 30 s by the user's choice after Step 7, when the first network Docker made after a rest took
  7.9 s (above).
- **Cleanup** (decision 10a): a network Docker says is not found counts as removed. At exit the handler also removes
  the proxy's temp folder, which the plan did not say.
- **Remote MCP servers** (section 3; decisions 13 and 13a): each connection and each sign-in attempt gets its own
  checked `fetch`, on `node:http` and `node:https` with a connection pool of its own, as Node's shared pool sends
  through `HTTPS_PROXY` when `NODE_USE_ENV_PROXY=1` is set (measured). Its first refusal (not listed, or a local
  address) refuses everything after it in that connection or attempt. A ready server whose request is refused fails
  with the refusal and its connection is closed; Reconnect starts afresh. The connection's sign-in client's own
  request, such as an entry's `authServerMetadataUrl`, is checked too.
- **A compressed answer** (W14; decision 17): the checked `fetch` asks for answers that are not compressed and does
  not read one that is. By the user's choice after Step 8, such an answer fails only the request it answered: unlike a
  site refusal it does not end the connection or the sign-in attempt, and it is never read as a dropped connection. A
  server whose first answer is compressed fails to start with W14. So the plan's limit "cannot be used with `sites`"
  became "each compressed answer fails its own request".
- **The prompt** (section 4, line 7): it names the first 10 sites, the user's pick after Step 1 (10 names of 15
  characters make the line 296 characters, beside a whole prompt of 1,054), then `…and N more`, joined with `, ` as
  the names are. It is built with the list in force at the launch, at `/clear` and at each shortening. A resume
  compares the setup, which does not hold the list, so a changed list says nothing on resume (a known limit).
- **The launch's time**, with Docker awake: 3.1 s with `sites` against 1.4 s with the network off, the middle of ten
  runs each (above).
- **Reached for real:** the test that uses the internet (git, pip and a curl-style request, the plan's question 1)
  runs only with `TACHI_TEST_INTERNET=1`. On 2026-11-18 both its tests ran and passed: git, pip and a curl-style
  request with github.com and PyPI's two sites listed (7.9 s), and pip failing with its files' site left off
  (13.7 s). A one-off check with github.com alone listed passed too: `git ls-remote` reached github.com and urllib
  got a 200 from it; urllib to example.com was refused with the proxy's reason, while git to gitlab.com said only
  `CONNECT tunnel failed, response 403`. The user's terminal check passed, with `-p` runs in copy mode, in a scratch
  folder, the settings restored after. It showed the launch line `network sites (1)`; git and urllib reaching
  github.com, and example.com refused with line 5; line 1 for the two entries left out; line 3; the resume's line
  that the setup has changed; and the saved setup note with W6, `Shell commands cannot reach the web now; earlier
  they could reach only the sandbox's allowed sites.` It did not cover line 4 (`/mcp`'s rows, in the window), a
  listed remote MCP server, or line 6: the model added an `echo` to the command, so it exited 0.
