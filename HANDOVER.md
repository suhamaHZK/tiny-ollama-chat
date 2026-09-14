# Tiny Ollama Chat — 引継書（HANDOVER）

最終更新: 2026-09-14（Asia/Tokyo）

この文書は、Cursor アカウント移行後にプロジェクトを引き継ぐためのコンテキストです。  
**秘密情報（ホスト名・IP・ポート・SSHユーザー・Ollama URL・鍵・Webhook 等）は一切書いていません。** 接続先は引き継ぎ先アカウント側でユーザーから再度受け取ってください。

---

## 引き継ぎ先への依頼文（ユーザーが送る想定）

```
軽量なOllamaクライアント「Tiny Ollama Chat」の改修プロジェクトを引き継いでください。
引継書は、GitHubリポジトリ `suhamaHZK/tiny-ollama-chat` の `HANDOVER.md` を読んでください。
```

（リポジトリ名の大文字小文字は GitHub 上 `suhamaHZK/tiny-ollama-chat` です。）

---

## 1. プロジェクト概要

| 項目 | 内容 |
|------|------|
| 目的 | 上流の軽量 Ollama チャット UI を、**Raspberry Pi 2（ARMv7・Docker なし・単一バイナリ）**向けに自分用改修する |
| 上流 | [anishgowda21/tiny-ollama-chat](https://github.com/anishgowda21/tiny-ollama-chat) |
| 自分用 fork / 成果物置き場 | [suhamaHZK/tiny-ollama-chat](https://github.com/suhamaHZK/tiny-ollama-chat) |
| 構成 | Go サーバ（WebSocket + Ollama HTTP プロキシ）+ React/TS クライアント（`client/` → `static/`） |
| デプロイ形態 | `./tiny-ollama-chat` と隣の `static/`。例: `-ollama-url=http://<ollama-host>:11434 -port=8080` |

旧 Cursor アカウント側の「Tiny Ollama Chat」専用 Bot は**アカウント間で引っ越しできません**。会話メモリ・ローカル secrets・一時 SSH 鍵も新アカウントには自動では渡りません。このリポジトリと Releases、およびユーザーからの再入力が正です。

新アカウントでは **Cloud Agent が使える見込み**です。旧アカウントはクラウドエージェント契約なしだったため、実装は主にローカル（Grok Bot の共有 Linux）で行い、バイナリは **GitHub Releases** で配布していました。

---

## 2. いまの完成度（ユーザー視点）

**試用できる状態まで来ています。** 停止ボタンは当面不要で保留。

| 版 | 要点 |
|----|------|
| **v0.1.4-pi2**（最新） | Think 可否をモデル名ヒューリスティックから **`POST /api/show` の `capabilities` に `thinking` があるか**へ。Client 単位キャッシュ。show 失敗時は旧 `ThinkParam` にフォールバック。gpt-oss は対応時 `"medium"` |
| v0.1.3-pi2 | Think 中も**本文がライブストリーム表示**されるようクライアント修正（`currentResponse` + rAF、WS ハンドラ mount 一度だけ） |
| v0.1.2-pi2 | Think 付け分け・生成単一飛行・送信ロック・ストリーム中プレーンテキスト |
| v0.1.1 / v0.1.0 | 送信ロック解除、オフライン履歴閲覧、2通目 `convo_id` など |

Release 一覧: https://github.com/suhamaHZK/tiny-ollama-chat/releases  

Pi2 向けアセット（各タグ）: `tiny-ollama-chat`（ELF32 ARM）、`tiny-ollama-chat.xz`、`static-pi2.tar.gz`、`FIXES.md`  
**v0.1.4-pi2** バイナリ SHA256: `0e464e7df85859a55afc8160818c47b0a041b2a505c72e4bbb8702d745f92486`

詳細な修正メモはリポジトリ根の `FIXES.md`（Release 同梱版もあり）。

---

## 3. 技術メモ（ハマりどころ）

### 3.1 Think / 本文ストリーム

1. **OpenWebUI と Tiny の差**: 同一モデルで OpenWebUI は本文ストリームするのに Tiny だけ本文が一括、という症状があった。  
   - Ollama 生 NDJSON と Tiny の **WS 転送は content チャンクを出せていた** → サーバ／転送は概ね OK。  
   - 本命は **クライアント描画**（v0.1.3 で対処）。  
2. **Think を切る案はユーザー却下**。可能な限り Think 有効のまま本文もストリームしたい。  
3. **カスタム Gemma E4B 系**: show / tags で `capabilities: ["completion"]` のみのことがあり、`think:true` すると 400 `does not support thinking`。v0.1.4 の show 判定が正攻法。名前に `e4b` を含むヒューリスティックもフォールバックに残存。  
4. **gpt-oss**: boolean の think は無視され、`"low"|"medium"|"high"` が必要 → 対応時は `"medium"`。  
5. Ollama が「does not support thinking」を返したら **一度だけ think なしでリトライ**（`ChatStreamNoThink`）。

### 3.2 主なコード位置

| 領域 | パス |
|------|------|
| Think 解決（show + キャッシュ） | `server/internal/ollama/client.go`（`ShowModel`, `ResolveThink`） |
| 名前ヒューリスティック（フォールバック） | `server/internal/ollama/think.go`（`ThinkParam`, `IsThinkUnsupported`, `<think>` タグパーサ） |
| WS 生成・単一飛行・リトライ | `server/internal/ws/handler.go` |
| 本文ライブ表示 | `client` の `WebSocketProvider`, `ChatView`, `Message`（詳細は `FIXES.md`） |
| Pi ビルド | `./build-pi.sh` → `linux/arm` `GOARM=7` `CGO_ENABLED=0` |
| Win デバッグ用 | `./build-win.sh`（AgentSandbox 検証用。成果物ディレクトリは gitignore） |

テスト: `cd server && go test ./internal/ollama/...`

### 3.3 ソースと Release の関係（重要）

- バイナリ配布の正は **GitHub Releases**。  
- 旧作業では fork へのソース push が失敗しやすく、**しばらく Release だけが先に進んでいた**時期がある。  
- 本引継ぎでは:

- **`main`**: 少なくとも `HANDOVER.md` を配置（旧 main は README 中心だった）。
- **`source-v014` ブランチ**: v0.1.4 相当の**ソース一式**（`ResolveThink` 含む）を単一コミットで同期。フル履歴の force push は GitHub unpack 制限で失敗しやすいため、このブランチを正として clone してください。

```bash
git clone -b source-v014 https://github.com/suhamaHZK/tiny-ollama-chat.git
cd tiny-ollama-chat
cd server && go test ./internal/ollama/...
```

---

## 4. 宅内トポロジ（秘密なし・概念のみ）

| 役割 | 説明 |
|------|------|
| **本番 Ollama** | ゲーミング PC。使うときだけ起動。LAN 上の `:11434` |
| **検証用 Ollama** | Raspberry Pi 4。常時寄り・かなり遅い。Tiny からは HTTP の Ollama URL のみ（**Pi4 へ SSH しない**方針） |
| **Tiny 実行機** | Raspberry Pi 2（ARMv7）。単一バイナリ。配置例: ホーム配下の版ディレクトリ |
| **デバッグ用 VM** | AgentSandbox（VMware 上 Windows）。常時起動ではない。使うときはユーザーに起動依頼 |
| **置き換え対象** | OpenWebUI（Cloudflare Tunnel 公開）を Pi2 + Tiny で置き換える予定 |

旧アカウント作業時の一時措置:

- Pi2 へ **鍵認証の一時 SSH**（非標準ポート）を開き、配置・検証した。  
- 参謀方針: 作業後は **一時鍵を `authorized_keys` から外し、ポート転送も閉じる**。  
- **sshd 設定変更はユーザー明示依頼なしにしない。**  
- 接続情報・URL はチャット／メモリに残さず、セキュア入力のみ。

引き継ぎ先では、必要な接続情報をユーザーに**改めて**セキュアに渡してもらうこと。

---

## 5. 運用・約束事

- GitHub（旧）: `suhamaHZK`。破壊的 git 操作・無断 push は避ける。  
- 口調: ユーザー向けは **です・ます調**。  
- 成果物: GitHub Releases を優先。  
- **停止ボタン**: 当面不要で保留。  
- Think: 可能な限り有効のまま本文ストリームを維持。

---

## 6. 引き継いだ直後の推奨チェックリスト

1. このリポジトリを clone（Cloud Agent 可ならそちらでも可）。  
2. `HANDOVER.md` / `FIXES.md` / 最新 Release を読む。  
3. `cd server && go test ./internal/ollama/...`  
4. 必要なら `./build-pi.sh` で再ビルドし SHA を記録。  
5. ユーザーから **Ollama URL**（本番／Pi4 検証）をセキュアに受け取り、`/api/tags` と `/api/show` で疎通。  
6. Pi2 でバイナリ + `static/` を起動し、Think 対応モデルで Think＋本文ストリームを確認。  
7. 旧一時 SSH が残っていれば、合意のうえ **鍵削除・ポート閉鎖**。  
8. 保留: 停止ボタン、OpenWebUI 完全置き換えの本番切替。

---

## 7. 旧 Bot からの一文サマリ

> Pi2 向け Tiny Ollama Chat は v0.1.4 までで「Think は show の capabilities、本文はクライアントでライブ表示」まで到達。バイナリは Releases。秘密はリポジトリに無いので接続先はユーザーから再受領。Cloud Agent が使えるなら以降はクラウド実装＋ Release 更新が素直。一時 SSH は使い終わったら必ず閉じる。
