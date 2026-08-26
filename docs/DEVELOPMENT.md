# Brclio Shot 开发与架构

## 技术栈

- Electron 44
- React 19 + TypeScript
- electron-vite / Vite
- Sharp：裁剪、编码、缩略图与长图拼接输出
- Vitest + Happy DOM：单元测试
- electron-builder：macOS 与 Windows 安装包

运行时支持策略是 macOS 13+（arm64/x64）和 64 位 Windows 10/11（x64）。Linux 不是 v0.1 的交付目标。

## 环境

使用 Node.js `22.12+` 或 Node.js 24 LTS。依赖以 `package-lock.json` 为准，CI 和本地可复现安装统一使用：

```bash
npm ci
```

不要用 `npm install` 更新锁文件，除非本次改动就是依赖升级并会审查相应 diff。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动 electron-vite 开发模式 |
| `npm run preview` | 预览已构建应用 |
| `npm run typecheck` | 检查主进程、preload 与 renderer TypeScript |
| `npm test` | 运行 Vitest 单元测试 |
| `npm run test:watch` | 监听模式运行测试 |
| `npm run build` | 类型检查并构建到 `out/` |
| `npm run package` | 生成当前平台未安装目录 |
| `npm run package:mac` | 在 macOS 生成 DMG/ZIP |
| `npm run package:win` | 在 Windows 生成 NSIS/portable |

安装包输出目录为 `release/`。

## 进程结构

```text
System APIs / filesystem
          │
          ▼
src/main/                 Electron 主进程
  ├─ capture-engine       桌面来源、坐标/DIP 到像素映射
  ├─ capture-stream       隐藏抓帧运行时与连续采样
  ├─ scroll-stitcher      重叠估计、固定边缘检测、拼接限额
  ├─ webpage-capture      临时隔离会话与 CDP 分片整页捕获
  ├─ save-service         图片编码、文件名、原子写入
  ├─ history-store        本地原图、缩略图与索引
  ├─ settings-store       设置规范化、0600 写入与原子替换
  └─ shortcut-registry    全局快捷键注册/冲突状态
          │ typed IPC only
          ▼
src/preload/              contextBridge 白名单 API
          │
          ▼
src/renderer/             React 工作台、选区、编辑器、贴图、控制条
```

共享类型和 IPC 通道在 `src/shared/types.ts`，单元测试在 `tests/unit/`。

## 捕获数据流

### 区域

1. 主进程定位光标所在 display，隐藏自身可见窗口并抓取冻结帧。
2. sandbox renderer 展示选区层，返回全局 DIP 矩形。
3. 主进程把 DIP 映射到真实像素并裁剪，创建 `CaptureAsset`。
4. 根据设置写本地历史，并进入编辑器、剪贴板或保存服务。

多显示器、缩放比例和分数 DIP 的边缘处理集中在捕获引擎，避免 renderer 自行猜测像素比例。

### 窗口与当前屏幕

窗口来源来自 `desktopCapturer` 列表，选择后再次按 ID 解析来源；已关闭目标和 Brclio Shot 自身窗口会被拒绝。当前屏幕定位光标最近 display，不合并多屏。

### 手动滚动长截图

选择区域后，隐藏抓帧运行时连续采样同一显示器，再由主进程裁剪到固定区域。停止时：

- 解码各帧并检查尺寸/总像素预算；
- 估计相邻帧垂直重叠、相似度与置信度；
- 丢弃近重复帧，检测稳定页头/页脚；
- 置信度不足时拒绝输出，避免错误拼接；
- 通过 Sharp 输出 PNG，并附带警告与有效帧数。

默认安全预算由设置和拼接器共同约束，输出最大高度 100,000 像素、最大 200,000,000 像素。

### 网页整页

网页整页与常用浏览器隔离。隐藏窗口使用随机临时 partition，启用 sandbox、context isolation 与 web security；拒绝页面权限、下载和新窗口。加载仅允许 HTTP/HTTPS，30 秒超时，先滚动触发部分懒加载，再通过 Chrome DevTools Protocol 获取布局和分片截图。

这是一个会访问远程 URL 的功能，不应把“本地优先”误写成“完全无网络”。

## 安全约束

- 所有应用 renderer：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true`。
- 生产 renderer 由主进程的 `brclio://app` 只读协议从签名资源目录加载；协议固定主机、阻止目录穿越，并保留页面 CSP。
- Renderer 只能使用 preload 明确暴露的接口。
- 工作台 IPC 只接受主窗口发送者；选区事件还会绑定当前 overlay 窗口。
- 截图模式、来源 ID、URL 长度、延时时间、数据 URL 和文件路径在主进程检查。
- 外部链接默认拒绝，仅允许既定 Brclio/GitHub 链接交给系统浏览器。
- “在文件夹中显示”只接受本次运行已知文件或当前保存目录内路径。
- 保存服务限制输入大小、规范化跨平台文件名、避免默认覆盖并使用临时文件原子落盘。
- 设置和截图保存使用用户权限，不提升进程权限。

新增 IPC 时必须同时完成：共享类型、preload 最小暴露、主进程 sender 验证、输入检查和相应测试。

## 测试范围

现有单元测试覆盖：

- 多显示器来源解析、DIP/像素坐标和裁剪边界；
- 文件名清理、模板渲染和图片数据校验；
- 默认设置、范围收敛、持久化和重复快捷键拒绝；
- 重叠估计、重复帧、固定边缘、宽度不一致与安全限额。

提交前至少运行：

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

涉及 UI 或捕获行为时，还需在真实 macOS/Windows 机器验证：多显示器、不同缩放比例、权限拒绝/授予、窗口关闭竞态、慢速长截图、保存目录不可写和快捷键占用。

## CI

`.github/workflows/ci.yml` 在 push 与 pull request 上使用 `npm ci`，分别于 macOS arm64、macOS Intel 和 Windows x64 运行 typecheck、test、build。它验证可编译性，不创建正式签名声明。

Tag workflow 见[发布文档](RELEASING.md)。

---

Designed and built by Brclio<br>
© 2026 Brclio
