# Changelog

## Unreleased

- Setup hints (daemon not installed, not running, cannot start, local collection off): **Open in
  terminal** types the fix into a new terminal on this host, ready to run with Enter. The hover and
  the panel both have it, next to **Copy**.
- The footer names the host even before the first file change is recorded.

## 1.4.0

First release.

- Status bar: `AIM`, `AIM 4` for changes at CRITICAL, HIGH or MEDIUM, `AIM off` when nothing is
  being recorded.
- Hover: who changed what, the findings by severity and the top ten rows.
- Panel: the last 10 minutes, hour or day, with a timeline and every file's events.
- Report: the full page with Top Findings, as HTML or JSON.
- Works with kaimond 1.4 in local-only mode: nothing leaves your machine.
