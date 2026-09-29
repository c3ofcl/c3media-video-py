# 同梱フォントについて

このフォルダ内のフォントはすべて [Google Fonts](https://fonts.google.com/) 経由で配布されている
[SIL Open Font License 1.1](https://scripts.sil.org/OFL) のフォントで、商用・非商用問わず
再配布・改変が許可されています。各フォントのライセンス全文は同梱の `OFL-*.txt` を参照してください。

| ファイル | フォント名 | 由来 |
|---|---|---|
| NotoSansJP-Regular.ttf    | Noto Sans JP   | Google (Noto Project) |
| NotoSerifJP-Regular.ttf   | Noto Serif JP  | Google (Noto Project) |
| DelaGothicOne-Regular.ttf | Dela Gothic One | Google Fonts (og Sabana Type) |
| ZenMaruGothic-Bold.ttf    | Zen Maru Gothic | Google Fonts (Zen Foundry) |

プレビュー(ブラウザ)と書き出し(サーバー側のmoviepy/Pillow)の両方でこのフォルダの
同じファイルを直接参照することで、見た目が食い違わないようにしている。

Noto Sans/Serif JPは、本来はウェイト(太さ)を自由に変えられる可変フォント(variable font)
として配布されているが、環境によってはPillow/FreeTypeのバージョンが古く可変フォントの
読み込みに対応しておらず `OSError: cannot open resource` で失敗することがあったため、
Regularウェイト(標準の太さ)だけを固定で抜き出した通常の(静的な)フォントファイルに変換して
同梱している(fonttoolsの `varLib.instancer` を使用)。
