# Review guidance for computer-use-bridge

An MCP server that lets remote agents use one machine's apps (macOS) and browser tabs through the
native MCP servers of open-computer-use and open-browser-use, over bearer-authenticated HTTP on a
tailnet or over SSH. It is deliberately a thin transport: agents get the engines' own tools
unchanged. The README describes the guarantees; read it with the diff.

Blocking, in this repo:

- **Security boundary.** An app outside the allowlist or on the hard-deny list (shells, script
  runners, password managers, System Settings, Mail, Messages) becoming controllable, including
  through an open-computer-use tool offered without an `app` argument to check; an HTTP route
  reachable without the token, a non-constant-time token comparison, or a listener on an address
  the config did not choose. open-browser-use's full tool set (user tabs, history, `cdp`, `call`)
  is exposed by decision and is not a finding.
- **Thin bridge.** Tools added, renamed, wrapped or re-described, results reshaped, or engine
  behaviour patched in the bridge rather than upstream.
- **Secrets.** The token (or any credential) printed, logged, put in a URL, written to a file
  readable by other users, or committed. Files holding it must be mode 600.
- **Engine output contracts.** Parsing of what the engines return (`list_apps` lines, `doctor`
  permission output, open-browser-use `info`) changed without a test in `dev/logic-test.mjs`, or an
  engine version pin changed without saying what was checked against the new version.
- **Config compatibility.** A change that makes an existing config fail to load or change meaning
  without a migration (`setup` rewrites old configs; `serve` must keep reading them).
- **Install and service safety.** `setup`, `update` or `connect` running anything with `sudo`,
  writing outside the user's config, service and log locations (and pi's `mcp.json`, after a
  backup), removing files they did not create, or restarting services without saying so.
- **Release mechanics.** The version must change in exactly one place and match the tag the
  release workflow checks. A behaviour change shipped without a version bump in the same PR is
  blocking when the PR says it is a release.

Not blocking: README wording, comment phrasing, test style, refactors that keep behaviour, and
engine features the bridge does not expose.
