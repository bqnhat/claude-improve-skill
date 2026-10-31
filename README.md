# /improve

`~/.claude` のスキル・エージェント・hook・rule を、実際の失敗と評価スコアにもとづいて改善する Claude Code 用スキルです。

原則は Anthropic の記事 [Building agents: When to fold subagents into your main agent loop](https://claude.com/ja/resources/articles/building-agents-when-to-fold-subagents-into-your-main-agent-loop) にある「測る、一度に一つだけ変える、効いたものだけ残す」です。

## できること

- **探す：** セッション履歴から、出力を手直しした箇所、ツールエラー、hook ブロック、`claude plugin validate` のエラー、`/skill-doctor` が示す使われていないスキル、1.0 未満の eval、最後の eval 後に変更されたスキルなどを集め、優先度順に並べます。ユーザーがチェックした項目だけを改善します。手直しやツールエラーは「スキル実行後の数ターン以内」という時間窓で拾う手がかりで、原因の証明ではありません。収集に失敗した項目は `evidence:` に表示され、その場合「候補なし」を問題なしとは扱いません。
- **直す：** 実際の失敗を eval ケースにする → 変更前の状態を `scripts/snapshot.mjs` で保存 → `claude plugin eval --model <id>` でベースラインを計測し `scripts/record.mjs` で評価モデルとファイルの指紋を記録 → 一箇所だけ修正（`/claude-api prompt-audit`、`/skill-creator`）→ 同じ条件で再計測 → `scripts/compare.mjs` が比較可能と判定した場合だけ、前後のスコアを見て残すか戻すかをユーザーが決めます。戻すときは実験で変えた部分だけを差し戻します。

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
- `~/.claude` が git リポジトリであること。git がないと「最後の eval 後に変更されたスキル」と「未コミットの変更」を検出できません（差し戻しは `scripts/snapshot.mjs` が行うため git に依存しません）。

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
/skills/*/working/
```

セッション履歴（`projects/`）、認証情報、キャッシュ、eval の生の結果（会話の全文を含む）はリポジトリに入りません。

## 注意

- `claude plugin eval` は費用がかかります。スキルは実行前に必ず USD の予算を確認します。
- ネイティブ Windows ではサンドボックスがないため、eval で Bash/PowerShell を許可できません。コマンドの実行そのものを確かめるケースは `evals-wsl/` にあり、WSL2 上で `--eval-dir evals-wsl --allow-tools Bash` を付けて実行します。
- `claude plugin eval` は対象プラグインだけを読み込み、`settings.json`、hook、rule は読み込みません。これらの変更はスキルの eval スコアでは測れないため、hook やスクリプトは `node --test` で検証し、それ以外は「未計測」と報告します。
- スクリプトのテスト：リポジトリ直下で `node --test`
- 修正の指摘を拾う正規表現（`scripts/suggest.mjs` の `CORRECTION`）は、ベトナム語と日本語の言い回しにしか対応していません。使う言語に合わせて追加してください。
