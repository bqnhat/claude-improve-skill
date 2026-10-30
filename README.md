# /improve

`~/.claude` のスキル・エージェント・hook・rule を、実際の失敗と評価スコアにもとづいて改善する Claude Code 用スキルです。

原則は Anthropic の記事 [Building agents: When to fold subagents into your main agent loop](https://claude.com/ja/resources/articles/building-agents-when-to-fold-subagents-into-your-main-agent-loop) にある「測る、一度に一つだけ変える、効いたものだけ残す」です。

## できること

- **探す：** セッション履歴から、出力を手直しした箇所、ツールエラー、hook ブロック、`claude plugin validate` のエラー、`/skill-doctor` が示す使われていないスキル、1.0 未満の eval、最後の eval 後に変更されたスキルなどを集め、優先度順に並べます。ユーザーがチェックした項目だけを改善します。
- **直す：** 実際の失敗を eval ケースにする → `claude plugin eval` でベースラインを計測 → 一箇所だけ修正（`/claude-api prompt-audit`、`/skill-creator`）→ 同じ条件で再計測 → 前後のスコアを見て、残すか戻すかをユーザーが決めます。

## 使い方

| コマンド | 動作 |
|---|---|
| `/improve` | 作業済みのセッションではそのセッションの問題、新しいセッションでは直近 7 日の候補を一覧 |
| `/improve all` | 直近 7 日の候補を一覧 |
| `/improve <スキル名 または 不具合の説明>` | その一件だけを改善 |
| `/improve review` | 候補をテキストで一覧するだけ（定期実行向け） |

おすすめの運用：
- セッションをアーカイブする前に `/improve` を実行する。
- 毎週月曜の朝に Scheduled task で `/improve review` を実行する。

## インストール

```bash
cp -r skills/improve ~/.claude/skills/
```

必要なもの：
- Node.js 18 以上
- `claude plugin eval` が使える Claude Code
- `~/.claude` が git リポジトリであること。git がないと「最後の eval 後に変更されたスキル」と「未コミットの変更」を検出できず、revert もできません。

## ~/.claude の git 管理

ローカルのみで commit し、push はしません。`.gitignore` はホワイトリスト方式にして、自分で書いたファイルだけを追跡します。

```gitignore
/*
!/.gitignore
!/CLAUDE.md
!/settings.json
!/agents/
!/hooks/
!/rules/
!/skills/
/skills/*/evals/results/
```

セッション履歴（`projects/`）、認証情報、キャッシュ、eval の生の結果（会話の全文を含む）はリポジトリに入りません。

## 注意

- `claude plugin eval` は費用がかかります。スキルは実行前に必ず USD の予算を確認します。
- ネイティブ Windows ではサンドボックスがないため、eval で Bash/PowerShell を許可できません。コマンドを実行するスキルは WSL2 で評価してください。
- 修正の指摘を拾う正規表現（`scripts/suggest.mjs` の `CORRECTION`）は、ベトナム語と日本語の言い回しにしか対応していません。使う言語に合わせて追加してください。
