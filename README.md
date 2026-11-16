# sendo-updater

自分の Cloudflare にデプロイした Sendo の fork（sendo、sendo-reader）を、上流（`sendo-feed`）の更新に
自動で追従させる Cloudflare Worker。毎分、各自の fork と上流の差分を調べ、遅れていれば取り込む。
取り込んだ push で、各 fork の Workers Builds がデプロイする。上流の変更は、数分でデプロイまで届く。

使うかどうかは自由です。使わなければ、これまでどおり fork の画面の「Sync fork」で取り込みます
（sendo の README の「更新する」）。決定は sendo の
[docs/decisions/deploy.md](https://github.com/sendo-feed/sendo/blob/main/docs/decisions/deploy.md) の 7。

## 動き

- 対象は、`GITHUB_OWNER` の下の `sendo`、`sendo-reader`、`sendo-updater`（自分自身）の fork。持っていない fork は飛ばす。
  fork の名前は、上流と同じにしておく
- 毎分、fork の `main` に上流の `main` のコミットがいくつ足りないかを見る。足りなければ、merge-upstream
  （「Sync fork」と同じ API）で取り込む。fork だけのコミットは残り、競合すれば上書きせずに止まる
- sendo-reader は、sendo が上流に追いつき、sendo の `main` の先頭で「Workers Builds: sendo」が成功してから取り込む。
  API を足したときに、sendo-reader が先に出て、まだない API を呼ばないようにするため。sendo の fork を持っていなければ待たない
- 状態を持たない。毎回 GitHub の今の状態から判断するので、取りこぼしても次の分に追いつく
- 外から呼ばれる入口（URL）はない
- sendo-updater 自身も上流に追従し、Workers Builds がデプロイし直す

GitHub の API は、遅れていないとき毎分 3 回（毎時 180 回）呼びます。トークンの上限は毎時 5,000 回です。

## 入れ方

sendo（と sendo-reader）を、それぞれの README の手順で、fork と Workers Builds でデプロイしてあるものとします。

1. GitHub で `sendo-feed/sendo-updater` を fork する。sendo の fork と同じアカウント（か組織）に、名前を変えずに置く
2. [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) を、次のとおりに作る

   | 項目 | 値 |
   |---|---|
   | Resource owner | fork の持ち主 |
   | Expiration | 期限を決める（切れる前に GitHub からメールが来る） |
   | Repository access | Only select repositories で、`sendo`、`sendo-reader`、`sendo-updater` の fork だけ |
   | Repository permissions | **Contents** と **Workflows** を Read and write。ほかは足さない（Metadata の Read-only は自動で付く） |

   - Contents は取り込みに、Workflows は、上流がワークフロー（`.github/workflows/`）を変えた更新を取り込むのに要る
   - 組織の fork なら、組織の設定で fine-grained token を許しておく
3. Cloudflare の画面で、Workers & Pages →「作成」→「リポジトリをインポート」を選び、sendo-updater の fork を選ぶ。
   Cloudflare の GitHub App の「Repository access」に、この fork も入れる（入れ忘れると、push でビルドが始まらない）

   | 項目 | 値 |
   |---|---|
   | Worker の名前 | `sendo-updater`（変えない。`wrangler.jsonc` の `name` と違うとビルドが失敗する） |
   | ビルドのコマンド | 空のまま |
   | デプロイのコマンド | `pnpm run deploy` |

4. 1 回目のビルドは、秘密がなくて止まる。Worker の「設定」→「変数とシークレット」に、次の 2 つを入れる
   - `GITHUB_TOKEN`：型を「**シークレット**」にして、2 のトークン
   - `GITHUB_OWNER`：型を「変数」にして、fork の持ち主（GitHub のユーザー名か組織名）
5. Worker の「デプロイ」タブで、止まったビルドをやり直す
6. 確かめる：Worker の「ログ」（Observability）に、遅れている fork があるときだけ、fork ごとの結果
   （`merged upstream`、`waiting for …`）が出る。上流が進んでいれば、数分のうちに fork に
   「Merge branch 'sendo-feed:main' into main」のコミットが入る

トークンの期限が来たら、同じ設定で作り直し、画面の `GITHUB_TOKEN` を入れ替えます（デプロイし直す必要はありません）。

## 困ったら

Worker が失敗しても、知らせは来ません。上流が進んでいるのに fork に取り込まれなければ、Worker のログを見ます。

| ログ | 直し方 |
|---|---|
| `GITHUB_TOKEN is not set`、`GITHUB_OWNER is not …` | 入れ方の 4 |
| `no forks of sendo-feed repositories found under …` | `GITHUB_OWNER` が違うか、fork の名前を変えている |
| `failed (401)` | トークンの期限切れか、取り消し。作り直して入れ替える |
| merge-upstream が `failed (403)`、`failed (404)` | トークンの対象のリポジトリか、権限が足りない |
| merge-upstream が `failed (422)` で `workflow` とある | トークンに Workflows の書き込みがない |
| merge-upstream が `failed (409)` | 上流と競合した。fork で手で直す（fork だけのコミットを戻すか、競合を解く）。直すまで毎分失敗のログが出る |
| sendo-reader が `waiting for "Workers Builds: sendo" …` のまま | sendo のデプロイが失敗している。sendo のビルドのログを見て直す。上流の更新で、Cloudflare の画面での準備が要ることがある（sendo の README） |

## 止める

Cloudflare の画面で、sendo-updater の Worker を消します。fork はそのままで、また「Sync fork」で取り込めます。
トークンも要らなくなるので、GitHub で取り消してください。

## 開発

```sh
pnpm install      # あわせて worker-configuration.d.ts（Workers の型）を生成する
pnpm check        # 型チェック、lint、テスト
```

`wrangler.jsonc` を変えたら `pnpm cf-typegen` で型を作り直します。変更の進め方は [AGENTS.md](AGENTS.md)。
