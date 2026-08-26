# Brclio Shot 构建、签名与发布

## 产物矩阵

Tag workflow 生成以下安装包：

| 平台 | 架构 | 产物 |
| --- | --- | --- |
| macOS 13+ | arm64 | DMG、ZIP |
| macOS 13+ | x64 | DMG、ZIP |
| Windows 10/11 64 位 | x64 | NSIS 安装器、portable 便携版 |

所有产物上传到与 tag 同名的 GitHub Release，并生成 `SHA256SUMS.txt`。Windows 两种 `.exe` 会分别带 `installer` 和 `portable` 后缀，避免 electron-builder 的公共 artifactName 互相覆盖。

## 本地候选构建

```bash
npm ci
npm run typecheck
npm test
npm run build
```

在目标系统执行：

```bash
npm run package:mac
npm run package:win
```

产物位于 `release/`。本地 `package:mac`/`package:win` 使用 package.json 中的平台目标；GitHub tag workflow 还会显式构建 macOS 双架构和 Windows x64 两种目标。

## Tag 发布流程

1. 确认工作树干净、CI 通过，并在两端系统完成真实截图/保存/权限回归。
2. 更新 `package.json` 的版本和相应发布说明，在同一提交中审查 `package-lock.json` 版本字段。
3. 确认 tag 必须与包版本完全一致，例如 `package.json` 为 `0.1.0` 时只能发布 `v0.1.0`。
4. 创建并推送 annotated tag：

```bash
git tag -a v0.1.0 -m "Brclio Shot v0.1.0"
git push origin v0.1.0
```

5. `.github/workflows/release.yml` 分别在 macOS arm64、macOS Intel 与 Windows x64 runner 上执行 `npm ci`、typecheck、test、build、package。
6. `publish` job 合并各平台 artifact，生成 SHA-256 清单，并创建 GitHub Release。预发布版本号中包含 `-` 时会标记为 prerelease。
7. 下载 Release 产物到干净机器进行安装、首次权限、截图与卸载测试，再对外宣布。

workflow 可以安全重跑：如果同名 Release 已存在，会使用 `--clobber` 重新上传同名资产。重跑后必须重新核对哈希与签名状态。

## 缺少密钥时的行为

签名 secrets 未配置时，electron-builder 仍然可以构建。macOS workflow 会施加 ad-hoc 开发签名，确保应用包结构和 Electron fuses 可正常启动，但它没有 Developer ID 身份或公证票据；Windows 产物保持未签名。workflow 成功、GitHub Release 存在或 SHA-256 匹配，都不代表包已经获得平台信任。

发布说明必须明确使用下面三种状态之一：

- `Ad-hoc development build`：仅 macOS 本机结构签名，没有 Developer ID 或公证；
- `Unsigned development build`：未签名，也未获得平台发布者身份；
- `Signed, not notarized`：仅 macOS 签名，没有有效公证票据；
- `Signed and notarized` / `Authenticode signed`：完成相应平台验证。

## macOS Developer ID 签名与公证

workflow 已预留 electron-builder 环境变量映射。配置 GitHub Actions secrets：

| Secret | 用途 |
| --- | --- |
| `MAC_CSC_LINK` | Base64 编码的 Developer ID Application `.p12` |
| `MAC_CSC_KEY_PASSWORD` | `.p12` 密码 |
| `APPLE_ID` | Apple Developer 账号（Apple ID 方案） |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple 专用密码 |
| `APPLE_TEAM_ID` | Developer Team ID |

workflow 将前两个映射为 electron-builder 的 `CSC_LINK` / `CSC_KEY_PASSWORD`，后三个用于公证。也可以后续改用 App Store Connect API Key，但不要同时提交密钥文件到仓库。

当前构建配置启用 Hardened Runtime。正式公证前仍需在目标机器验证屏幕录制、Sharp 原生模块、开机启动、托盘与网页整页捕获所需能力；如增加 entitlements 文件，应最小化权限并纳入代码审查。

验证解包后的 `.app` 与公证票据：

```bash
codesign --verify --deep --strict --verbose=2 "Brclio Shot.app"
spctl --assess --verbose --type exec "Brclio Shot.app"
xcrun stapler validate "Brclio Shot.app"
```

只有 `codesign`、Gatekeeper assessment 与 stapler 验证都符合本次声明时，才写“Signed and notarized”。

参考：

- <https://www.electron.build/docs/mac/>
- <https://www.electron.build/docs/notarization/>

## Windows Authenticode

配置 GitHub Actions secrets：

| Secret | 用途 |
| --- | --- |
| `WIN_CSC_LINK` | Base64 编码的代码签名 `.pfx` |
| `WIN_CSC_KEY_PASSWORD` | `.pfx` 密码 |

workflow 直接把它们传给 electron-builder。没有 secrets 时，NSIS 与 portable 都保持未签名。配置后应分别检查安装器、便携版以及安装后的主程序，而不是只检查最外层 `.exe`。

Windows SDK PowerShell 验证示例：

```powershell
Get-AuthenticodeSignature .\Brclio-Shot-*.exe | Format-List
signtool verify /pa /all /v .\Brclio-Shot-*.exe
```

只有状态有效、证书链和时间戳符合发布策略时，才写“Authenticode signed”。

参考：

- <https://www.electron.build/docs/api/app-builder-lib.interface.windowsconfiguration/>
- <https://www.electron.build/docs/github-actions/>

## Release 验收清单

- [ ] tag 与 package version 完全一致；
- [ ] typecheck、全部单元测试和 production build 通过；
- [ ] macOS arm64/x64 与 Windows x64 目标齐全；
- [ ] NSIS 与 portable 文件名不同、都能启动；
- [ ] `SHA256SUMS.txt` 与重新计算结果一致；
- [ ] 签名/公证状态由平台工具验证并在 Release Notes 明示；
- [ ] macOS 13+ 首次授权、拒绝后重试、重启后捕获正常；
- [ ] Windows 64 位区域/窗口/当前屏幕与保存正常；
- [ ] 手动滚动长截图在至少一个浏览器和一个原生应用验证；
- [ ] 网页整页的隔离登录态、超限和失败提示验证；
- [ ] 编辑器复制、保存、贴图和历史清理验证；
- [ ] Release 没有证书、密码、`.p8`、`.p12`、`.pfx` 或调试日志。

---

Designed and built by Brclio<br>
© 2026 Brclio
