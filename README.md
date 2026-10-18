# Simulator Control

**模擬器控制** · [English](#simulator-control) · [繁體中文](#繁體中文)

[github.com/terri-yaki/dsh-simulator-control](https://github.com/terri-yaki/dsh-simulator-control) · MIT licensed · requires macOS + Xcode + [AXe](https://github.com/cameroncooke/AXe)

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

---

# 繁體中文

[English](#simulator-control) · [繁體中文](#繁體中文)

[github.com/terri-yaki/dsh-simulator-control](https://github.com/terri-yaki/dsh-simulator-control) · MIT 授權 · 需要 macOS、Xcode 與 [AXe](https://github.com/cameroncooke/AXe)

這是一個 DeepSeek Harness 的 Host 外掛，讓 Agent 可以直接從對話中完整操作 macOS 上的 **iOS 模擬器**：

- **自動探索與啟動** — 自動列出已安裝的模擬器；若目前沒有啟動中的模擬器，會挑選合適的 iPhone 並按需啟動；
- **App 管理** — 列出已安裝 App、在 Xcode 的 DerivedData 中尋找模擬器 `.app` 建置產物、安裝、啟動、結束、解除安裝，並取得容器路徑；
- **介面操作** — 檢視輔助使用樹狀結構、依標籤／識別碼／座標點按、輸入文字、滑動、按下硬體按鈕、開啟 URL／深層連結；
- **佐證資料** — 螢幕快照（當模型支援圖片輸入時直接附加到對話）、H.264 影片片段，以及模擬器日誌；
- **測試** — 一次 `sim_test` 呼叫即可執行有序步驟流程，並以會等待元素出現的 `assert` 檢查，逐步驟回報通過／失敗，最後附加一張螢幕快照；
- **側邊面板** — Harness Web GUI 的右側邊欄提供一個分頁，顯示即時畫面，並支援點按、輸入、主畫面與啟動／關閉。

外掛結合兩個後端：

| 後端 | 用途 |
| --- | --- |
| `xcrun simctl`（Xcode） | 裝置生命週期、App 安裝／啟動、螢幕快照、深層連結、日誌、狀態列、外觀、位置、隱私權限、剪貼板、錄影 |
| [AXe](https://github.com/cameroncooke/AXe) CLI | 輔助使用樹狀結構、依標籤／識別碼或座標點按、滑動、輸入文字、硬體按鈕 |

AXe 透過 Apple 的 HID／輔助使用通道驅動模擬器，而非 macOS 的 `CGEvent`，因此**不需要 macOS 的「輔助使用」權限**，也能運作於 Xcode 27 的 Device Hub（`Simulator.app` 已不存在）。點按預設使用 AXe 的實體觸碰（touch down/up）模式；螢幕快照優先走 AXe 的快速顯示路徑，失敗時退回 `simctl io`。

## 需求

- macOS，安裝**完整版 Xcode**（Xcode 26 或 27），以及至少一個 iOS 模擬器 runtime。
- [AXe](https://github.com/cameroncooke/AXe) 1.8 或更新版本：

  ```bash
  brew install cameroncooke/axe/axe
  ```

  若缺少 AXe，`sim_doctor` 會回報安裝提示。

## 安裝

此外掛安裝於 `desktop` 設定檔（profile），來源就是本專案目錄。重新安裝或更新：

```
plugin_manager({ action: "install_bundle", target: "/Users/terry/workspace/dsh-simulator-control" })
```

若套件已安裝，請先 `remove_bundle` 再 `install_bundle`（設定檔的接線由外掛管理器負責，請勿手動編輯設定檔）。

## 工具

當只有一個模擬器啟動中時，所有裝置工具都不需要 `device` 參數。若沒有任何模擬器啟動，外掛會啟動自動選擇的裝置（見下文），並在結果中說明。`sim_devices` 與 `sim_doctor` 會顯示自動啟動的目標裝置。

| 工具 | 用途 |
| --- | --- |
| `sim_devices` | 列出模擬器（runtime、UDID、狀態）與自動啟動目標。 |
| `sim_boot` | 啟動指定裝置或自動選擇的裝置，並等到自動化連線就緒。 |
| `sim_shutdown` | 關閉單一或全部模擬器。 |
| `sim_screenshot` | 儲存 PNG；當模型支援圖片輸入時一併附加。 |
| `sim_describe_ui` | 精簡的輔助使用樹：標籤、識別碼、數值、以點為單位的畫框。 |
| `sim_tap` | 依標籤／識別碼／數值（可等待）或座標點按。 |
| `sim_type` | 輸入文字；可先全選或送出 Return。 |
| `sim_swipe` | 依方向滑動（自動量測畫面中心）或使用明確起訖點。 |
| `sim_button` | 按下 home、lock、side-button、siri、apple-pay。 |
| `sim_open_url` | 開啟 URL 或自訂 App scheme（深層連結）。 |
| `sim_app` | `list`／`find`／`install`／`run`／`launch`／`terminate`／`uninstall`／`container`。 |
| `sim_env` | 外觀、狀態列覆寫、位置、隱私權限、剪貼板、開啟 Device Hub。 |
| `sim_logs` | 最近的模擬器日誌，可用 NSPredicate 過濾。 |
| `sim_test` | 多步驟介面流程與斷言；逐步驟 PASS／FAIL，最後附上螢幕快照。 |
| `sim_video` | 錄製 H.264 MP4 影片（`start`／`stop`）。 |
| `sim_doctor` | 檢查 Xcode、simctl、AXe、Device Hub 與自動啟動設定。 |

## 自動選擇裝置

當沒有模擬器啟動時：

1. 若設定了 `DSH_SIM_DEFAULT_DEVICE`，優先使用（名稱或 UDID）。
2. 否則優先選擇 iPhone、最新安裝的 runtime，再依最近使用時間排序。

第一次自動啟動會反映在工具結果中（例如 `Auto-booted "iPhone 17" ...`）。任何工具都可傳入 `device`，以名稱或 UDID 指定模擬器。

環境變數覆寫（於外掛載入時讀取；重新啟動或重新安裝後生效）：

| 變數 | 作用 |
| --- | --- |
| `DSH_SIM_DEFAULT_DEVICE` | 自動啟動時偏好的模擬器名稱／UDID。 |
| `DSH_SIM_AUTOBOOT=0` | 停用自動啟動；工具將要求明確啟動的裝置。 |
| `DSH_SIM_BOOT_TIMEOUT` | 開機等待上限（秒，預設 180）。 |
| `DSH_SIM_AXE` | 指定 `axe` 執行檔路徑。 |

## 典型流程

安裝並執行建置產物，然後開始操作：

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

一次呼叫完成回歸檢查：

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

佐證資料：

```text
sim_video({ "action": "start" })
sim_tap({ "label": "Continue" })
sim_video({ "action": "stop" })
```

`sim_test` 支援的步驟動作：`tap`、`type`、`swipe`、`button`、`open_url`、`sleep`、`screenshot`、`assert`（`label`／`id`／`value`／`type`／`text`、`exists`、`timeout`）、`launch`、`terminate`、`install`。

## Web 側邊面板

外掛會在 Web GUI 的右側邊欄註冊一個 **Simulator（模擬器）** 分頁：

- 即時畫面約每秒更新一次（伺服器端會先縮圖）；
- 裝置選擇器，以及 **啟動／關閉**、**主畫面**、**重新整理** 控制項；
- 在畫面上點按任何位置，即會在模擬器的對應位置點按；
- 在已聚焦的欄位輸入文字後按 **Send**（或 Enter），即可在裝置上輸入。

從對話標題列的右側邊欄按鈕開啟，再按 **＋**（新增分頁）並在指南中選擇 **Simulator**。分頁型別屬於外掛的 Client 端，因此安裝新版本後需**重新整理頁面一次**（`Cmd+R`）才會出現面板。

面板會呼叫同源的 Host 路由 `/simulator-control/`（`state`、`frame`、`action`），這些路由套用 Web GUI 的 Connection 信任檢查——沒有瀏覽器已驗證工作階段的請求會以 401 拒絕。

## 已知的模擬器行為（Xcode 26.4+／27）

- **首次開機較慢接受輸入：** 在「第一次」開機後的約 30–120 秒內，HID 點按可能回報成功卻被忽略。`sim_boot` 會預熱輔助使用連線；若第一次互動看似無效，請用 `sim_describe_ui` 重新確認並重試。
- **請保持 Xcode Device Hub 運作：** 結束 Device Hub 會關閉所有已啟動的模擬器。此外掛只會開啟它，絕不會結束它。
- **重複標籤會失敗：** 當多個元素共用同一標籤時，請以 `id`（輔助使用識別碼）點按；`sim_describe_ui` 會以 `#id` 顯示識別碼。
- **同時啟動多個模擬器是常態：** 若同時有多個模擬器啟動，請傳入 `device`；工具錯誤訊息會列出候選裝置。
- **轉場：** 點按後立即呼叫 `sim_describe_ui`，可能短暫看到動畫／卡片樹狀結構；稍等一秒再重新檢視。
- **螢幕快照與模型路由：** 只有在目前模型路由宣告支援圖片輸入時，`sim_screenshot` 才會附加圖片；否則會回傳 PNG 路徑，供使用者或 `read_image` 使用。
- **App 建置產物：** `sim_app find/run/install` 會尋找 `~/Library/Developer/Xcode/DerivedData/*/Build/Products/*-iphonesimulator/*.app`；其他位置的建置請傳入 `app_path`。

## 開發

- `node scripts/e2e.mjs` — 對真實模擬器執行端對端檢查：自動啟動、介面操作、App、豐富的多步驟測試、錄影、側邊面板路由與清理。預設使用 `iPhone 17`；可用 `SIM_DEVICE`／`SIM_UDID` 覆寫。設定 `SIM_TEST_APP_BUNDLE=<bundle id>` 可測試 DerivedData 的尋找／安裝路徑（預設略過）。
- `node scripts/smoke.mjs` — 快速的唯讀煙霧測試。

## 授權條款

MIT — 詳見 [LICENSE](LICENSE)。[AXe](https://github.com/cameroncooke/AXe) 是另一個以 MIT 授權、透過 Homebrew 安裝的專案；本儲存庫並未內嵌它。

## 檔案

- `index.js` — 外掛入口：工具、流程執行器、錄影管理器、提示詞章節。
- `client.js` — Web Client 端：右側邊欄分頁型別、即時面板、語系字典。
- `lib/web.js` — 側邊面板 HTTP 路由（state、frames、actions）與信任檢查。
- `lib/exec.js` — 子程序執行、輸出上限、AXe 探索。
- `lib/devices.js` — 裝置解析、預設選擇、名稱／UDID 解析。
- `lib/actions.js` — 工具、流程與路由共用的標準模擬器操作。
- `lib/format.js` — 裝置／App／AX 樹狀結構格式化。
- `lib/args.js` — 防禦性參數讀取。
- `cordis.patch.yml`、`locale/*.json`、`icon.svg` — 套件包與顯示中繼資料。
