# Ubuntu 24.04 arm64 运行依赖

这些是 Ubuntu 官方 `ports.ubuntu.com/ubuntu-ports` 的原始二进制 `.deb`，取自 `noble`、`noble-updates`、`noble-security` 的 main/universe。获取过程使用独立 APT 配置、索引目录、空安装状态与下载缓存；不在开发机安装这些 arm64 软件包，也不修改系统 apt 源。

`packages.json` 记录每个包的名称、版本、arm64/all 架构、相对路径、大小、SHA256、官方二进制 URL，以及对应的源码包名和版本。每个二进制都已与 Ubuntu 签名索引内的 SHA256 对照。`complete:true` 表示所选资产已下载齐全，不代表 DSHA 或所有 QQ 功能已经验收。

本轮从固定 QQ `3.2.34-53644` 的实际 Depends 解算：`libgtk-3-0`、`libnotify4`、`libnss3`、`libxss1`、`libxtst6`、`xdg-utils`、`libatspi2.0-0`、`libuuid1`、`libsecret-1-0`；加入 Xvfb、xauth，以及 QQ ELF 所需的 GBM、ALSA、xkbcommon、CUPS、Xcomposite、Xdamage、Xrandr、udev、xshmfence。使用 `--no-install-recommends` 获取依赖闭包，保留 Mesa/LLVM、XKB、字体、GTK 组件和动态加载模块，不把“能启动”当作所有功能的证明。

宿主基线是 **DSHA Ubuntu 24.04 / glibc 2.39**。已观测设备为 `2.39-0ubuntu8.5`；下载闭包原本选择 `libc6 2.39-0ubuntu8.9`，为避免新 libc 与宿主动态加载器混用，已从交付资产和清单中排除 `libc6`。运行时须继续使用 DSHA 自身的 glibc 和加载器，不向宿主 `/usr`、`/lib` 全局覆盖任何文件。

运行时契约：在插件数据目录中建立隔离前缀，对清单里的每个 `debs/*.deb` 执行 `dpkg-deb -x <包> <隔离前缀>`，仅展开资产；不执行 `dpkg -i`、维护脚本、触发器或包里的系统服务。`.deb` 自身保留 Linux 文件权限和符号链接，兼容 Windows 侧打包。Xvfb/XKB/字体/共享库应使用隔离前缀内的路径；不依赖 systemd、桌面会话或真实 root。包内存在 dbus/systemd 的传递依赖文件并不意味着运行时会启动这些服务。

各包许可和版权文件保留在原 `.deb` 的 `usr/share/doc/<包>/copyright`，不可用本插件的 MIT 许可替代。需要对应源码时，使用清单的 `sourcePackage`、`sourceVersion` 获取精确 Ubuntu 源码包，并按每个包的许可提供；二进制下载 URL 本身不替代源码分发义务。源码交付不应塞进手机插件导入包而突破 256 MiB 限额。

最终软件资产统计以 `packages.json` 为准。普通主机上的 ELF/文件检查、真机进程启动、QQ 扫码与业务功能是不同验证层级，具体设备结果由本项目的验收记录单独记录。
