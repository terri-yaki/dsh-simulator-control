# Simulator Control

[github.com/terri-yaki/dsh-simulator-control](https://github.com/terri-yaki/dsh-simulator-control) · MIT licensed · requires macOS + Xcode + [AXe](https://github.com/cameroncooke/AXe)

Your agent can write iOS code, but on its own it can't see or touch the Simulator. This plugin closes that gap: it gives DSH a set of `sim_*` tools for driving the iOS Simulator, plus a live panel in the right sidebar for you. Build → install → poke the UI → look at the screen → read the logs, all without leaving the chat.

Here's what you get:

- **Device picking and boot** — it finds the simulators you already have, picks a sensible iPhone when nothing is running, and boots it on demand. No hand-typed `simctl` commands.
- **Apps** — lists what's installed, finds your simulator build in Xcode's DerivedData, installs, launches, terminates, uninstalls, and prints container paths.
- **UI work** — dumps the accessibility tree, taps by label or accessibility id (coordinates when you really need them), types, swipes, presses hardware buttons, and opens deep links.
- **Evidence** — screenshots (dropped straight into the chat when your model accepts images), H.264 clips, and the simulator log.
- **Testing** — `sim_test` runs an ordered list of steps with waits and assertions, reports which step failed, and attaches a screenshot at the end.
- **A side panel** — a Simulator tab in the right sidebar where you can watch the screen and click/type on it yourself.

Two pieces do the heavy lifting:

| Backend | What it handles |
| --- | --- |
| `xcrun simctl` (Xcode) | device lifecycle, app install/launch, screenshots, deep links, logs, status bar, appearance, location, privacy, pasteboard, video |
| [AXe](https://github.com/cameroncooke/AXe) CLI | accessibility-tree inspection, taps by label/id or coordinates, swipes, typing, hardware buttons |

AXe talks to the simulator over Apple's HID and accessibility paths rather than macOS `CGEvent`, so **you don't need to grant macOS Accessibility permission**, and it works with Xcode 27's Device Hub (where `Simulator.app` is gone). Taps use AXe's physical touch style by default; screenshots take AXe's fast display path and fall back to `simctl io`.

## Requirements

- macOS with a **full Xcode** install (26 or 27) and at least one iOS simulator runtime.
- [AXe](https://github.com/cameroncooke/AXe) 1.8 or newer:

  ```bash
  brew install cameroncooke/axe/axe
  ```

  If it's missing, `sim_doctor` will tell you what to install.

## Install

Install the bundle from this directory into your profile:

```
plugin_manager({ action: "install_bundle", target: "/Users/terry/workspace/dsh-simulator-control" })
```

Already installed? Run `remove_bundle` first, then `install_bundle`. The plugin manager owns the profile wiring, so there's nothing to edit by hand.

## Tools

When exactly one simulator is booted, you can leave `device` off every tool. When none is booted, the plugin boots its automatic choice, says so in the result, and carries on. `sim_devices` and `sim_doctor` both show which device that would be.

| Tool | What it does |
| --- | --- |
| `sim_devices` | Lists simulators (runtime, UDID, state) and the auto-boot target. |
| `sim_boot` | Boots a device — yours or the automatic choice — and waits until automation is ready. |
| `sim_shutdown` | Shuts down one simulator, or all of them. |
| `sim_screenshot` | Saves a PNG; attached to the chat when the model accepts images. |
| `sim_describe_ui` | Compact accessibility tree: labels, ids, values, frames in points. |
| `sim_tap` | Taps by label/id/value (with an optional wait) or by coordinates. |
| `sim_type` | Types text; can select-all first or press Return. |
| `sim_swipe` | Swipes by direction (measured from the screen centre) or between explicit points. |
| `sim_button` | Presses home, lock, side-button, siri, apple-pay. |
| `sim_open_url` | Opens URLs and custom app schemes (deep links). |
| `sim_app` | `list` / `find` / `install` / `run` / `launch` / `terminate` / `uninstall` / `container`. |
| `sim_env` | Appearance, status bar override, location, privacy, pasteboard, open Device Hub. |
| `sim_logs` | Recent simulator logs, optionally filtered by an NSPredicate. |
| `sim_test` | Multi-step UI flow with assertions; per-step PASS/FAIL plus a final screenshot. |
| `sim_video` | Records an H.264 MP4 clip (`start` / `stop`). |
| `sim_doctor` | Checks Xcode, simctl, AXe, Device Hub, and auto-boot settings. |

## Picking a device automatically

When nothing is booted:

1. `DSH_SIM_DEFAULT_DEVICE` wins if it's set (name or UDID).
2. Otherwise it prefers an iPhone on the newest installed runtime, then the most recently used device.

The first automatic boot shows up in the result (`Auto-booted "iPhone 17" ...`). Pass `device` anywhere to aim at a specific simulator by name or UDID.

Environment overrides, read when the plugin loads (restart or reinstall to apply):

| Variable | Effect |
| --- | --- |
| `DSH_SIM_DEFAULT_DEVICE` | Preferred simulator name/UDID for automatic boot. |
| `DSH_SIM_AUTOBOOT=0` | Turns automatic boot off; tools then require an already-booted device. |
| `DSH_SIM_BOOT_TIMEOUT` | Boot wait budget in seconds (default 180). |
| `DSH_SIM_AXE` | Explicit path to the `axe` executable. |

## Typical flows

Install your current build and start poking at it:

```text
sim_devices
sim_app({ "action": "find", "filter": "MyApp" })
sim_app({ "action": "run", "bundle_id": "com.example.myapp" })
sim_describe_ui
sim_tap({ "id": "loginButton" })
sim_type({ "text": "hello@example.com", "submit": true })
sim_screenshot
sim_logs({ "predicate": "process == \"MyApp\"", "last_seconds": 30 })
```

A regression check in a single call:

```text
sim_test({
  "device": "iPhone 17",
  "steps": [
    { "action": "tap", "id": "Settings" },
    { "action": "assert", "label": "General", "timeout": 6 },
    { "action": "tap", "id": "com.apple.settings.general" },
    { "action": "assert", "label": "About", "timeout": 6 },
    { "action": "button", "button": "home" },
    { "action": "screenshot" }
  ]
})
```

Something to attach to a bug report:

```text
sim_video({ "action": "start" })
sim_tap({ "label": "Continue" })
sim_video({ "action": "stop" })
```

`sim_test` steps can be: `tap`, `type`, `swipe`, `button`, `open_url`, `sleep`, `screenshot`, `assert` (`label`/`id`/`value`/`type`/`text`, `exists`, `timeout`), `launch`, `terminate`, `install`.

## The Web side panel

The right sidebar gets a **Simulator** tab:

- the screen, refreshed about once a second (downscaled server-side);
- a device picker plus **Boot / Shut down**, **Home**, and **Refresh**;
- click anywhere on the screen to tap that exact spot on the simulator;
- type into the focused field and hit **Send** (or Enter).

Open it from the right-sidebar button in the conversation header, then the **+** control, then **Simulator** in the guide. The tab type lives in the plugin's Client half, so after installing a new version give the page one refresh (`Cmd+R`) and it'll show up.

The panel calls same-origin routes under `/simulator-control/` (`state`, `frame`, `action`). Those go through the Web GUI's connection checks — no authenticated browser session, no answer (401).

## Known simulator behavior (Xcode 26.4+ / 27)

Things I ran into while building this, so you don't have to:

- **A freshly booted simulator is slow to accept input.** For roughly 30–120 seconds after a *first-ever* boot, HID taps can report success and do nothing. `sim_boot` warms the accessibility connection; if the first interaction seems ignored, check with `sim_describe_ui` and retry.
- **Leave Device Hub running.** Quitting it shuts down every booted simulator. The plugin opens it when asked and never quits it.
- **Duplicate labels don't work as tap targets.** When several elements share a label, tap by `id` instead — `sim_describe_ui` prints them as `#id`.
- **Several booted simulators are normal.** Pass `device` when more than one is up; the error message lists the candidates.
- **Transitions are a thing.** Right after a tap, `sim_describe_ui` can briefly return an animation/card tree; give it a second and look again.
- **Screenshots depend on the model route.** `sim_screenshot` attaches the image only when the current model declares image input; otherwise you get the PNG path for yourself or `read_image`.
- **`sim_app find/run/install` looks in DerivedData.** Specifically `~/Library/Developer/Xcode/DerivedData/*/Build/Products/*-iphonesimulator/*.app`. Builds elsewhere: pass `app_path`.

## Development

- `node scripts/e2e.mjs` — end-to-end check against a real simulator: auto-boot, UI control, apps, multi-step testing, video, side-panel routes, cleanup. Defaults to `iPhone 17`; override with `SIM_DEVICE` / `SIM_UDID`. Set `SIM_TEST_APP_BUNDLE=<bundle id>` to exercise the DerivedData find/install path (skipped by default).
- `node scripts/smoke.mjs` — quick read-only smoke test.

## License

MIT — see [LICENSE](LICENSE). [AXe](https://github.com/cameroncooke/AXe) is a separate MIT-licensed project installed through Homebrew; this repository doesn't vendor it.

## Files

- `index.js` — plugin entry: tools, flow runner, video manager, prompt section.
- `client.js` — Web Client half: right-sidebar tab type, live panel, locale dictionaries.
- `lib/web.js` — side-panel HTTP routes (state, frames, actions) with trust checks.
- `lib/exec.js` — child-process execution, bounded output, AXe discovery.
- `lib/devices.js` — device parsing, default selection, name/UDID resolution.
- `lib/actions.js` — canonical simulator operations shared by tools, flows and routes.
- `lib/format.js` — device/app/AX-tree formatting.
- `lib/args.js` — defensive argument readers.
- `cordis.patch.yml`, `locale/*.json`, `icon.svg` — bundle and display metadata.
