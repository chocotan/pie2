# pie2

基于 **pi-durable 1.4.0** 的插件化 coding agent CLI。默认提供 Goal、Todo、Subagent、后台命令、Skill、文件搜索与图片读取、人工提问、Plan Mode、Web Search、Workflow 和 Ralph；编码工具为 `read` / `write` / `edit` / `bash`。这些能力由 pie2 原生插件实现，借鉴 Pi 与 DSH 的架构和功能，不引入 DSH/Cordis 插件库。

需要 Node.js **22.19+**，推荐 Node.js 24。文件搜索还需要系统安装 [ripgrep](https://github.com/BurntSushi/ripgrep)，确保 `rg` 在 `PATH` 中；Web Search 需要网络连接。

```bash
npm ci
npm run install:global
mkdir -p ~/.pie2
cp -n examples/config/config.json ~/.pie2/
```

编辑 `~/.pie2/config.json`，把示例的接口地址、模型 ID 和 API key 换成你的服务配置，并在同一个文件中设置默认 provider/model。示例使用 `https://api.example.com/v1` 和 `your-model` 占位，不能直接请求真实服务。

```bash
pie2
```

`npm run install:global` 安装本机 `pie2` 命令；也可在源码目录使用 `npm start`。模型配置只需设置一次，后续直接 `pie2`。未创建配置文件时，仍默认使用内置 DeepSeek `deepseek-flash`，可通过 `DEEPSEEK_API_KEY` 提供凭证。

默认每次启动都新建独立会话，不自动复用历史。使用 `pie2 --resume` 选择旧会话，或 `pie2 --continue` 恢复当前工作目录最近的会话。

```bash
# 单次执行，只输出最终答案
node bin/pie2.mjs -p '检查当前仓库并说明如何运行测试'

# 从标准输入读取任务
printf '解释 package.json 中的脚本' | node bin/pie2.mjs -p

# OpenAI / Anthropic
node bin/pie2.mjs --provider openai --model gpt-4.1
node bin/pie2.mjs --provider anthropic --model claude-sonnet-4-5

# 任意 OpenAI Chat Completions 兼容接口
PIE2_API_KEY='你的 key' node bin/pie2.mjs \
  --provider custom --model your-model --base-url https://example.com/v1

# JSONL 事件流，适合上层程序接入
node bin/pie2.mjs --json '列出项目主要模块'

# 在其他工作目录运行
pie2 --cwd /path/to/project

# 交互选择历史会话 / 恢复最近会话后单次执行
pie2 -r
pie2 -c -p '继续检查未完成的任务'

# 显式恢复或创建指定数据库
pie2 --session /path/to/session.sqlite
```

## 安装本机命令

在源码目录安装依赖后执行：

```bash
npm run install:global

# 选择可写的安装目录，无需 sudo
npm run install:global -- --prefix "$HOME/.local"

# 已有 pie2 命令时，也可直接执行
pie2 install
pie2 install --prefix "$HOME/.local"
```

默认使用 `npm prefix --global` 对应的目录；Linux/macOS 命令位于 `<prefix>/bin/pie2`。安装器不会自动执行 sudo、修改 shell 配置或覆盖无关命令。若命令目录不在 `PATH`，会提示应添加的路径，例如在自己的 shell 配置中加入 `export PATH="$HOME/.local/bin:$PATH"`。重复安装同一份代码可以直接运行；目标已属于另一份安装时会拒绝覆盖。

**安装方式是链接当前安装目录**，不会复制一份独立源码；请保留该目录和依赖，不要在安装后移动或删除它。安装命令不改模型配置或凭证。需要分发包时可执行 `npm pack`，会自动构建并打包 JavaScript `dist/`，不依赖在 `node_modules` 中直接执行 TypeScript；这不会发布到 npm registry。

## ACP 接入

支持 **Agent Client Protocol 稳定 v1**，使用官方 SDK，通过标准输入/输出交换逐行 JSON-RPC。ACP 与终端模式复用模型配置、原生插件、持久化会话和取消机制：

```bash
pie2 acp

# 等价入口；启动时也可指定模型和插件
pie2 --acp --cwd /path/to/project --provider custom --model your-model
```

这是供 ACP 客户端启动的子进程，不是交互终端或 HTTP 服务。标准输出只用于协议，诊断写入标准错误；客户端须保持 stdin 连接，关闭连接会清理运行中的工作。`--json` 则是 pie2 原生事件流，与 ACP 不同，不能混用。

接入支持自定义 ACP agent 的客户端时，设置可执行命令为 `pie2`、参数为 `["acp"]`；具体配置文件结构以该客户端文档为准。客户端进程的 `PATH` 必须能找到 `pie2`，否则使用安装后命令的绝对路径。

使用本机已安装的 [acpx](https://www.npmjs.com/package/acpx) 可直接连接：

```bash
# 单次执行；此选项会自动批准全部工具权限
acpx --cwd /path/to/project --agent 'pie2 acp' --approve-all exec '检查仓库并说明如何运行测试'

# 持久会话：创建后继续对话
acpx --cwd /path/to/project --agent 'pie2 acp' sessions new
acpx --cwd /path/to/project --agent 'pie2 acp' '说明项目结构'

# 显式切换只读规划 / 实施模式
acpx --cwd /path/to/project --agent 'pie2 acp' set-mode plan
acpx --cwd /path/to/project --agent 'pie2 acp' set-mode build
```

不希望自动放行全部工具时，去掉 `--approve-all`，由客户端的权限策略决定。工具运行前会发送 `session/request_permission`；拒绝或取消不会放行，`allow_always` 只记住当前会话内的同名工具，子代理与嵌套调用也经过权限检查。Plan Mode 自身的只读限制不会被工具权限批准绕过。

已接通的协议能力：

- `initialize`：协商能力，不打开数据库，也不读取模型凭证或发模型请求。模型配置在创建或加载会话时读取，沿用全局与项目的 `config.json`；不提供 OAuth 登录，`authMethods` 为空。
- 会话新建、按 opaque session ID 加载并回放历史、按工作目录列出、关闭。新建始终产生独立会话；加载时校验所属工作目录。
- Prompt、取消、流式回答与 thinking、工具调用状态及结果、Todo 计划更新。Thinking 取决于模型是否返回可见推理内容。
- `build` / `plan` 模式，以及 `model`、`thinking`、`mode` 的 `configOptions`；禁用相关插件时不提供对应选项。运行中的会话须先取消或等待当前 prompt 完成，再切换设置。
- 文本、嵌入文本资源和资源链接；图片需当前模型支持，资源链接仅传递引用信息，不自动抓取内容。

`ask_user_question` 与计划审批使用标准 `elicitation/create` 表单，需要客户端声明 `clientCapabilities.elicitation.form`。**acpx 0.12 尚不支持该表单**：此时会明确报不支持，不会自动回答或批准计划，也不会拿普通工具权限批准代替计划审批。用户可通过 `set-mode build` 显式退出规划。

ACP 会话生命周期由客户端管理，因此不能同时传入普通 prompt、`-p`、`--json`、`--session`、`--resume`、`--continue` 或 `--list-models`。目前不支持 MCP servers、额外工作目录、客户端自定义 system prompt、音频与二进制嵌入资源；这些请求会被明确拒绝。

## 模型配置

统一使用 **`config.json`**，在同一个文件中配置默认 provider/model、thinking level、接口、密钥和模型参数。

- 全局配置：`~/.pie2/config.json`
- 项目配置：`<工作目录>/.pie2/config.json`

`--cwd` 决定项目配置的位置；`PIE2_CONFIG_DIR` 可替换全局配置目录。CLI 不会自动创建或改写配置。配置在启动时读取，修改后需重启。

示例（可从 [examples/config/config.json](examples/config/config.json) 复制）：

```json
{
  "defaultProvider": "custom",
  "defaultModel": "your-model",
  "providers": {
    "custom": {
      "name": "My API",
      "baseUrl": "https://api.example.com/v1",
      "api": "openai-completions",
      "apiKey": "your-api-key",
      "models": [
        {
          "id": "your-model",
          "name": "My Model",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 8192
        }
      ]
    }
  }
}
```

`api` 支持 `openai-completions`、`openai-responses` 和 `anthropic-messages`。`apiKey` 可以直接填真实密钥，也可以用 `$API_KEY` 或 `${API_KEY}` 引用环境变量；`headers` 的值同样支持引用。字面量 `$` 和开头的 `!` 分别用 `$$` 和 `$!` 转义。不支持 Pi 的 `!shell` 命令取值、`auth.json` 或 OAuth 登录；请勿提交含真实凭证的配置。

已有内置 provider（`deepseek`、`openai`、`anthropic`）也可通过同名条目覆盖 `baseUrl`、`apiKey` 或 `headers`，无需重写模型列表。`models` 可添加或覆盖模型；`modelOverrides` 可按模型 ID 局部覆盖内置参数，例如 `{"modelOverrides":{"gpt-4.1":{"maxTokens":8192}}}`。模型可配置 `reasoning`、`input`、`contextWindow`、`maxTokens`、`cost` 等字段；`cost` 的 `input`、`output`、`cacheRead`、`cacheWrite` 按每百万 token 的美元价格填写。不填价格的自定义模型按零处理。

项目配置覆盖全局配置；provider 按名称合并，模型按 ID 合并，未覆盖的模型保留。默认 provider/model 的选择优先级为：**命令行参数 > `PIE2_PROVIDER` / `PIE2_MODEL` > 项目配置 > 全局配置 > 内置默认值**。显式切换 provider 时，不会沿用其他 provider 的默认模型。`--base-url` > `PIE2_BASE_URL` > `config.json` 中的接口地址，且前两种方式使用 OpenAI Chat Completions 协议。

可选 `defaultThinkingLevel` 设置新会话的默认思考强度；支持的值取决于模型，不支持推理的模型只支持 `off`。会话中的模型和 thinking level 会持久化，恢复时保留；配置默认值用于新会话，显式 `--provider` / `--model` 可覆盖恢复的模型选择。省略 `apiKey` 时，自定义 provider 使用 `PIE2_API_KEY` 或 `<PROVIDER>_API_KEY`（provider 名大写，连字符转下划线）；内置 provider 仍支持 `DEEPSEEK_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`。已配置的 `apiKey` 优先于环境变量兜底。

可选 `webSearch` 在同一个 `config.json` 配置搜索接口和超时；全局与项目配置按字段合并，项目值优先：

```json
{
  "webSearch": {
    "timeoutMs": 15000
  }
}
```

默认访问 DuckDuckGo HTML，无需 API key。可选 `endpoint` 必须是无内嵌用户名/密码的 HTTP(S) URL，支持 `$ENV` / `${ENV}` 环境变量引用。接口接收 `q` 查询参数，响应必须兼容 DuckDuckGo HTML/lite 页面，不能直接填任意 JSON 搜索 API。`timeoutMs` 范围为 1–120000 毫秒。该插件不提供 `web_fetch`。

```bash
# 查看可用模型；不发模型请求、不创建会话，不输出凭证
node bin/pie2.mjs --list-models

# 配置保留，临时切换本次运行的 provider/model
node bin/pie2.mjs --provider openai --model gpt-4.1
```

## 交互与会话

交互界面使用原生 `pi-tui`，保留纯文本极简风格。输入 `/` 显示命令补全；模型和 thinking 可通过选择器或命令参数切换：

```text
/model
/model custom/your-model
/thinking
/thinking high
```

`/model <id>` 也支持唯一的模型 ID；同名模型需写完整的 `provider/id`。`/thinking` 只列出当前模型支持的级别，传入不支持的值会报错。切换到不支持推理的模型时，thinking 自动调整为 `off`。模型返回的 thinking 正文单独显示为淡色 `Thinking` 区块：生成时展开，回复完成后收起为摘要，可点击或用 Ctrl+O 再展开。恢复历史和流式恢复也保留思考内容；模型未公开的推理或加密签名不会显示。

| 操作 | 用法 |
| --- | --- |
| 循环切换可用模型 | Ctrl+P |
| 循环切换当前模型支持的 thinking level | Shift+Tab |
| 展开或折叠工具详情 | 鼠标点击工具行 |
| 展开或折叠全部工具详情与 thinking | Ctrl+O |
| 展开或收起活动面板 | 点击活动概览行 / Ctrl+T |
| 查看聊天历史 | 鼠标滚轮、右侧滚动条或 PageUp/PageDown |
| 滚动展开的详情 | 在详情内滚动鼠标滚轮 |
| 键盘滚动详情 | 点击详情后使用 ↑↓、PageUp/PageDown、Home/End |
| 返回输入框 | 详情聚焦时按 Esc 或 Enter |
| 中断前台，后台继续 | Esc / Ctrl+C / `/abort` |
| 中断全部前台和后台工作 | `/abort all` |
| 输入为空时退出 | Ctrl+D |

聊天记录从输入框上方开始，内容增多时向上累积，右侧显示滚动条；向上阅读历史时，新消息不会把视口强制拉回底部。

输入框上方常驻活动概览，显示 **Todo 已完成/总数、Goal 阶段与轮次、Agent 和 Job 的活动数/总数，以及活动的 Plan、Workflow、Ralph 状态**。点击概览或按 **Ctrl+T** 展开列表，查看 Todo、目标与阻塞原因、子代理 ID/状态/排队消息、后台命令 ID/状态/退出码、计划模式与编排进度。列表限高、可用滚轮和键盘翻页，Esc 或 Enter 收起；输入草稿始终保留。状态直接从原生持久化数据投影，后台提交和空闲时的目标变更也会刷新，不需要发送新消息。

后台 Bash 启动行显示为 `Job #ID · 描述 [已启动]`，日志和停止调用分别显示 `Job #ID · 日志`、`Job #ID · 停止`；内部启动步骤合并到该调用行。`已启动` 表示命令已交给后台运行，任务的最终状态由完成通知和活动面板展示。

工具和 Skill 调用显示参数或描述，以及运行、完成、失败、中断状态；展开后查看详细参数与结果。详情最多显示 **10 行**，长内容在区域内部滚动，到顶/底不会带动外层会话滚动。收起后重新展开从顶部开始。鼠标点击需要终端支持鼠标事件。连续回答不显示 `Assistant` 标题，也不重复插入大段空白。运行中可继续输入，请求会作为 steering 在工具轮次边界交付。

底栏和活动投影由独立的 `statusBar` 插件提供，底栏显示当前模型/thinking、运行状态、短会话 ID、输入/输出 tokens、缓存命中率，以及有数据时的近似上下文占用；宽度允许时还显示目录和 Git 分支。`/status` 查看完整会话信息，`--disable-plugin statusBar` 可禁用此插件。上下文百分比以 `~` 标记，依据最近完成请求的 usage 估计，不等同于累计输入 tokens，也不包含该请求之后新增的工具输出。

会话保存在 `~/.pie2/sessions/<workspace-hash>/<time_uuid>.sqlite`，包含历史、Goal、Tasks 和模型选择等状态。新建会话不会删除旧会话：

- `pie2`：每次新建独立会话。
- `-r` / `--resume`：启动历史会话选择器，仅交互终端可用。
- `-c` / `--continue`：恢复当前工作目录最近的会话，也可配合 `-p` 使用。
- `--session <path>`：恢复指定 SQLite 会话；路径不存在时创建。
- `/resume [id]`：交互中选择历史会话，或按 ID 恢复。
- `/new`：交互中开始新会话。

`--session`、`--resume` 和 `--continue` 不能同时使用。

## 第一版能力

| 插件名（`--disable-plugin` 使用此名） | 模型工具 | 用户命令 |
| --- | --- | --- |
| `goal` | `get_goal`、`create_goal`、`update_goal` | `/goal [<目标>\|edit <目标>\|pause\|resume\|clear]` |
| `tasks` | `todo_write` | `/tasks`（只读） |
| `subagent` | `subagent`、`send_message`、`interrupt_agent` | `/agents [list]`、`/agents get <id>`、`/agents send <id> <消息>`、`/agents stop <id>` |
| `background` | `bash`（后台模式）、`job_list`、`job_output`、`job_kill` | `/jobs [list]`、`/jobs get <id>`、`/jobs output <id>`、`/jobs stop <id>` |
| `skills` | `Skill` | `/skills`、`/skill <name> [请求]`、`/skill:name [请求]` |
| `coding` | `read`、`write`、`edit`、`bash` | 加载工作目录及上级的 `AGENTS.md`，到 Git 根目录为止 |
| `files` | `read_image`、`glob`、`grep` | — |
| `askUser` | `ask_user_question` | — |
| `plan` | `enter_plan_mode`、`exit_plan_mode` | `/plan [on\|off\|status]` |
| `web` | `web_search` | — |
| `workflow` | `workflow` | `/workflows [list\|get <run-id>]` |
| `ralph` | `ralph` | `/ralph [status\|list\|get <run-id>]` |
| `models` | — | `/model`、`/thinking` |
| `statusBar` | — | `/status`，底栏与活动面板 |

以上插件默认加载，`/plugins` 查看实际启用列表；例如 `--disable-plugin web --disable-plugin ralph` 可分别关闭。

通用命令：`/help`、`/status`、`/plugins`、`/history`、`/model`、`/thinking`、`/resume [id]`、`/new`、`/abort [all]`、`/exit`。Esc、Ctrl+C 或 `/abort` 只中断前台工作并暂停活动 Goal；前台子代理一并取消，后台子代理和命令任务继续。`/abort all` 才中断全部工作。

### 默认使用策略

四类插件分别向模型提供工具描述和系统策略，运行时负责通知、续轮与取消；是否调用工具仍由模型判断：

- **Tasks**：多步骤工作开始前写清单，进行中及时更新，完成一项立即标记；简单单步任务跳过。真正并行的工作可同时有多个 `in_progress`。
- **Subagent**：独立工作默认后台委派，并行启动后继续自己的工作；只有下一步依赖结果时才显式等待。提示词必须独立完整，避免重复劳动和重叠文件编辑。
- **Background**：长时间且独立的命令放后台，记录 ID；自动接收完成通知，不忙轮询或 sleep。最终答复前读取相关结果，停止不再需要的任务。
- **Goal**：从用户直接提出的长期完成目标推断创建意图，不要求用户使用特定措辞；普通问答或单轮工作不创建。完成前验证整个目标，具体阻碍持续存在时才报告 blocked。

### Goal

用 `/goal <目标>` 开始需要持续推进的目标：

```text
/goal 修复登录问题，补测试并验证
/goal
/goal edit 修复登录与退出登录问题，补测试并验证
/goal pause
/goal resume
/goal clear
```

`/goal` 查看目标 ID、revision、状态、已启动的自动轮数、轮次上限及 `armed` / `disarmed` 激活状态。状态为 `active`、`paused`、`blocked` 或 `complete`。`/goal pause` 停止后续自动轮次，当前执行继续；`/abort` 同时中断前台，后台仍继续。

模型通过 `create_goal({"objective":"…","max_goal_rounds":256})` 创建目标，`max_goal_rounds` 可省略，默认 **256 个自动继续轮次**。通过 `get_goal({})` 取得当前 `goal.id` 和 `goal.revision`，再原样传入更新：

```text
update_goal({"goal_id":"<get_goal 返回的 goal.id>","revision":1,"action":"pause"})
```

每次更新校验 ID/revision，拒绝过期写入；成功后 revision 增加。`action` 支持 `edit`、`pause`、`resume`、`complete`、`blocked`。只有 `edit` 可带 `objective` 和/或 `max_goal_rounds`；`blocked` 必须带具体的 `blocked_reason`。

创建、编辑、暂停和恢复必须来自顶层用户的直接输入轮；子代理不能修改 Goal，后台通知不能创建目标或重新激活目标。`complete` 和 `blocked` 也允许由匹配当前目标 ID/revision 的自动目标轮调用。模型自主报告 blocked 至少需要已进入 3 个自动目标轮；策略还要求同一具体阻碍连续存在至少 3 轮，不能把困难、不确定性或仍有可做的工作当成阻塞。

Goal 通过原生 `GenerationTask.onYield` 在模型交回答案时继续。达到上限后变为 `blocked`；`resume` **不会重置或续订轮次预算**，须在用户直接输入轮中先 `edit` 提高 `max_goal_rounds`，再恢复。自动轮数不是工具调用总数或所有模型请求数。

Goal 不与 Todo、Job 或子代理建立硬性完成门槛；模型应先收集、验证相关结果再标记完成。状态随会话持久化，但恢复或 fork 后自动继续默认 `disarmed`；恢复旧会话后用 `/goal resume`，或直接告诉模型“继续目标”，由模型调用 `update_goal` 的 `resume` 重新激活。恢复已接纳的 durable 工作与重新激活 Goal 是两件事。

### Tasks / Todo

任务是当前输入轮的**整表清单**，只提供 `todo_write`，每次提交完整列表替换旧列表：

```json
{
  "todos": [
    { "content": "实现接口", "status": "completed" },
    { "content": "补集成测试", "status": "in_progress" },
    { "content": "运行验证", "status": "pending" }
  ]
}
```

状态仅有 `pending`、`in_progress`、`completed`。不提供任务 ID、owner、依赖图、单条 CRUD 或自动调度。`/tasks` 只查看清单。新输入轮开始时清空当前清单投影，同一输入轮内跨多个模型步骤保留；Todo 不是跨请求长期计划，长期目标使用 Goal。

### Subagent

模型调用 `subagent` 示例：

```json
{
  "description": "检查认证模块",
  "prompt": "在当前仓库检查认证模块的权限边界，返回具体问题、证据和文件路径。不要修改文件。"
}
```

`description` 和 `prompt` 必填。省略 `run_in_background` 时默认后台，立即返回 `{"kind":"continuable","subagentId":"…"}`，父代理继续工作；只有显式传 `"run_in_background": false` 才等待结果。后台执行结束后自动回传结果；界面显示可折叠的通知行，不作为新的 `You` 消息显示。

子代理使用独立上下文，**看不到父会话对话**，提示词必须包含完整任务信息。它继承创建时的模型、thinking、工作目录、工具和技能，可继续委派，绝对最大委派深度为 **3**；不能管理 Goal。父子代理之间没有 Todo 认领或状态联动。创建收据和固定 requestId 避免恢复时重复创建子会话或重复投递结果。

后台子代理保留身份和上下文。将返回的 `subagentId` 字符串用于后续工具：

- `send_message({"subagent_id":"42","message":"再检查会话过期边界，并补充结论"})`：立即返回 `messageId` 确认接收，不返回回答；忙时排队，当前轮之后按顺序处理。
- `interrupt_agent({"agent_id":"42"})`：立即返回 `{"accepted":true}`，仅请求中断当前轮；排队消息保留并停放，之后新的 `send_message` 会唤醒队列。已结束的子代理中断为成功的空操作。已发布的后台后代继续运行。

代理可控制自己的直接子代理和更深的后代；汇总前应收集、验证后代结果。人工查询和管理使用交互命令（将 `42` 换成实际 ID）：

```text
/agents list
/agents get 42
/agents send 42 再检查会话过期边界，并补充结论
/agents stop 42
```

后台运行依赖当前 CLI 进程，不是常驻 daemon。退出、切换会话或 `-p` 单次执行结束会关闭当前 harness；后台子代理的上下文和执行进度保留，显式恢复原会话后可继续。

### 后台命令任务

独立 shell 工作使用 Background 插件，与可继续对话的子代理分开管理。通过 `bash` 启动后台命令，再用 Job 工具管理：

```text
bash({"command":"npm test","description":"运行项目测试并收集验证结果","run_in_background":true})
job_list({})
job_output({"job_id":"17"})
job_output({"job_id":"17","wait":true,"timeout_ms":30000})
job_kill({"job_id":"17","reason":"已不再需要该结果"})
```

`bash` 的 `command`、`description` 必填。`run_in_background` 默认 `false`；前台可用 `timeoutMs` 设置毫秒超时，`workdir` 指定工作目录，后台命令**不设执行超时**。后台立即返回 `{"kind":"background","jobId":"…"}`，后续工具的 `job_id` 使用该字符串。前台结果带 `[exit code: N]`，模型应检查非零退出码。

`job_list` 列出运行中和已结束的命令。`job_output` 默认非阻塞，**按读取游标只返回新增输出**，每次结果以 `[status: …]` 结束；日志最多保留最近 **50 KiB**，未读输出被丢弃时标记截断。`wait: true` 等待结束，`timeout_ms` 默认 30,000，最大 600,000 毫秒；等待超时或取消等待都不会杀掉命令。

```text
/jobs list
/jobs get 17
/jobs output 17
/jobs stop 17
```

完成或失败后自动发送可折叠的 Job 通知。父代理空闲时自动唤醒处理结果，当前用户输入后的连续自动唤醒预算为 **3 次**；父代理忙或预算用尽时被动注入通知，避免无界续跑。`job_kill` 或 `/jobs stop` 只请求停止并立即返回，进程树实际结束后才成为 `killed`；显式停止不额外唤醒父代理。

后台 shell 进程不能跨 CLI 退出或会话切换存活，`-p` 结束也一样。恢复旧会话时，先前已启动但未完成的命令标记为 `interrupted`，**绝不自动重跑**，避免重复副作用；需要重试时由用户或模型明确重新启动。

### 文件搜索与图片

`files` 插件提供独立的只读工具，参数示例：

```text
read_image({"path":"screenshots/error.png"})
glob({"pattern":"**/*.test.ts","path":"src","limit":100,"timeoutMs":10000})
grep({"pattern":"TODO","path":"src","include":"*.ts","fixed":true,"ignoreCase":false,"mode":"content","limit":100,"timeoutMs":10000})
```

相对路径以会话工作目录为基准。`glob` 只返回文件，`grep` 的 `mode` 为 `content`（默认，含行号）或 `files`（仅文件路径）。搜索调用系统 `rg`，遵循其忽略规则、隐藏文件规则并跳过二进制；显式 glob 可包含匹配的隐藏文件。默认最多 100 项、10 秒，最高 1000 项、120 秒；结果同时受输出大小限制，`truncated` 表示应缩小范围重搜。无匹配、非法正则、超时和工具缺失分别处理，不把错误当空结果。

`read_image` 根据内容接受 PNG/JPEG/GIF/WebP，复用 `read` 的图片大小限制和模型兼容性诊断，拒绝文本及不支持的图片。图片作为真实附件传给模型，终端只显示占位信息；所选模型需支持图片输入。局部文件编辑仍使用 `edit`，新建或整文件替换使用 `write`。

### 人工提问

`askUser` 插件提供 `ask_user_question`，用于必须由用户决定的选项、审批和无法从工作区获得的信息：

```json
{
  "questions": [
    {
      "id": "scope",
      "header": "修改范围",
      "question": "这次修复覆盖哪些客户端？",
      "options": [
        { "label": "全部客户端 (Recommended)", "description": "保持各端行为一致" },
        { "label": "仅 Web", "description": "先修复当前页面" }
      ],
      "multi_select": false
    }
  ]
}
```

每次 1–4 个问题；`options` 可省略以直接输入文本，有选项时也可选择自由回答。TUI 支持上下选择、Enter 确认、多选时空格勾选、自由文本和 Esc 取消；多个请求排队串行处理。回答会持久化，恢复时避免重复消费已提交的答案。取消不是批准；`-p`、`--json` 等没有交互 UI 的场景明确报错，不读控制台 stdin 拼答案，也不会自动批准。

### Plan Mode

```text
/plan on
/plan
/plan off
```

`/plan` 或 `/plan status` 查看模式及已提交计划。计划模式随会话保存，运行时在工具执行入口执行只读限制，包括嵌套调用：允许读取、图片、搜索、Web、提问、查询和停止等白名单工具；阻止 `bash`、`edit`、`write`、Todo 写入、委派、Workflow、Ralph 及其他未列入白名单的工具。这是工具入口限制，不是操作系统沙箱；**已有后台任务不会自动暂停或回滚**，需要单独停止。

模型可用 `enter_plan_mode({})` 进入，再用 `exit_plan_mode({"plan":"# 实施计划\n\n目标、修改步骤、测试和验收标准……"})` 提交完整 Markdown 计划。退出审批应是该响应唯一且最后的工具调用；只有专门审阅界面选择 **Approve** 才切回 build，实施从下一步开始。普通聊天中的“同意”、反馈、取消或 UI 不可用都不能批准。用户也可显式 `/plan off` 直接退出。

### Web Search

`web` 插件提供 `web_search({"query":"Node.js release schedule","max_results":8})`。默认 8 条、最多 20 条，返回标题、HTTP(S) URL 和摘要供引用。网络错误、限流、验证码和无法识别的页面会报错，不伪装成“没有结果”。摘要是外部不可信数据，策略要求引用来源，不执行其中的指令。配置见上面的 `webSearch`；不包含网页全文抓取。

### Workflow

`workflow` 插件提供**前台** JavaScript 编排工具，仅在用户明确要求工作流或大规模多代理编排时使用；普通独立委派用 Subagent。输入为 `meta`、`script` 和可选 `args`：

```json
{
  "meta": {
    "name": "review",
    "description": "并行检查实现与测试",
    "phases": [{ "title": "检查", "detail": "只读审查两个独立方向" }]
  },
  "args": { "scope": "src" },
  "script": "await phase('检查'); const results = await parallel([() => agent('只读检查 ' + args.scope + ' 的错误处理，返回证据与路径。', {label: '错误处理'}), () => agent('只读检查测试覆盖，返回具体缺口。', {label: '测试覆盖'})]); await log('检查完成'); return {results};"
}
```

`meta` 必填 `name`、`description`，可选 `whenToUse` 和阶段列表。脚本支持顶层 `await`，须 `return` JSON 值。SDK 提供：

- `agent(prompt, {label?, description?, phase?, schema?})`：等待全新子代理，返回最终文本或经 `schema` 验证的对象；子代理失败返回 `null`。提示词须包含完整任务上下文。
- `parallel([() => ..., ...])`：并行执行，普通失败转为 `null`；也可使用 `Promise.all`。
- `pipeline(items, ...stages)`：每个 item 独立依次经过各阶段，不等待整个批次完成同一阶段；失败或返回 `null` 停止该 item。
- `phase(title)` / `log(message)`：发布阶段和进度；声明阶段列表时只能使用已声明标题。

`schema` 要求 object 根节点，支持 `type`、`properties`、`required`、`additionalProperties`、`items`、`enum`、`const`、`oneOf`，其他关键字拒绝。SDK 返回 Promise，必须正确等待；安全上限和无效 SDK 参数会终止运行。

脚本在独立 QuickJS worker 中执行，不能访问 Node、文件系统、网络或任意工具；**其委派的子代理是真实代理，可以通过工具修改共享工作区**。默认最多并发 4 个、累计 128 个子代理、5 分钟、JSON 结果 50000 字符。这些是部署端引擎限制，不是 `config.json` 设置。执行复用 pi-durable codemode 日志与嵌套 ToolTask，恢复时重放已记录结果，取消时停止归属该运行的前台子代理；失败保留部分结果。

`/workflows list` 列出运行，`/workflows get <run-id>` 查看阶段、日志、子代理及部分结果；活动面板也显示编排状态。

### Ralph

`ralph` 插件用于用户明确要求的**全新上下文迭代**，与同一会话自动续轮的 Goal 分开：

```text
ralph({"objective":"修复解析器边界问题，补测试并验证","maxRounds":8})
/ralph status
/ralph list
/ralph get 42
```

`objective` 在运行中不可变，`maxRounds` 可省略（默认 64，部署上限 256）。每轮创建干净子代理，仅共享工作区文件和最多 16384 字符的结构化交接报告，不继承父会话或上一子代理的对话。循环由部署端脚本驱动，复用 Workflow 引擎，前台运行，总超时默认 1 小时；取消会停止当前子代理。

每轮必须返回完整 JSON 对象，字段为 `status`（`continue` / `complete` / `blocked`）、`summary`、`evidence`（字符串数组）、`nextSteps`（字符串数组）、`blocker`。`continue` 必须有下一步且无 blocker；`complete` 必须有证据、无下一步和 blocker；`blocked` 必须有具体 blocker。所有字符串和交接大小都会校验，不以 `DONE` 等魔法文本判定完成。

运行在完成报告、具体阻塞、轮次失败或预算耗尽时停止；完成是工作代理提交的报告，不能代替独立验证。轮次回执和原生脚本日志避免恢复时重跑已完成轮次。`/ralph` 默认查看最近一次，活动面板显示轮次进度。

### Skill

发现顺序如下，重名时前面的优先：

1. 项目 `.agents/skills/`
2. 项目 `.pi/skills/`
3. `--skill-dir <目录>`，可重复传入
4. `~/.agents/skills/`
5. `~/.pi/agent/skills/`

目录下递归发现 `SKILL.md`，支持符号链接并防止循环。每份文件最大 256 KiB。文件采用标准 YAML frontmatter：

```markdown
---
name: check-change
description: Review a local patch and run focused checks.
---

Read the diff and relevant callers before making recommendations.
Run the project's existing verification commands.
```

系统提示只包含名称、描述和路径，正文通过 `Skill` 工具按需读取，或通过 `/skill:check-change 请求` 显式注入。`disable-model-invocation: true` 会隐藏自动调用入口，但保留用户显式调用。正文中相对路径以技能所在目录为基准。Skill 插件只读取指令，不直接执行附带脚本；模型后续可以通过编码工具执行指令。

```bash
node bin/pie2.mjs --skill-dir ./examples/skills
# /skills
# /skill:check-change 检查当前改动
```

新增技能目录或修改 metadata 后重启 CLI；已发现技能的正文在调用时重新读取。

## 插件开发

Host 只负责打开 SQLite、装配 registry、分发命令和显示结果。功能使用 pi-durable 的原生 extension、tool、section、hook 和 document 实现。状态通过 durable commit 写入；可重放的写工具使用 task receipt 避免重复副作用。

```text
CLI → Host → pi-durable Harness → SQLite
             ├─ coding / files
             ├─ askUser / plan / web
             ├─ workflow / ralph
             ├─ goal
             ├─ tasks
             ├─ subagent
             ├─ background
             ├─ skills
             ├─ models
             └─ statusBar
```

插件默认导出 `Plugin`，或接收 `{ cwd }` 并返回 `Plugin` 的异步工厂，接口见 `src/plugin.ts`：

```ts
interface Plugin {
  name: string
  extension: Extension  // pi-durable 原生扩展
  commands?: Record<string, (args: string, ctx: CommandContext) => Promise<CommandResult>>
  interrupt?(ctx: CommandContext): Promise<void>
  afterInterrupt?(ctx: CommandContext): Promise<void>
}
```

命令返回 `{ output }` 显示文本，或 `{ prompt }` 交给模型。`ctx` 提供 `harness`、`conversation` 和 Chord `context`。名称冲突会在运行前报错。

```bash
node bin/pie2.mjs --plugin ./examples/hello-plugin.ts
# /hello Alice

node bin/pie2.mjs --disable-plugin goal --disable-plugin subagent
```

插件通过显式 `--plugin` 加载，运行权限与 CLI 相同。这是基于 pi-durable 的插件接口，未实现 pi-coding-agent 扩展或 DeepSeek Cordis 插件的兼容层。

## 验证

```bash
npm run check
npm test
```

测试使用 pi-ai faux provider、真实 durable 调度器、SQLite 临时会话和本地 HTTP 替身，无需 API key。覆盖目标 revision/权限/轮次预算、Todo 整表替换和输入轮投影、子代理隔离/队列/中断/后代管理、后台命令与增量输出、文件搜索与图片、人工提问和计划审批、Web 响应解析与错误、Workflow/Ralph 编排与恢复、技能发现及 CLI。

设计参考 pi-durable 官方示例、Pi 的 skill 渐进加载与终端交互，以及 DSH 的任务管理、后台委派、规划审批和编排思路；工具执行和持久化均使用 pie2 / pi-durable 原生实现。状态存于会话 Doc，生命周期由持久 Task 驱动，工具提供参数校验与入口，后台结果经消息来源标记（`pie2.coordinator-message` / `pie2.background-result`）投递给父会话；UI 与系统策略消费状态，回执 Doc 与 codemode 日志处理重放。Workflow/Ralph 使用直接声明的 `pi-codemode` 依赖，不加载 DSH/Cordis 包，也不承诺它们的脚本或插件全面兼容。

第一版未包含插件热重载或插件沙箱；Workflow 的脚本沙箱不隔离子代理的文件和进程权限。编码工具和后台命令直接使用当前用户权限，请在可信工作区运行。真实模型联调和外部搜索服务可用性不属于本地替身测试的覆盖范围。
