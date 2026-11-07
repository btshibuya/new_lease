# プロジェクトの約束事

- 回答・コメント・コミットメッセージ・ドキュメントは必ず日本語で書くこと。
- 計算エンジン（app/src/engine）を変更したら `npm test` を実行し、すべて成功することを確認すること。
- 利用者入力を DOM に挿入するときは textContent を使い、innerHTML は使わないこと。外部スクリプト・CDN は使わないこと（CSP で禁止）。
- 会計方針の既定値を変える場合は、app/src/engine/policies.js の根拠（references）と docs/requirements.md 第11章を同時に更新すること。
