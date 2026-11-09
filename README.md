# tenkumai

天空米（八尾の山里の恵み）販売サイトのテスト版です。

- 公開URL（テスト）：https://foootn.github.io/tenkumai/
- 販売：富山商会 ／ 生産者：NPO法人 村の音 ／ 制作・運営：照櫟VorDX

## 構成

| ファイル | 内容 |
|---|---|
| `index.html` | 天空米（商品一覧・お買い物かご） |
| `about.html` / `activity.html` / `map.html` | 村について・体験・村の地図 |
| `checkout.html` | ご注文手続き |
| `kanri.html` | 富山商会・運営者用の管理ページ（合言葉で入る） |
| `config.js` | つなぎ先（Supabase Edge Functions のURL）とテスト環境かどうか |
| `server/` | Supabase Edge Functions のソース（`tenkumai-checkout` / `tenkumai-admin` / `tenkumai-webhook`）。秘密の値は含まない |

秘密のキーや合言葉は、Supabase の Edge Functions の Secrets にだけ置きます。このリポジトリには入れないでください。
