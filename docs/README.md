# PromptHub

PromptHub 是一个本地优先的提示词生命周期管理工具。PWA 网页只负责运行界面，提示词数据默认保存在每个用户自己的浏览器 IndexedDB 中，不上传到服务器。

## 核心功能

- 按「场景 → 提示词 → 版本」管理提示词资产
- 提示词收藏、搜索、排序、复制和内容展开
- 版本切换、历史记录、备注以及单版本编辑和删除
- JSON 导入/导出，适合备份和团队共享
- PWA 安装到桌面或主屏幕
- 离线缓存应用外壳，首次打开后可离线使用
- Chrome/Edge 等支持 File System Access API 的浏览器可打开本地 JSON 文件，并点击「保存」写回同一个文件

## 本地运行

必须在包含 `index.html` 的 PromptHub 项目目录里启动服务：

```bash
cd "/Users/yibo/Documents/prompt management"
python3 -m http.server 5173
```

然后打开：

```text
http://localhost:5173
```

如果页面显示 `Directory listing for /`，说明服务启动在了上一级目录。进入 PromptHub 项目目录后重新运行上面的命令即可。

## 数据保存方式

PromptHub 有两层保存：

- 日常自动保存：新增、编辑、删除会立即保存到当前浏览器的 IndexedDB。
- 文件保存：点击「打开 JSON」连接本地文件后，点击「保存」会写回该文件；如果未连接文件，第一次点击「保存」会弹出保存位置和文件名选择。

如果浏览器不支持直接写入本地文件，PromptHub 会退回到「导入备份 / 导出备份」模式。

## GitHub Pages 发布

推荐新建一个仓库，例如 `prompthub`。先在本地生成 GitHub Pages 发布目录：

```bash
./package-pwa.sh
```

脚本会生成 `docs/`，其中只包含 PWA 需要的静态文件：

```text
docs/index.html
docs/styles.css
docs/app.js
docs/manifest.webmanifest
docs/service-worker.js
docs/icons/
docs/.nojekyll
```

不要提交：

```text
build/
dist/
node_modules/
```

在 GitHub 中开启 Pages：

1. 进入仓库 `Settings`
2. 打开 `Pages`
3. Source 选择 `Deploy from a branch`
4. Branch 选择 `main`，目录选择 `/docs`
5. 保存后等待 GitHub 生成访问地址

地址通常类似：

```text
https://你的用户名.github.io/prompthub/
```

## 分享给伙伴

发送 GitHub Pages 链接即可。每个人第一次打开后会拥有自己的本地库。

团队共享提示词库时：

1. 一个人点击「导出备份」
2. 把 JSON 文件发给伙伴
3. 伙伴点击「导入备份」或「打开 JSON」

## 注意事项

- 清除浏览器站点数据会删除 IndexedDB 中的本地库。
- 更换浏览器、设备或域名后，数据不会自动迁移。
- 建议定期导出 JSON，或在支持的浏览器里连接一个本地 JSON 文件并手动保存。
- File System Access API 主要支持 Chrome、Edge 等 Chromium 浏览器；Safari 和 Firefox 可能只能使用导入/导出备份。
