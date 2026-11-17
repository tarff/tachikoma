# Tachikoma release 8c-2, part B: the sandbox's allowed sites (design)

Part A ([2026-11-17 design](2026-11-17-tachikoma-release-8c-2a-design.md)) ran local MCP servers inside the box and
left "the box's list of allowed sites with its filtering proxy" to this part. With the network `on` today, the box
and its servers reach the whole web (README, known limits). Part B adds a third network setting, `sites`, that limits
the box, and remote MCP servers, to a list the user writes.

The rules come from the main design ([2026-10-22](2026-10-22-tachikoma-design.md), "How the network setting is
enforced" and "MCP tools"): an `--internal` Docker network with a filtering proxy written as part of Tachikoma; one
check shared by the proxy and the MCP client, "so the two can never disagree"; exact host and port; a lookup made at
connect time and the checked address used; local addresses never reached through an allowed name; nothing widening
the list; only web traffic; "not offered until proven"; and only the user grants network access.

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

The user approved each of the five sections below on 2026-11-18, the wording drafts in "What the user and the model
see" among them.

## Measured (2026-11-18): name lookups on an `--internal` network

The main design's "Still to measure" 15, on Docker Desktop 29.9.2 (Windows 11, the box image
`tachikoma-sandbox:5879e9863c31`), from a container on a network made with `docker network create --internal`:

- `getent hosts example.com` exits 2 (not found), and so does `getent hosts host.docker.internal`. The container's
  resolver is Docker's own, `nameserver 127.0.0.11`.
- A direct TCP connection to `1.1.1.1:443` fails with `Network is unreachable`, and so does a DNS query sent straight
  to `8.8.8.8:53`.

So the box needs no lookup server of its own: the proxy looks names up. Not checkable from inside the container:
whether Docker's resolver passes a name on to the host even though no answer comes back (a known limit). Linux and
Mac are not measured; the launch check (below) proves the limits wherever `sites` runs.

## 1. The setting

- **`--network sites`** or **`"network": "sites"`** in `~/.tachikoma/settings.json`; the list is
  **`"allowedSites"`** in the same file. Neither can come from a project, a skill or the model. As `network` is today,
  a change to either applies at the next launch.
- **An entry** is a name, with a port when it is not 443:
  - `github.com` allows `https://github.com` on port 443 only;
  - `api.example.com:8443` allows that port only;
  - plain `http://` needs its port written, such as `example.com:80`.
- **Letter case and a trailing dot are ignored**: `GitHub.com.` and `github.com` are one entry. An outside IP address
  can be listed exactly, such as `203.0.113.5:443`.
- **Refused entries:** a wildcard, a path, a scheme written in front (`https://`), a password, anything that is not
  a name and port, and a local address. Each is left out with one launch line naming it (below), and the launch goes
  on.
- **No list, or an empty one:** `sites` starts, its launch line says no site is allowed, and the box works as with
  the network off.
- **Elsewhere:** the launch line shows `network sites (3)`, the count of entries in force. A session saved with
  `sites` is a different setup from `on` and `off` on resume (src/core/setup.ts). A project server's answer is kept
  per setup, so `sites` adds a network value to part A's setup key (decision 11 there).

## 2. How the box is held to the list

- **A network per launch.** With `sites`, each launch makes its own Docker network with `--internal`, no route out,
  and starts two containers on it:
  - **the box**, as today;
  - **the proxy**, a small program of Tachikoma's own, run from the box's image (it holds Node 24: sandbox/Dockerfile),
    so nothing new is downloaded. Only the proxy is also joined to an ordinary network, so it is the only way out.
- **The proxy's settings are its own.** The list reaches the proxy as a read-only file the box cannot see or change.
  The proxy, its network and the box carry Tachikoma's labels, so the cleanup of leftover boxes (`sweepBoxes`) removes
  them too.
- **Inside the box**, `HTTPS_PROXY`, `HTTP_PROXY` and their lowercase forms point at the proxy. git over https, npm,
  pip, uv and curl use them. A program that ignores them has no route out, so it fails rather than slipping past.
  Node's own `fetch` ignores them unless told otherwise; whether Node 24 in the box can be told to by a setting is to
  be checked while building, not assumed.
- **Each connection, at the proxy:**
  1. the name and port are checked against the list, exactly;
  2. the proxy looks the name up itself and refuses when the address is local (section 3);
  3. it connects to the address it checked.
- **https** is a tunnel (CONNECT) passed through unread once checked, so it reaches only the server checked. **Plain
  http** is checked per request. A redirect is a new request, checked again. Only web traffic passes: `git` over SSH,
  and anything else that is not web traffic, fails.
- **The launch check.** Before anything runs, the box tries three things, and all three must fail:
  - a direct connection to an outside address;
  - a lookup of an outside name;
  - a request through the proxy for a site that is not listed.

  If any gets through, the launch stops (line 8 below). Its time is measured while building before it is stated.

## 3. Remote MCP servers, and the one shared check

- **One module** holds the rules: reading the list, matching a name and port exactly, and whether an address is
  local, meaning:
  - the user's computer (`127.0.0.0/8`, `::1`);
  - a private network (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`);
  - link-local (`169.254.0.0/16`, `fe80::/10`);
  - IPv6's private range (`fc00::/7`);
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

1. A refused entry, at launch, one line each: `allowedSites: "*.github.com" was left out: a wildcard; list each name`.
   The other reasons: `a path`, `a local address`, `a password`, `not a name and port`.
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
  - only https tunnels and plain http pass;
  - a redirect is checked again.
- **Real Docker**, on the user's machine:
  - the launch check passes;
  - from the box, a direct connection, a lookup, an unlisted site and the Docker host all fail;
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

- Whether Docker passes the box's name lookups on to the user's computer cannot be seen from inside the box.
- A program in the box that ignores the proxy variables reaches nothing, listed sites included; that may include
  Node's own `fetch`, unless the box can turn it on (to be checked).
- The user's own `headersHelper` runs on the user's computer and is not held to the list.
- An https tunnel is checked by its name and port; what is sent inside it is not read.
