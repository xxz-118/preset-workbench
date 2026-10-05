# 预设工作台 · Preset Workbench

一个 SillyTavern UI 扩展。从酒馆的**扩展菜单（魔杖图标）**打开一个可拖动、可缩放的浮窗，把「一条一条换」变成「一张表全看到」。

原生酒馆的预设下拉框只对**当前选中的那一条**提供「更新 / 删除 / 另存为」。想改别的，必须先在几十条预设里把它切出来。这个扩展把预设摊成一张表格，每一行都带独立按钮，直接对它动手，**当前预设不会被切走**。

不占用扩展设置页：装好之后，扩展设置页里只有开关，功能全在浮窗里。

---

## 安装

### 方式一：酒馆界面安装（推荐）

用户设置 → **扩展** → 展开「安装扩展」→ 在**扩展 URL** 里填入：

```
https://github.com/xxz-118/preset-workbench
```

点 **Install**，然后**刷新页面**。不需要重启服务器。

### 方式二：手动 clone

```bash
cd SillyTavern/data/<你的用户名>/extensions
git clone https://github.com/xxz-118/preset-workbench.git
```

刷新页面即可。

---

## 打开浮窗

**主入口**：点酒馆输入框上方的**魔杖图标**（Extensions 菜单），选「预设工作台」。

**键盘入口**：在任意输入框输入斜杠命令 `/pw`，打开或关闭窗口。

窗口行为：

- 拖**标题栏**可移动窗口。
- 拖**右下角**可调整窗口大小。
- 位置和尺寸会被记住，下次打开还在原地。
- 标题栏右侧的 ⟲ 按钮把窗口恢复成默认位置与大小。
- **点窗口外的遮罩**或按 **Esc** 关闭。酒馆自己的弹窗打开时 Esc 优先关弹窗，不会误关窗口。

---

## 支持的预设类型

窗口顶部的标签页可切换 8 类，默认停在 Chat Completion；每个标签上带该类预设的数量。

| 标签 | apiId | 磁盘目录（位于用户目录下） |
| --- | --- | --- |
| Chat Completion | `openai` | `OpenAI Settings/` |
| 文本补全 | `textgenerationwebui` | `TextGen Settings/` |
| KoboldAI | `kobold` | `KoboldAI Settings/` |
| NovelAI | `novel` | `NovelAI Settings/` |
| 指令模板 | `instruct` | `instruct/` |
| 上下文模板 | `context` | `context/` |
| 系统提示词 | `sysprompt` | `sysprompt/` |
| 推理模板 | `reasoning` | `reasoning/` |

工具栏的搜索框按名字过滤当前类型。

---

## 每张卡片的按钮

- **应用** — 把这条切换成当前预设，等同于原生下拉框选中它。
- **覆盖更新** — 用**当前面板里的运行设置**覆盖写入这条预设文件。**不切换当前预设**。这是原生 UI 做不到的那件事。
- **重命名** — 先写新文件，确认成功后才删旧文件；中途失败不会丢数据。
- **复制** — 另存为新预设，自动避让重名（`原名 (副本)`、`原名 (副本) (2)` …）。
- **导出** — 把这条预设下载成一个 JSON 文件。
- **删除** — 从磁盘删掉该 JSON 文件，会二次确认。

工具栏：

- **刷新** — 重新扫描磁盘，拿到最新列表。手动往目录里丢文件后用它。
- **导入** — 支持单条预设文件，也支持本扩展「全部导出」产生的打包文件。同名会自动改名，不会静默覆盖。
- **全部导出** — 把当前类型的全部预设打包成一个 JSON，用来整体备份。

卡片上会显示这条预设的结构信息（提示词条数、排序组数、正文长度、文件大小），当前生效的那条有高亮边框和「当前」标记。

---

## 行为边界

这些是刻意保留的限制，都有明确原因：

1. **不允许删掉最后一个预设。** 酒馆切换预设时会执行 `structuredClone(openai_settings[openai_setting_names[name]])`，一条都没有时读到 `undefined` 并抛错。面板会把最后一条的删除按钮锁死。
2. **删除正在使用的预设时，会自动切到列表第一条。** 这是必须的——否则 `settings.json` 里记着的当前预设名会指向一个已不存在的文件，下次开页面指向空。切换走酒馆自己的 `selectPreset()`，状态由酒馆写回。
3. **进阶模板（指令 / 上下文 / 系统提示词 / 推理）的名字取自文件内容里的 `name` 字段，不是文件名。** 酒馆删除时用这个名字去拼 `<name>.json` 找文件；内容里的 `name` 和实际文件名不一致时会删不掉（面板会给出警告）。列表检测到重名也会标出来。
4. **「覆盖更新」写入的是酒馆认定「预设应保存的字段」。** 它剔除了连接类字段（`api_server`、`preset_settings`、各家的 `*_model`、`streaming_*` 等），这是酒馆 `PresetManager.getPresetSettings()` 的既有口径，本扩展没有扩大范围。
5. **「覆盖更新」只改内容，不改名字。** 想连名字一起动就用「重命名」。

---

## 它为什么能「不切换就改」

三条硬事实，对照 SillyTavern 1.18.0 源码逐条核实过（下列路径均指 SillyTavern 仓库内的文件）：

1. **磁盘才是唯一真相。** `POST /api/settings/get` 每次都会重新扫描预设目录，把 `openai_setting_names` / `openai_settings` 等从文件重建（`src/endpoints/settings.js:219`、`:92`）。`settings.json` 里根本不存预设名单。所以本扩展直接重新调这个端点，拿到的就是磁盘实况，包括原生下拉框里没有的文件。
2. **写盘和删盘是独立端点。** `POST /api/presets/save` 与 `POST /api/presets/delete` 只认 `{ name, apiId }`，跟「谁是当前预设」完全无关（`src/endpoints/presets.js:42`、`:60`）。
3. **原生 UI 之所以要求先切换，是它自己的副作用。** `PresetManager.updateList()` 在保存成功后会顺手 `.trigger('change')`，把当前预设切到刚改的那条（`public/scripts/preset-manager.js:602-633`）。本扩展统一用 `savePreset(name, settings, { skipUpdate: true })` 绕开它，再自行同步内存数组与下拉框 option —— **故意不触发 `change`**。

绕开副作用之后必须自己补上内存同步：酒馆切预设时是从内存数组 `openai_settings` 读的（`public/scripts/openai.js:4904`）。只写盘不同步内存，本次会话里切回去会加载到旧内容。所以每次写盘后都会调用内部的 `syncMemory()`。

---

## 浮窗的层级选择

窗口与遮罩取 `z-index: 9000`，**刻意低于**酒馆弹窗 `#dialogue_popup` / `#shadow_popup` 的 `9999`（`public/style.css:3677`、`:3860`）。这样「删除确认」这类原生 Popup 会盖在浮窗之上，点确认按钮也不会穿透到自己的遮罩而误关窗口。toastr 是 `999999`，操作反馈始终可见。

---

## 兼容性

- 目标：SillyTavern 1.12.0 及以上（`minimum_client_version`），实测于 **1.18.0**。
- 只使用 `SillyTavern.getContext()` 暴露的公开接口与官方 HTTP 端点。只 import 了 `extensions.js` / `script.js` 的公开导出，与酒馆自带第三方扩展的惯例一致。
- 颜色全部派生自酒馆主题 CSS 变量，跟随亮色 / 暗色 / 自定义主题。
- 无构建步骤，无外部依赖，无第三方网络请求（只访问酒馆自己的本地 API）。
- 会同步进内存的只有预设数组与下拉框 option，不注入提示词、不注册宏、不挂全局工具。

---

## 卸载

删掉扩展目录即可，不残留任何服务端状态：

```bash
rm -rf SillyTavern/data/<你的用户名>/extensions/preset-workbench
```

扩展只在 `extension_settings['preset-workbench']` 里存了两项 UI 记忆：当前选中的类型标签、浮窗的位置与尺寸。想一起清掉，就在 `settings.json` 的 `extension_settings` 里删掉 `preset-workbench` 这个键。

**预设文件本身永远不受卸载影响** —— 扩展只按需读写，没有额外的中转存储。

---

## 已知限制

- 预设的**修改时间**读不到。`/api/settings/get` 只返回内容，不返回 `mtime`，所以卡片显示的是文件大小和结构特征。
- 预设非常多、单条非常大时，首次读取要解析全部 JSON。只有打开窗口、点「刷新」和切换标签会读取；日常的更新 / 复制 / 重命名 / 删除不会重新全量读取。
- 窗口关闭期间不会后台刷新，也不轮询磁盘。

---

## License

[MIT](LICENSE)
