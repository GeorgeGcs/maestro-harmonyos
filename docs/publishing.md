# 远端建仓与活动启动

## 仓库信息

| 字段 | 值 |
| --- | --- |
| 所属组织 | HarmonyPandaWorkshop（沿用现有工作区组织） |
| 仓库名称/路径 | maestro-harmonyos |
| 类型 | 代码仓库 |
| 可见性 | 公开 |
| 默认分支 | main |
| 许可证 | Apache-2.0（本地已经提供） |
| 简介 | Maestro 的 HarmonyOS UI 自动化测试适配：鸿蒙驱动、标准 YAML/Flow、录屏与 VSCode 录制辅助。课题 11，初始化阶段。 |

远端状态：**已创建，启动材料已推送至 `main`**。

- [公开仓库](https://gitcode.com/HarmonyPandaWorkshop/maestro-harmonyos)
- HTTPS 克隆地址：`https://gitcode.com/HarmonyPandaWorkshop/maestro-harmonyos.git`
- SSH 地址：`git@gitcode.com:HarmonyPandaWorkshop/maestro-harmonyos.git`

2026-10-28：组织管理员创建空仓并提供地址后，已通过 SSH 确认远端无已有引用，普通推送初始化提交 `31b00fe` 至 `main`，包含 19 个文件。未使用强制推送。本地 `main` 已设置跟踪 `origin/main`；发布状态随后随文档提交同步。

目前使用既有 SSH 配置推送。尚无供 GitCode/AtomGit API 使用的已保存登录，成员权限管理需在网页或已授权 API 中进行。

## 推送

后续可通过现有 SSH 配置推送。若远端新增其他提交，先取回并核对，不强制覆盖：

```powershell
git remote -v
git ls-remote origin
git push -u origin main
```

如活动要求个人空间或使用其他路径，先核对真实地址再修改 origin。

## 报名成功后

- 在活动组确认报名成功后的 3 个自然日内完成远端仓库、技术方案及里程碑提交。
- 按活动组确认的账号配置招募小助手管理员权限；不要凭昵称猜测账号。本次初始化未授予任何外部账号权限。
- 将真实可访问的仓库链接反馈给活动组。
- 报名、代码交付、验收及激励账号按活动要求保持一致；组织仓仍须明确个人报名者身份。
- 按 [里程碑](milestones.md) 持续记录开发进展。
