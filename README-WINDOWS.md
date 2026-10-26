# Windows 安装与管理

要求 Windows x64、Node.js 24+、Windows PowerShell 5.1+，以及自行安装的官方 Accio 桌面客户端。曾适配 Accio 0.35.2；其他版本需要重新验证。

```powershell
npm test
.\install-windows.ps1 -AccioExecutable 'C:\path\to\Accio.exe'
$install = Join-Path $env:LOCALAPPDATA 'Accio Local API'
& (Join-Path $install 'login-windows.ps1')
```

将示例路径替换为自己的官方程序。安装器默认写入当前用户 LocalAppData，拒绝覆盖已有目录；可用 `-Destination` 指定新的目录。默认创建当前用户 Startup 快捷方式并启动服务；`-NoStartup` 跳过自启，`-NoStart` 跳过启动。无需管理员权限。安装器要求 PATH 中存在 Node.js。

在官方 Accio 选择个人或团队空间，再在浏览器完成本桥接独立登录。桥接不会复制官方客户端登录凭据。独立登录使用 Windows DPAPI CurrentUser 加密；状态目录 ACL 限于当前用户、SYSTEM 和 Administrators。

```powershell
& (Join-Path $install 'start-windows.ps1')
& (Join-Path $install 'stop-windows.ps1')
node (Join-Path $install 'src\cli.mjs') status
node (Join-Path $install 'src\cli.mjs') models
node (Join-Path $install 'src\cli.mjs') quota
node (Join-Path $install 'src\cli.mjs') key
```

`key` 仅供本人在本地查看，勿将输出发到 Issue 或日志。客户端地址为 `http://127.0.0.1:18437`。启动脚本从安装时生成的 `windows-install.json` 设置官方程序路径、版本和状态目录。凭据、Key、日志和 PID 位于安装目录的 `state/`。

重复启动会检查已有进程的可执行文件和服务路径；停止脚本只结束匹配的实例。退出服务后，删除当前用户 Startup 中的 `Accio Local API.lnk` 可取消登录自启。升级前保留旧安装与状态目录，安装到新目录并自行登录；当前没有自动升级器。

本仓库不附带作者的客户端配置、Magpie/CC Switch 实例、官方二进制或登录态。客户端供应商设置由使用者自行完成，参见主 README。
