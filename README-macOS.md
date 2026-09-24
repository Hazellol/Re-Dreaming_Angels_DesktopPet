# macOS 运行说明

本项目原为 Windows 平台开发，在 macOS 上已做兼容适配。本文件记录 macOS 下的差异与用法。

## 启动方式

| 方式 | 说明 |
|---|---|
| `dist/妄想天使桌宠.app` | 打包版，拖进「应用程序」后双击即用（推荐） |
| 双击 `启动妄想天使.command` | 源码版启动器，等价于 Windows 的 `一键启动妄想天使.vbs` |
| `npm start` | 命令行启动 |
| `npm run pack:mac` | 重新打包，产物在 `dist/`（`.app` + `.dmg`，arm64） |

打包版未做代码签名，首次打开若提示「无法验证开发者」，在 `.app` 上右键 →「打开」即可。

## 与 Windows 版的行为差异

| 功能 | macOS 表现 | 原因 |
|---|---|---|
| 窗口形状裁剪（SetWindowRgn） | 不可用，自动降级为整窗 | Win32 API，靠 koffi 调用 `user32.dll` |
| 遮挡检测（被完全覆盖时暂停渲染） | 已禁用 | 依赖 powershell 枚举窗口 |
| 拖动守护（物理左键交叉验证） | 已禁用，改由 12s 超时兜底 | 依赖 `GetAsyncKeyState` |
| 输入通道自愈（L1→L3） | 已禁用 | 判据基于 Win32 鼠标消息转发语义，在 macOS 上会误报并造成窗口抖动 |
| 本地语音合成（TTS） | 不可用 | GPT-SoVITS 整合包是 Windows Python 运行时，且默认推理设备为 CUDA |
| 开机自启动 | 建议使用打包版 | 源码版注册的是 Electron 可执行文件本身 |

其余功能（Spine 渲染、点击互动、拖动甩飞、右键菜单、AI 对话、角色互聊、BGM 播放器、托盘、多显示器、置顶开关、救援快捷键 `Control+Alt+Z`）均正常。

## 数据目录

- 源码版运行数据：项目内 `data/`
- 打包版运行数据 / 用户导入的 BGM：`~/Library/Application Support/ReDreamingAngels/`

## AI 对话配置

右键任意角色 →「对话配置」→ 填入 DeepSeek API Key → 连接测试 → 保存配置。
API Key 存于上述数据目录，不会上传到除 DeepSeek 以外的任何地方。

## 退出

菜单栏托盘图标 →「退出桌宠」，或 `Cmd+Q`。
