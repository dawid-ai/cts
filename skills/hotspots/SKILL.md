---
name: hotspots
description: Show the files and areas of the project where work keeps going wrong, ranked across all sessions.
argument-hint: "[--limit N]"
disable-model-invocation: true
allowed-tools: Bash(cts:*)
---

Run exactly this command with the Bash tool and relay its output as is, then name the top one or two areas in one line:

`cts hotspots $ARGUMENTS`

If the `cts` command is not found, say that the CTS plugin's bin directory is not on PATH and stop.
