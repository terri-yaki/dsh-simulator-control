# Simulator Control

**模擬器控制** · [English](#simulator-control) · [繁體中文](#繁體中文)

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

---

# 繁體中文

[English](#simulator-control) · [繁體中文](#繁體中文)

[github.com/terri-yaki/dsh-simulator-control](https://github.com/terri-yaki/dsh-simulator-control) · MIT 授權 · 需要 macOS、Xcode 與 [AXe](https://github.com/cameroncooke/AXe)

你的 Agent 會寫 iOS 程式，但它看不到、也碰不到模擬器。這個插件就是把這一段補起來：它給 DSH 一組 `sim_*` 工具來操作 iOS 模擬器，另外在右側邊欄給你一個即時面板。建置 → 安裝 → 點介面 → 看畫面 → 讀日誌，全都在對話裡完成。

裝好之後你會拿到這些：

- **挑裝置、開模擬器** — 自動找出你機器上已有的模擬器；沒有半台在跑時，挑一台合適的 iPhone 開起來，不必自己敲 `simctl`。
- **App 管理** — 列出已安裝的 App、在 Xcode 的 DerivedData 裡找到你的模擬器建置、安裝、啟動、結束、解除安裝，還能查容器路徑。
- **介面操作** — 匯出輔助使用樹、依標籤或識別碼點按（真的需要時也能用座標）、輸入文字、滑動、按硬體按鈕、開啟深層連結。
- **佐證資料** — 螢幕快照（模型支援圖片時直接出現在對話裡）、H.264 影片，以及模擬器日誌。
- **測試** — `sim_test` 執行一連串步驟與等待／斷言，告訴你是哪一步失敗，最後附上一張螢幕快照。
- **側邊面板** — 右側邊欄的 Simulator 分頁，你可以自己看著畫面點按、輸入。

背後是兩個大家熟悉的工具：

| 後端 | 負責什麼 |
| --- | --- |
| `xcrun simctl`（Xcode） | 裝置生命週期、App 安裝／啟動、螢幕快照、深層連結、日誌、狀態列、外觀、位置、隱私權限、剪貼板、錄影 |
| [AXe](https://github.com/cameroncooke/AXe) CLI | 輔助使用樹、依標籤／識別碼或座標點按、滑動、輸入文字、硬體按鈕 |

AXe 走的是 Apple 的 HID 與輔助使用通道，不是 macOS 的 `CGEvent`，所以**不需要授予 macOS「輔助使用」權限**，也能用在 Xcode 27 的 Device Hub 上（`Simulator.app` 已經不在了）。點按預設走 AXe 的實體觸碰模式；螢幕快照優先走 AXe 的快速顯示路徑，失敗才退回 `simctl io`。

## 需求

- macOS，安裝**完整版 Xcode**（26 或 27），以及至少一個 iOS 模擬器 runtime。
- [AXe](https://github.com/cameroncooke/AXe) 1.8 以上：

  ```bash
  brew install cameroncooke/axe/axe
  ```

  沒裝的話，`sim_doctor` 會告訴你要補什麼。

## 安裝

把這個目錄的套件包安裝進你的 profile：

```
plugin_manager({ action: "install_bundle", target: "/Users/terry/workspace/dsh-simulator-control" })
```

已經裝過的話，先 `remove_bundle` 再 `install_bundle`。Profile 的接線由插件管理器負責，不需要手動改任何設定檔。

## 工具

只有一台模擬器在跑時，所有工具都可以省略 `device`。沒有任何一台在跑時，插件會自動挑一台開起來，並在結果裡說明，然後照常執行。`sim_devices` 與 `sim_doctor` 都會顯示自動啟動會挑哪一台。

| 工具 | 做什麼 |
| --- | --- |
| `sim_devices` | 列出模擬器（runtime、UDID、狀態）與自動啟動目標。 |
| `sim_boot` | 啟動指定裝置或自動挑選的裝置，並等到自動化就緒。 |
| `sim_shutdown` | 關閉一台或全部模擬器。 |
| `sim_screenshot` | 存成一張 PNG；模型支援圖片時會一併附到對話。 |
| `sim_describe_ui` | 精簡的輔助使用樹：標籤、識別碼、數值、以點為單位的畫框。 |
| `sim_tap` | 依標籤／識別碼／數值點按（可等待），或直接用座標。 |
| `sim_type` | 輸入文字；可先全選，或送出 Return。 |
| `sim_swipe` | 依方向滑動（自動量測畫面中心），或在指定兩點之間滑動。 |
| `sim_button` | 按下 home、lock、side-button、siri、apple-pay。 |
| `sim_open_url` | 開啟 URL 或自訂 App scheme（深層連結）。 |
| `sim_app` | `list`／`find`／`install`／`run`／`launch`／`terminate`／`uninstall`／`container`。 |
| `sim_env` | 外觀、狀態列覆寫、位置、隱私權限、剪貼板、開啟 Device Hub。 |
| `sim_logs` | 最近的模擬器日誌，可用 NSPredicate 過濾。 |
| `sim_test` | 多步驟介面流程與斷言；逐步驟 PASS／FAIL，最後附一張螢幕快照。 |
| `sim_video` | 錄製 H.264 MP4 影片（`start`／`stop`）。 |
| `sim_doctor` | 檢查 Xcode、simctl、AXe、Device Hub 與自動啟動設定。 |

## 自動挑選裝置

沒有模擬器在跑時：

1. 有設定 `DSH_SIM_DEFAULT_DEVICE` 就先用它（名稱或 UDID）。
2. 否則優先挑 iPhone、最新的 runtime，再依最近使用時間排序。

第一次自動啟動會出現在工具結果裡（例如 `Auto-booted "iPhone 17" ...`）。任何工具都能傳 `device`，用名稱或 UDID 指定某一台。

環境變數會在插件載入時讀取（重新啟動或重新安裝後生效）：

| 變數 | 作用 |
| --- | --- |
| `DSH_SIM_DEFAULT_DEVICE` | 自動啟動時偏好的模擬器名稱／UDID。 |
| `DSH_SIM_AUTOBOOT=0` | 關閉自動啟動；工具會要求你先自己開好裝置。 |
| `DSH_SIM_BOOT_TIMEOUT` | 開機等待上限（秒，預設 180）。 |
| `DSH_SIM_AXE` | 指定 `axe` 執行檔路徑。 |

## 幾個常見流程

把目前的建置裝起來，開始動手：

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

一次呼叫做完回歸檢查：

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

要附在 bug report 裡的東西：

```text
sim_video({ "action": "start" })
sim_tap({ "label": "Continue" })
sim_video({ "action": "stop" })
```

`sim_test` 支援的步驟動作：`tap`、`type`、`swipe`、`button`、`open_url`、`sleep`、`screenshot`、`assert`（`label`／`id`／`value`／`type`／`text`、`exists`、`timeout`）、`launch`、`terminate`、`install`。

## Web 側邊面板

右側邊欄會多一個 **Simulator** 分頁：

- 畫面約每秒更新一次（伺服器端先縮圖）；
- 裝置選擇器，加上 **啟動／關閉**、**主畫面**、**重新整理**；
- 在畫面上點哪裡，就在模擬器的同一個位置點一下；
- 在已聚焦的欄位輸入文字，按 **Send**（或 Enter）就送進裝置。

從對話標題列的右側邊欄按鈕打開，按 **＋**，在指南裡選 **Simulator**。分頁型別在插件的 Client 端，所以安裝新版本後只要重新整理頁面一次（`Cmd+R`）就會出現。

面板呼叫的是同源路由 `/simulator-control/`（`state`、`frame`、`action`），會走 Web GUI 的連線檢查——沒有已驗證的瀏覽器工作階段就會被 401 擋下。

## Xcode 26.4+／27 上會遇到的狀況

這些是我在做這個插件時踩到的，先寫下來讓你少繞一點路：

- **剛開好的模擬器比較慢才吃輸入。** 「第一次」開機後的 30–120 秒內，HID 點按可能回報成功卻沒反應。`sim_boot` 會先預熱輔助使用連線；如果第一次互動像被吃掉，用 `sim_describe_ui` 確認一下再重試。
- **讓 Device Hub 保持開著。** 把它結束掉會關閉所有已啟動的模擬器。插件只會在你要求時打開它，永遠不會把它關掉。
- **重複的標籤不能當點按目標。** 多個元素共用同一標籤時，改用 `id` 點按——`sim_describe_ui` 會以 `#id` 顯示。
- **同時開好幾台模擬器很正常。** 有不只一台在跑時，請傳 `device`；錯誤訊息會列出候選裝置。
- **轉場要注意。** 剛點按完，`sim_describe_ui` 可能短暫回傳動畫／卡片樹；等一秒再看一次。
- **螢幕快照要看模型路由。** 只有在目前模型宣告支援圖片輸入時，`sim_screenshot` 才會附上圖片；否則你會拿到 PNG 路徑，自己看或交給 `read_image`。
- **`sim_app find/run/install` 找的是 DerivedData。** 路徑是 `~/Library/Developer/Xcode/DerivedData/*/Build/Products/*-iphonesimulator/*.app`。建置在別的地方就傳 `app_path`。

## 開發

- `node scripts/e2e.mjs` — 對真實模擬器跑端對端檢查：自動啟動、介面操作、App、多步驟測試、錄影、側邊面板路由、清理。預設用 `iPhone 17`，可用 `SIM_DEVICE`／`SIM_UDID` 換。設 `SIM_TEST_APP_BUNDLE=<bundle id>` 可以測 DerivedData 的尋找／安裝路徑（預設略過）。
- `node scripts/smoke.mjs` — 快速的唯讀煙霧測試。

## 授權

MIT — 詳見 [LICENSE](LICENSE)。[AXe](https://github.com/cameroncooke/AXe) 是另一個 MIT 授權、透過 Homebrew 安裝的專案；本儲存庫沒有內嵌它。

## 檔案

- `index.js` — 插件入口：工具、流程執行器、錄影管理器、提示詞章節。
- `client.js` — Web Client 端：右側邊欄分頁型別、即時面板、語系字典。
- `lib/web.js` — 側邊面板 HTTP 路由（state、frames、actions）與信任檢查。
- `lib/exec.js` — 子程序執行、輸出上限、AXe 探索。
- `lib/devices.js` — 裝置解析、預設選擇、名稱／UDID 解析。
- `lib/actions.js` — 工具、流程與路由共用的標準模擬器操作。
- `lib/format.js` — 裝置／App／AX 樹狀結構格式化。
- `lib/args.js` — 防禦性參數讀取。
- `cordis.patch.yml`、`locale/*.json`、`icon.svg` — 套件包與顯示中繼資料。
