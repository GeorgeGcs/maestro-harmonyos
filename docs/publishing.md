# 远端建仓与活动启动

## 计划建仓信息

| 字段 | 值 |
| --- | --- |
| 所属组织 | HarmonyPandaWorkshop（沿用现有工作区组织） |
| 仓库名称/路径 | maestro-harmonyos |
| 类型 | 代码仓库 |
| 可见性 | 公开 |
| 默认分支 | main |
| 许可证 | Apache-2.0（本地已经提供） |
| 简介 | Maestro 的 HarmonyOS UI 自动化测试适配：鸿蒙驱动、标准 YAML/Flow、录屏与 VSCode 录制辅助。课题 11，初始化阶段。 |

远端创建状态：**待创建/核对，尚未发布**。本地仓库不等于已创建远端仓库。

2026-10-28：检查现有 API 登录，未找到供 GitCode/AtomGit API 使用的已保存凭据。通过现有 SSH 配置查询目标地址时，服务端返回项目不存在或不可访问；未推送代码。现有 PandaKit 仓库的 SSH 配置可作为后续推送方式，创建远端和管理成员仍需网页或已授权 API。

创建空仓时不勾选 README、许可证或 .gitignore 初始化，以便正常推送本仓的首批提交。若远端已经有内容，先取回并核对，不强制覆盖。

## 推送

远端确实创建在上述组织后，可通过现有 SSH 配置推送：

```powershell
git remote -v
git ls-remote origin
git push -u origin main
```

计划 SSH 地址：`git@gitcode.com:HarmonyPandaWorkshop/maestro-harmonyos.git`。如活动要求个人空间或使用其他路径，先核对真实地址再修改 origin。

## 报名成功后

- 在活动组确认报名成功后的 3 个自然日内完成远端仓库、技术方案及里程碑提交。
- 按活动组确认的账号配置招募小助手管理员权限；不要凭昵称猜测账号。本次初始化未授予任何外部账号权限。
- 将真实可访问的仓库链接反馈给活动组。
- 报名、代码交付、验收及激励账号按活动要求保持一致；组织仓仍须明确个人报名者身份。
- 按 [里程碑](milestones.md) 持续记录开发进展。
