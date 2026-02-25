# Learn Claude Agents - Node.js Implementation

Node.js/TypeScript 版本的 Claude AI 代码智能体实现。

## 安装

```bash
npm install
```

## 配置

创建 `.env` 文件：

```bash
ANTHROPIC_API_KEY=your_api_key_here
MODEL_ID=claude-sonnet-4-20250514
# ANTHROPIC_BASE_URL=https://api.anthropic.com  # 可选
```

## 构建

```bash
npm run build
```

## 运行示例

```bash
npm run s01  # Agent Loop
npm run s02  # Tool Use
npm run s03  # Todo Write
npm run s04  # Subagent
npm run s05  # Skill Loading
npm run s06  # Context Compact
npm run s07  # Task System
npm run s08  # Background Tasks
npm run s09  # Agent Teams
npm run s10  # Team Protocols
npm run s11  # Autonomous Agents
npm run s12  # Worktree Task Isolation
```

## 文件说明

- `s01_agent_loop.ts` - 基本的智能体循环
- `s02_tool_use.ts` - 工具使用和调度
- `s03_todo_write.ts` - 待办事项管理
- `s04_subagent.ts` - 子智能体模式
- `s05_skill_loading.ts` - 技能加载系统
- `s06_context_compact.ts` - 上下文压缩
- `s07_task_system.ts` - 任务系统
- `s08_background_tasks.ts` - 后台任务
- `s09_agent_teams.ts` - 智能体团队
- `s10_team_protocols.ts` - 团队协议
- `s11_autonomous_agents.ts` - 自主智能体
- `s12_worktree_task_isolation.ts` - 工作树任务隔离
