# 发布指南（PUBLISH.md）

本项目是 poi（舰娘浏览器）插件，通过 npm 发布后，所有 poi 用户都能在 poi 的插件管理器里搜索/输入包名直接安装。

## 原理：poi 怎么"关联"到你的插件

poi 的插件管理器只认 **包名以 `poi-plugin-` 开头** 的 npm 包（`views/services/plugin-manager` 里 `readPlugin` 会校验
`/poi-plugin-.+/`，不符合直接拒绝加载），并读取 `package.json` 的 `poiPlugin` 字段作为显示名/图标。
所以 **"关联到 poi" 不需要任何申请或审核**，只要：

1. 包名 = `poi-plugin-nangua-liuchuan`（✓ 已满足，且 npm 上未被占用）
2. `main` = `index.es`，且入口具名导出 `reactClass`（✓ 已满足）
3. 发布到 npm registry（下面步骤）

## 一、推送到 GitHub

在 `Nan-Gua` 目录（仓库根目录，含 package.json / index.es / README.md）执行：

```bash
git init
git add .
git commit -m "南瓜留船 v1.1.2"
git branch -M main
git remote add origin https://github.com/Sa1m0n1003/Nan-Gua.git
git push -u origin main
```

> 如果你已经在本地有同名仓库，跳过 `git init`，直接 `git remote add origin ...` 后推送。

## 二、发布到 npm

1. 注册 npm 账号：https://www.npmjs.com/signup
2. 本地登录：`npm login`（按提示输入用户名/密码/邮箱/OTP）
3. 在 `Nan-Gua` 目录发布：
   ```bash
   npm publish
   ```
4. 验证：浏览器打开 `https://www.npmjs.com/package/poi-plugin-nangua-liuchuan`

> `package.json` 里已配置 `"files": ["index.es", "README.md"]`，发布包只含必要文件。

## 三、以后更新版本

每次修改后：

```bash
npm version patch   # 或 minor / major，自动把版本号 +1 并打 tag
git push --tags     # 推 tag
npm publish         # 手动发布
```

或者用自动发布：在 GitHub 仓库 Settings → Secrets and variables → Actions 里添加
`NPM_TOKEN`（npm 网站 → Access Tokens → Generate New Token，选 **Publish** 类型），
之后只要 `git push --tags` 推送 `v*` tag，GitHub Actions 会自动 `npm publish`（见 `.github/workflows/publish.yml`）。

## 四、poi 用户如何安装

- poi → 插件抽屉 → 设置（齿轮）→ 安装插件 → 输入包名 `poi-plugin-nangua-liuchuan` → 安装
- 或直接对 poi 说：poi 会自动从 npm registry 拉取
- 安装后启用「南瓜留船」即可

## 注意事项

- 包名一旦发布就不能再改（别人可能已安装），改名只能重新发布新包。
- 版本号不能重复；`npm publish` 同一版本会报错，需要先 `npm version patch`。
- `package.json` 的 `poiPlugin.title` 为显示名「南瓜留船」，包名保持英文前缀 `poi-plugin-`。
