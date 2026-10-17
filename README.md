# Simulator Control

A DeepSeek Harness Host plugin that lets agents fully operate the macOS **iOS Simulator** from chat:

- **auto-discovery and boot** — finds installed simulators, picks a suitable iPhone when nothing is booted, and boots it on demand;
- **apps** — lists installed apps, finds simulator `.app` builds in Xcode's DerivedData, installs, launches, terminates, uninstalls, prints containers;
- **UI control** — accessibility-tree inspection, taps by label/id or point, typing, swipes, hardware buttons, URLs/deep links;
- **evidence** — screenshots (attached to the chat when the model accepts images), H.264 video clips, and simulator logs;
- **testing** — one `sim_test` call runs an ordered flow of steps with `assert` checks that wait for elements, reports per-step pass/fail, and attaches a final screenshot;
- **side panel** — a right-sidebar tab in the Harness Web GUI shows the live screen and accepts taps, typing, Home, and boot/shutdown.

It combines two backends:

| Backend | Used for |
| --- | --- |
| `xcrun simctl` (Xcode) | device lifecycle, app install/launch, screenshots, deep links, logs, status bar, appearance, location, privacy, pasteboard, video |
| [AXe](https://github.com/cameroncooke/AXe) CLI | accessibility-tree inspection, taps by label/id or coordinates, swipes, typing, hardware buttons |

AXe drives the simulator through Apple's HID/accessibility paths instead of macOS `CGEvent`, so **no macOS Accessibility permission is required**, and it works with Xcode 27's Device Hub (where `Simulator.app` no longer exists). Tap input defaults to AXe's physical (touch down/up) style; screenshots prefer AXe's fast display path and fall back to `simctl io`.

## Requirements

- macOS with a **full Xcode** installation (Xcode 26 or 27) and at least one iOS simulator runtime.
- [AXe](https://github.com/cameroncooke/AXe) 1.8 or newer:

  ```bash
  brew install cameroncooke/axe/axe
  ```

  `sim_doctor` reports a setup hint when AXe is missing.

## Install

The plugin is installed in the `desktop` profile from this project directory. Reinstall or update it with:

```
plugin_manager({ action: "install_bundle", target: "/Users/terry/workspace/dsh-simulator-control" })
```

If the package is already installed, `remove_bundle` first, then `install_bundle` (the plugin manager owns profile wiring; do not edit the profile by hand).

## Tools

All device tools work without a `device` argument when exactly one simulator is booted. When none is booted, the plugin boots the automatic choice (see below) and says so in the result. `sim_devices` and `sim_doctor` show which device that would be.

| Tool | Purpose |
| --- | --- |
| `sim_devices` | List simulators (runtime, UDID, state) and the auto-boot target. |
| `sim_boot` | Boot a device — or the automatic choice — and wait until automation is warm. |
| `sim_shutdown` | Shut down one simulator or all of them. |
| `sim_screenshot` | Save a PNG; attach it when the model accepts images. |
| `sim_describe_ui` | Compact accessibility tree: labels, ids, values, frames in points. |
| `sim_tap` | Tap by label/id/value (with wait) or by coordinates. |
| `sim_type` | Type text; optionally select-all first or press Return. |
| `sim_swipe` | Swipe by direction (measured screen centre) or explicit points. |
| `sim_button` | Press home, lock, side-button, siri, apple-pay. |
| `sim_open_url` | Open URLs and custom app schemes (deep links). |
| `sim_app` | `list` / `find` / `install` / `run` / `launch` / `terminate` / `uninstall` / `container`. |
| `sim_env` | Appearance, status bar override, location, privacy, pasteboard, open Device Hub. |
| `sim_logs` | Recent simulator logs, optionally filtered by an NSPredicate. |
| `sim_test` | Multi-step UI flow with assertions; per-step PASS/FAIL plus a final screenshot. |
| `sim_video` | Record an H.264 MP4 clip (`start` / `stop`). |
| `sim_doctor` | Check Xcode, simctl, AXe, Device Hub, auto-boot settings. |

## Automatic device selection

When no simulator is booted:

1. `DSH_SIM_DEFAULT_DEVICE` wins when set (name or UDID).
2. Otherwise the plugin prefers an iPhone, on the newest installed runtime, then the most recently used device.

The first automatic boot is reported in the tool result (`Auto-booted "iPhone 17" ...`). Pass `device` anywhere to target a specific simulator by name or UDID.

Environment overrides (read at plugin load; restart/reinstall to apply):

| Variable | Effect |
| --- | --- |
| `DSH_SIM_DEFAULT_DEVICE` | Preferred simulator name/UDID for automatic boot. |
| `DSH_SIM_AUTOBOOT=0` | Disable automatic boot; tools require an explicitly booted device. |
| `DSH_SIM_BOOT_TIMEOUT` | Boot wait budget in seconds (default 180). |
| `DSH_SIM_AXE` | Explicit path to the `axe` executable. |

## Typical flows

Install and run a build, then poke at it:

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

A regression check in one call:

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

Evidence:

```text
sim_video({ "action": "start" })
sim_tap({ "label": "Continue" })
sim_video({ "action": "stop" })
```

Supported `sim_test` step actions: `tap`, `type`, `swipe`, `button`, `open_url`, `sleep`, `screenshot`, `assert` (`label`/`id`/`value`/`type`/`text`, `exists`, `timeout`), `launch`, `terminate`, `install`.

## Web side panel

The plugin registers a **Simulator** tab in the Web GUI's right sidebar:

- live screen refreshed about once per second (downscaled server-side);
- device picker plus **Boot / Shut down**, **Home**, and **Refresh** controls;
- click anywhere on the screen to tap that exact spot on the simulator;
- type into the focused field and press **Send** (or Enter) to type on the device.

Open it from the conversation header's right-sidebar button, then the **+** (add) control and pick **Simulator** in the guide. The tab type belongs to the Client half of the plugin, so after installing a new version **refresh the page once** (`Cmd+R`) for the panel to appear.

The panel talks to same-origin Host routes under `/simulator-control/` (`state`, `frame`, `action`), which apply the Web GUI's Connection trust checks — requests without the browser's authenticated session are rejected with 401.

## Known simulator behavior (Xcode 26.4+ / 27)

- **First boot is slow to accept input:** for roughly 30–120 seconds after a *first-ever* boot, HID taps can report success but be ignored. `sim_boot` warms the accessibility connection; if the first interaction seems to do nothing, re-check with `sim_describe_ui` and retry.
- **Keep Xcode Device Hub running:** quitting Device Hub shuts down every booted simulator. The plugin opens it but never quits it.
- **Duplicate labels fail:** tap by `id` (accessibility identifier) when several elements share a label; `sim_describe_ui` prints ids as `#id`.
- **Several booted simulators are normal here:** pass `device` when more than one is booted; the tool error lists the candidates.
- **Transitions:** immediately after a tap, `sim_describe_ui` can briefly return an animation/card tree; wait a second and describe again.
- **Screenshots and the model route:** `sim_screenshot` attaches the image only when the current model route declares image input; otherwise it returns the PNG path for the user or `read_image`.
- **App builds:** `sim_app find/run/install` looks in `~/Library/Developer/Xcode/DerivedData/*/Build/Products/*-iphonesimulator/*.app`; pass `app_path` for builds elsewhere.

## Development

- `node scripts/e2e.mjs` — end-to-end check against a real simulator: auto-boot, UI control, apps, multi-step testing, video, side-panel routes, and cleanup. Defaults to the `iPhone 17` device; override with `SIM_DEVICE` / `SIM_UDID`. Set `SIM_TEST_APP_BUNDLE=<bundle id>` to exercise the DerivedData find/install path (skipped by default).
- `node scripts/smoke.mjs` — quick read-only smoke test.

## License

MIT — see [LICENSE](LICENSE). [AXe](https://github.com/cameroncooke/AXe) is a separate MIT-licensed project installed through Homebrew; this repository does not vendor it.

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
