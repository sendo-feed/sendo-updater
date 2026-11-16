# sendo-updater

各自の Sendo の fork（sendo、sendo-reader、sendo-updater 自身）を、上流（`sendo-feed`）の更新に自動で追従させる
Cloudflare Worker。Cron Triggers で毎分、fork と上流の差分を調べ、遅れていれば merge-upstream で取り込む。

このファイルは AI エージェント（Claude Code、Codex など）共通の指示。開発は主に Claude Code で行い、Codex はおもにレビューに使う。

## 最初に読むもの

- 決定は sendo の [docs/decisions/deploy.md](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/deploy.md) の 7。
  このリポジトリには決定を置かない。決定を変えるときは、sendo に `decision(deploy): …` の PR を出す
- `README.md`：使う人向けの入れ方と、困ったときの直し方。動きを変えたら、ここも直す

## 開発コマンド

- `pnpm install`：依存を入れる。あわせて `worker-configuration.d.ts`（Workers の型）を生成する
- `pnpm check`：型チェック、lint、テストをまとめて実行する。変更したら、コミットの前に必ず通す
- `pnpm format`：整形して、直せる lint の指摘を直す（Biome）
- `wrangler.jsonc` を変えたら `pnpm cf-typegen` で型を作り直す

## ディレクトリ

- `src/index.ts`：Worker のすべて。`TARGETS`（対象の fork と順番）、判断（`updateForks`）、GitHub の API
- `test/index.test.ts`：GitHub の API を偽物に差し替えて、判断を確かめる（外へは通信しない）

## 言語

- 文書、コミットメッセージ、PR、レビューコメントは日本語で書く（一般に公開したら英語に切り替える）
- 識別子は英語

## コミットメッセージ

Conventional Commits を土台にする。全文は https://github.com/sendo-feed/.github/blob/main/CONTRIBUTING.md

- 形式：`<type>(<scope>): <件名>`。type は feat ／ fix ／ docs ／ decision ／ refactor ／ perf ／ test ／ build ／ ci ／ chore ／ revert
- 本文には「なぜ」を書く
- `main` に force push しない

## 守る規約

- 毎回 GitHub の今の状態から判断し、状態を持たない（KV や D1 を足さない）。取りこぼしても次の分に追いつけるようにする
- fork を書き換える操作は merge-upstream だけにする。force push や、fork だけのコミットを消す操作をしない
- 外から呼ばれる入口（`fetch` のハンドラー、`workers_dev`、プレビューの URL）を持たない
- トークン（`GITHUB_TOKEN`）を、ログ、エラー、URL に出さない
- トークンに要る権限（今は Contents と Workflows の書き込み）を増やすときは、README の入れ方と、sendo の決定を先に直す
- 外から来る値（`GITHUB_OWNER`）は、URL のパスに入れる前に形を確かめる
- `src/` では `node:*` を使わない（Workers で動くため。Biome で検査している）

## 変更の進め方

- すべての変更は下書きの PR で出す。`main` へは直接 push できない
- 下書きの PR には Codex のレビューを回し、終了の条件を満たすまで直す。Claude Code では `/review-loop` スキルがこれを回す
- マージは、人間にマージを指示されたときだけ行う。自分の判断ではマージしない
- 終了の条件、優先度の定義、指摘の扱いの全文は CONTRIBUTING.md の「レビューの進め方」にある

## Review guidelines

指摘には、必ず次の優先度のどれかを付ける。終了の条件はこの優先度で判定するので、ぶれないようにする。

| 優先度 | 意味 |
|---|---|
| P0 | fork の壊れ（上書き、コミットの消失）、セキュリティの穴、どの fork も追従しなくなる |
| P1 | 明らかなバグ、sendo の `docs/decisions/deploy.md` との食い違い、下の観点で挙げた規約の破れ |
| P2 | 直すべきだが今すぐでなくてよい（境界条件、テスト不足など） |
| P3 | 軽微なことや好み |

レビューは日本語で書く。整形と lint は Biome に任せる。次の観点を優先する。

1. **決定との食い違い**：sendo の `docs/decisions/deploy.md` の 7 と食い違う変更がないか
2. **fork を壊さないか**：取り込みで fork の `main` を上書きしたり、fork だけのコミットを消したりしないか。競合したら止まるか
3. **セキュリティ**：トークンがログやエラーに出ないか。外から呼べる入口ができていないか。外から来る値を確かめずに URL に入れていないか
4. **止まらないか**：1 つの fork の失敗で、ほかの fork が止まらないか。毎分のやり直しで、同じ失敗を積み上げないか
5. **順番**：sendo-reader が、sendo のデプロイより先に取り込まれることがないか
6. **テスト**：振る舞いを変える変更に、それを確かめるテストがあるか
7. **PR の書き方**：タイトルがコミットメッセージの形式か。説明に「なぜ」が書かれているか
