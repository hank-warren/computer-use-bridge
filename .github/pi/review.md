# Review guidance for computer-use-bridge

An MCP server that lets remote agents use one machine's apps (macOS, through open-computer-use or
agent-desktop) and browser tabs (through open-browser-use), over bearer-authenticated HTTP on a
tailnet or over SSH. The user runs it on their own desktop, with their logged-in browser, so the
security boundary is the product. The README describes the guarantees; read it with the diff.

Blocking, in this repo:

- **Security boundary.** Anything that lets a client reach past the allowlist or its own tabs: an
  app outside the allowlist or on the hard-deny list (shells, script runners, password managers,
  System Settings, Mail, Messages) becoming controllable; acting on, attaching to or reading the
  content of the user's tabs or another session's tabs; client-supplied code running on the
  machine; `eval_tab` losing its side-effect refusal; an HTTP route reachable without the token,
  a non-constant-time token comparison, or a listener on an address the config did not choose.
- **Secrets.** The token (or any credential) printed, logged, put in a URL, written to a file
  readable by other users, or committed. Files holding it must be mode 600.
- **Engine output contracts.** Parsing of what the engines return (`list_apps` lines, `doctor`
  permission output, accessibility trees and their focus line, agent-desktop JSON envelopes,
  open-browser-use messages) changed without a test in `dev/logic-test.mjs`, or an engine
  version pin changed without saying what was checked against the new version.
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
